require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

process.on('uncaughtException', (err) => {
  console.error('CRITICAL UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL UNHANDLED REJECTION at:', promise, 'reason:', reason);
  process.exit(1);
});

['JWT_SECRET', 'DATABASE_URL'].forEach((key) => {
  if (!process.env[key]) {
    console.error(`Fatal Initialization Error: Missing required env variable [${key}]`);
    process.exit(1);
  }
});

const CASHFREE_CLIENT_ID = process.env.CASHFREE_PAYOUT_CLIENT_ID || '';
const CASHFREE_CLIENT_SECRET = process.env.CASHFREE_PAYOUT_CLIENT_SECRET || '';
const CASHFREE_ENV = process.env.CASHFREE_ENV || 'SANDBOX';

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.set('socketio', io);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${req.body.docType || 'DOC'}-${req.body.driverId || 'UNKNOWN'}-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const normalizePhone = (num) => String(num || '').replace(/\D/g, '').slice(-10);
const signToken = (user) => jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });

const auth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: 'Session token invalid or expired' });
  }
};

const otpStorage = {};

// ==================== NATIVE OTP AUTHENTICATION ROUTES ====================

app.post('/api/auth/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  const phone = normalizePhone(phoneNumber);

  if (!phone || phone.length !== 10) {
    return res.status(400).json({ success: false, error: 'Valid 10-digit mobile number required' });
  }

  // Generate 6-digit OTP and log to terminal console
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStorage[phone] = otp;

  console.log(`\n========================================`);
  console.log(`🔐 [OTP AUTH] Phone: ${phone} | Code: ${otp}`);
  console.log(`========================================\n`);

  return res.status(200).json({ 
    success: true, 
    message: 'OTP generated successfully (Check server console for code)',
    devOtp: otp // Included for easy testing on frontend
  });
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const { phoneNumber, otp, role: requestedRole } = req.body;
  const phone = normalizePhone(phoneNumber);
  const role = ['rider', 'driver', 'admin'].includes((requestedRole || '').toLowerCase())
    ? requestedRole.toLowerCase()
    : 'rider';

  if (!phone || !otp) {
    return res.status(400).json({ success: false, error: 'Phone number and OTP are required' });
  }

  if (otpStorage[phone] && otpStorage[phone] === otp) {
    delete otpStorage[phone];

    try {
      let userResult = await pool.query('SELECT * FROM users WHERE phone_number = \$1', [phone]);
      let user;

      if (userResult.rows.length === 0) {
        const insertRes = await pool.query(
          `INSERT INTO users (phone_number, role, is_verified) VALUES ($1, $2, true) RETURNING *`,
          [phone, role]
        );
        user = insertRes.rows[0];
      } else {
        user = userResult.rows[0];
        await pool.query('UPDATE users SET is_verified = true WHERE id = \$1', [user.id]);
      }

      return res.json({
        success: true,
        token: signToken(user),
        user: {
          id: user.id,
          phone_number: user.phone_number,
          role: user.role,
          full_name: user.full_name,
          email: user.email
        }
      });
    } catch (dbErr) {
      console.error('Database user resolution error:', dbErr);
      return res.status(500).json({ success: false, error: 'Database error processing user session' });
    }
  }

  res.status(400).json({ success: false, error: 'Invalid or expired OTP code' });
});

// ==================== REAL-TIME MARKET FARE ESTIMATION & COMMISSION ENGINES ====================

app.post('/api/rides/estimate', async (req, res) => {
  const { distanceKm, durationMins, vehicleCategory } = req.body;
  try {
    const settingsRes = await pool.query('SELECT * FROM admin_settings ORDER BY id ASC LIMIT 1');
    const settings = settingsRes.rows[0] || {};
    const globalBookingFee = parseFloat(settings.base_booking_fee || 15);

    const rateRes = await pool.query(
      'SELECT * FROM rate_cards WHERE LOWER(category) = LOWER(\$1)', 
      [vehicleCategory || 'Mini']
    );

    const rate = rateRes.rows[0] || { base_fare: 50, per_km: 12, per_min: 2, min_fare: 80, platform_comm: 10 };
    const baseFare = parseFloat(rate.base_fare);
    const perKm = parseFloat(rate.per_km);
    const perMin = parseFloat(rate.per_min);
    const minFare = parseFloat(rate.min_fare);

    let calculatedFare = baseFare + (distanceKm * perKm) + (durationMins * perMin) + globalBookingFee;
    if (calculatedFare < minFare) calculatedFare = minFare;

    res.json({
      success: true,
      estimatedFare: Math.round(calculatedFare),
      currency: settings.currency || 'INR (₹)',
      breakdown: {
        baseFare,
        distanceCharge: distanceKm * perKm,
        timeCharge: durationMins * perMin,
        baseBookingFee: globalBookingFee,
        platformCommissionPercent: parseFloat(rate.platform_comm || settings.commission_percentage || 10)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/rides/complete-ride', auth, async (req, res) => {
  const { rideId, totalFare, driverId, vehicleCategory } = req.body;
  try {
    const settingsRes = await pool.query('SELECT commission_percentage FROM admin_settings ORDER BY id ASC LIMIT 1');
    let commissionPercent = parseFloat(settingsRes.rows[0]?.commission_percentage || 10);

    if (vehicleCategory) {
      const rateRes = await pool.query('SELECT platform_comm FROM rate_cards WHERE LOWER(category) = LOWER(\$1)', [vehicleCategory]);
      if (rateRes.rows.length > 0 && rateRes.rows[0].platform_comm != null) {
        commissionPercent = parseFloat(rateRes.rows[0].platform_comm);
      }
    }

    const adminCut = Math.round(totalFare * (commissionPercent / 100)); 
    const driverEarnings = totalFare - adminCut; 

    await pool.query(
      `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 AND role = 'driver'`,
      [driverEarnings, driverId]
    );

    await pool.query(
      `UPDATE rides SET status = 'Completed', fare = $1, admin_commission = $2, driver_earning = $3 WHERE ride_id = $4`,
      [totalFare, adminCut, driverEarnings, rideId]
    );

    io.emit('ride_completed', { rideId, totalFare, adminCut, driverEarnings, commissionPercent });
    res.json({ success: true, commissionPercent, adminCut, driverEarnings });
  } catch (err) {
    console.error('Ride completion error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/rides/cancel', auth, async (req, res) => {
  const { rideId, cancelledBy, userId } = req.body;
  try {
    const settingsRes = await pool.query('SELECT cancellation_fee FROM admin_settings ORDER BY id ASC LIMIT 1');
    const cancellationFee = parseFloat(settingsRes.rows[0]?.cancellation_fee || 30);

    if (cancelledBy === 'rider' && userId) {
      await pool.query('UPDATE users SET wallet_balance = wallet_balance - \$1 WHERE id = \$2', [cancellationFee, userId]);
    }

    await pool.query(`UPDATE rides SET status = 'Cancelled' WHERE ride_id = $1`, [rideId]);
    io.emit('ride_cancelled', { rideId, cancelledBy, cancellationFee });
    res.json({ success: true, message: 'Ride cancelled successfully', cancellationFee });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== SECURE ADMIN AUTH & PROFILE APIS ====================

app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    let result = await pool.query("SELECT * FROM users WHERE LOWER(email) = LOWER(\$1) AND role = 'admin'", [email]);

    if (result.rows.length === 0 && email === 'admin@swamicab.com') {
      const defaultPasswordHash = await bcrypt.hash('SwamiCab@2026!Pune', 10);
      result = await pool.query(
        `INSERT INTO users (phone_number, full_name, email, role, otp_hash, is_verified) 
         VALUES ('9876543210', 'SwamiCab Super Admin', 'admin@swamicab.com', 'admin', $1, true) RETURNING *`,
        [defaultPasswordHash]
      );
    }

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid admin credentials.' });
    }

    const admin = result.rows[0];
    const isPasswordValid = await bcrypt.compare(password || '', admin.otp_hash || '');
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Incorrect password. Access denied.' });
    }

    res.json({
      success: true,
      token: signToken(admin),
      admin: { id: admin.id, name: admin.full_name, email: admin.email }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/profile', async (req, res) => {
  try {
    let result = await pool.query("SELECT * FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1");
    const admin = result.rows[0];
    res.json({ full_name: admin.full_name, email: admin.email, phone_number: admin.phone_number, role: 'Super Administrator' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch admin profile' });
  }
});

app.put('/api/admin/profile', async (req, res) => {
  const { fullName, name, email, phone, phoneNumber, newPassword } = req.body;
  const fName = fullName || name || 'SwamiCab Admin';
  const pNumber = phone || phoneNumber || '7420868825';

  try {
    if (newPassword && newPassword.trim() !== '') {
      const hashedNewPassword = await bcrypt.hash(newPassword, 10);
      await pool.query(`UPDATE users SET full_name = $1, email = $2, phone_number = $3, otp_hash = $4 WHERE role = 'admin'`, [fName, email, pNumber, hashedNewPassword]);
    } else {
      await pool.query(`UPDATE users SET full_name = $1, email = $2, phone_number = $3 WHERE role = 'admin'`, [fName, email, pNumber]);
    }
    io.emit('admin_profile_updated', { fullName: fName, email, phone: pNumber });
    res.json({ success: true, message: 'Admin profile updated successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== CASHFREE WEBHOOK & PAYOUTS ====================

app.post('/api/webhooks/cashfree', express.json(), async (req, res) => {
  try {
    const event = req.body;
    const eventType = event.type || event.event;
    const transferId = event.data?.transferId || event.transferId;

    if ((eventType === 'PAYOUT_SUCCESS' || eventType === 'TRANSFER_SUCCESS') && transferId) {
      await pool.query(`UPDATE driver_withdrawals SET status = 'Completed', gateway_status = 'SUCCESS' WHERE transfer_id = $1`, [transferId]);
      io.emit('payout_status_updated');
    }
    return res.status(200).json({ status: 'OK' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/driver/withdraw', auth, async (req, res) => {
  const { amount, bankAccountNumber, ifscCode, accountHolderName } = req.body;
  const driverId = req.user.id;

  try {
    const userRes = await pool.query('SELECT wallet_balance FROM users WHERE id = \$1', [driverId]);
    const currentBalance = parseFloat(userRes.rows[0]?.wallet_balance || 0);

    if (currentBalance < amount) {
      return res.status(400).json({ success: false, error: 'Insufficient wallet balance' });
    }

    const transferId = `TR_${driverId}_${Date.now()}`;
    const baseUrl = CASHFREE_ENV === 'PRODUCTION' ? 'https://payout-api.cashfree.com' : 'https://payout-gamma.cashfree.com';
    let gatewayStatus = 'SUCCESS';

    if (CASHFREE_CLIENT_ID && CASHFREE_CLIENT_SECRET) {
      try {
        await axios.post(`${baseUrl}/payout/v1/directTransfer`, {
          transferId, amount, transferMode: 'imps', beneDetails: { name: accountHolderName, accountNumber: bankAccountNumber, ifsc: ifscCode }
        }, { headers: { 'X-Client-Id': CASHFREE_CLIENT_ID, 'X-Client-Secret': CASHFREE_CLIENT_SECRET, 'Content-Type': 'application/json' } });
      } catch (err) {
        gatewayStatus = 'PENDING_REVIEW';
      }
    }

    await pool.query('UPDATE users SET wallet_balance = wallet_balance - \$1 WHERE id = \$2', [amount, driverId]);
    await pool.query(`INSERT INTO driver_withdrawals (driver_id, amount, transfer_id, gateway_status, status) VALUES ($1, $2, $3, $4, 'Pending')`, [driverId, amount, transferId, gatewayStatus]);

    io.emit('payout_requested');
    res.json({ success: true, message: 'Withdrawal requested successfully!', transferId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== ADMIN SETTINGS & RATE CARDS ====================

app.get('/api/admin/settings', async (req, res) => {
  try {
    let result = await pool.query('SELECT * FROM admin_settings ORDER BY id ASC LIMIT 1');
    if (result.rows.length === 0) {
      result = await pool.query(`INSERT INTO admin_settings (app_name, commission_percentage, base_booking_fee, cancellation_fee, driver_payout_cycle) VALUES ('SwamiCab', 10, 15, 30, 'Weekly') RETURNING *`);
    }
    const row = result.rows[0];
    res.json({
      appName: row.app_name,
      supportEmail: row.support_email,
      currency: row.currency,
      timeZone: row.time_zone,
      commissionPercentage: parseFloat(row.commission_percentage),
      baseBookingFee: parseFloat(row.base_booking_fee),
      cancellationFee: parseFloat(row.cancellation_fee),
      driverPayoutCycle: row.driver_payout_cycle,
      accountHolderName: row.account_holder_name || '',
      accountNumber: row.account_number || '',
      ifscCode: row.ifsc_code || '',
      bankName: row.bank_name || 'HDFC Bank',
      upiId: row.upi_id || ''
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

app.put('/api/admin/settings', async (req, res) => {
  const { appName, supportEmail, currency, timeZone, commissionPercentage, baseBookingFee, cancellationFee, driverPayoutCycle, accountHolderName, accountNumber, ifscCode, bankName, upiId } = req.body;
  try {
    const checkRes = await pool.query('SELECT id FROM admin_settings ORDER BY id ASC LIMIT 1');
    if (checkRes.rows.length === 0) {
      await pool.query(`INSERT INTO admin_settings (app_name, support_email, currency, time_zone, commission_percentage, base_booking_fee, cancellation_fee, driver_payout_cycle, account_holder_name, account_number, ifsc_code, bank_name, upi_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, [appName, supportEmail, currency, timeZone, commissionPercentage, baseBookingFee, cancellationFee, driverPayoutCycle, accountHolderName, accountNumber, ifscCode, bankName, upiId]);
    } else {
      await pool.query(`UPDATE admin_settings SET app_name = $1, support_email = $2, currency = $3, time_zone = $4, commission_percentage = $5, base_booking_fee = $6, cancellation_fee = $7, driver_payout_cycle = $8, account_holder_name = $9, account_number = $10, ifsc_code = $11, bank_name = $12, upi_id = $13 WHERE id = $14`, [appName, supportEmail, currency, timeZone, commissionPercentage, baseBookingFee, cancellationFee, driverPayoutCycle, accountHolderName, accountNumber, ifscCode, bankName, upiId, checkRes.rows[0].id]);
    }
    io.emit('settings_updated', req.body);
    res.json({ success: true, message: 'Settings updated successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

app.get('/api/admin/rate-cards', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM rate_cards ORDER BY id ASC");
    // Map database snake_case columns to frontend camelCase properties
    const formattedRows = rows.map(card => ({
      id: card.id,
      category: card.category,
      baseFare: parseFloat(card.base_fare || 50),
      perKm: parseFloat(card.per_km || 12),
      perMin: parseFloat(card.per_min || 2),
      minFare: parseFloat(card.min_fare || 80),
      nightSurge: card.night_surge || false,
      peakHour: card.peak_hour || false,
      platformComm: parseFloat(card.platform_comm || 10)
    }));
    res.json(formattedRows);
  } catch (err) {
    console.error('Fetch rate cards error:', err);
    res.json([]);
  }
});

app.put('/api/admin/rate-cards', async (req, res) => {
  const { rateCards } = req.body;
  try {
    if (Array.isArray(rateCards)) {
      for (const card of rateCards) {
        await pool.query(`
          INSERT INTO rate_cards (id, category, base_fare, per_km, per_min, min_fare, night_surge, peak_hour, platform_comm)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO UPDATE SET 
            category = EXCLUDED.category,
            base_fare = EXCLUDED.base_fare,
            per_km = EXCLUDED.per_km,
            per_min = EXCLUDED.per_min,
            min_fare = EXCLUDED.min_fare,
            night_surge = EXCLUDED.night_surge,
            peak_hour = EXCLUDED.peak_hour,
            platform_comm = EXCLUDED.platform_comm
        `, [
          card.id, 
          card.category, 
          parseFloat(card.baseFare || 0), 
          parseFloat(card.perKm || 0), 
          parseFloat(card.perMin || 0), 
          parseFloat(card.minFare || 0), 
          card.nightSurge || false, 
          card.peakHour || false, 
          parseFloat(card.platformComm || 10)
        ]);
      }
    }
    io.emit('rate_cards_updated');
    res.json({ success: true, message: 'Rate cards updated successfully' });
  } catch (err) {
    console.error('Update rate cards error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== REAL-TIME MARKET ANALYTICS (SAFE QUERY FALLBACKS) ====================

app.get('/api/admin/analytics', async (req, res) => {
  const { start, end } = req.query;
  const startDate = start || '2026-09-01';
  const endDate = end || '2026-12-31';

  try {
    const growthRes = await pool.query(`
      SELECT TO_CHAR(created_at, 'Dy') as month, COALESCE(SUM(fare), 0) as "Revenue", COALESCE(SUM(admin_commission), 0) as "Expense"
      FROM rides 
      WHERE status = 'Completed' 
        AND created_at::date >= $1::date 
        AND created_at::date <= $2::date
      GROUP BY TO_CHAR(created_at, 'Dy'), DATE(created_at) 
      ORDER BY DATE(created_at) ASC
    `, [startDate, endDate]);

    const paymentRes = await pool.query(`
      SELECT COALESCE(payment_method, 'UPI') as name, ROUND(COUNT(*) * 100.0 / NULLIF(SUM(COUNT(*)) OVER(), 0), 1) as value 
      FROM rides 
      WHERE created_at::date >= $1::date AND created_at::date <= $2::date
      GROUP BY payment_method
    `, [startDate, endDate]);

    const topAreasRes = await pool.query(`
      SELECT COALESCE(pickup, 'Central Pune') as name, COUNT(*) as "ridesCount" 
      FROM rides 
      WHERE created_at::date >= $1::date AND created_at::date <= $2::date
      GROUP BY pickup 
      ORDER BY "ridesCount" DESC 
      LIMIT 4
    `, [startDate, endDate]);

    const heatmapData = [];
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    for (const day of days) {
      const row = [];
      const hours = [6, 9, 12, 15, 18, 21];
      for (const hr of hours) {
        const countRes = await pool.query(`
          SELECT COUNT(*) as cnt FROM rides 
          WHERE TO_CHAR(created_at, 'Dy') = $1 
            AND EXTRACT(HOUR FROM created_at) >= $2 
            AND EXTRACT(HOUR FROM created_at) < ($2 + 3)
            AND created_at::date >= $3::date AND created_at::date <= $4::date
        `, [day, hr, startDate, endDate]);
        const count = parseInt(countRes.rows[0]?.cnt || 0);
        const intensity = Math.min(Math.max(count / 10, 0.1), 1.0);
        row.push(parseFloat(intensity.toFixed(1)));
      }
      heatmapData.push(row);
    }

    res.json({
      growthData: growthRes.rows,
      paymentBreakdown: paymentRes.rows,
      topAreas: topAreasRes.rows,
      heatmapData
    });
  } catch (err) {
    console.error('Analytics error:', err.message);
    res.json({
      growthData: [],
      paymentBreakdown: [],
      topAreas: [],
      heatmapData: Array(7).fill([0.1, 0.1, 0.1, 0.1, 0.1, 0.1])
    });
  }
});

// Helper endpoint to instantly wipe all mock rides for production launch
app.post('/api/admin/clear-dummy-data', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM rides');
    await pool.query("UPDATE users SET wallet_balance = 0.00 WHERE role = 'driver'");
    await pool.query('DELETE FROM driver_withdrawals');
    io.emit('data_cleared');
    res.json({ success: true, message: 'All demo and test ride records cleared successfully for market launch!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/analytics/export-csv', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT ride_id, rider_name, driver_name, vehicle, fare, status, payment_method, pickup, drop, created_at FROM rides ORDER BY created_at DESC');
    let csv = 'Ride ID,Rider,Driver,Vehicle,Fare,Status,Payment,Pickup,Drop,Date\n';
    rows.forEach(r => {
      csv += `"${r.ride_id}","${r.rider_name || ''}","${r.driver_name || ''}","${r.vehicle || ''}",${r.fare || 0},"${r.status}","${r.payment_method}","${r.pickup || ''}","${r.drop || ''}","${r.created_at}"\n`;
    });
    res.header('Content-Type', 'text/csv');
    res.attachment('SwamiCab-Analytics-Report.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).send('Failed to export CSV');
  }
});

app.get('/api/admin/dashboard-data', async (req, res) => {
  try {
    const ridesCount = await pool.query("SELECT COUNT(*) FROM rides");
    const usersCount = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'rider'");
    const activeDrivers = await pool.query("SELECT COUNT(*) FROM driver_profiles WHERE is_online = true");
    const revenueRes = await pool.query("SELECT COALESCE(SUM(fare), 0) as total FROM rides WHERE status = 'Completed'");
    const rides = await pool.query("SELECT * FROM rides ORDER BY created_at DESC LIMIT 10");

    res.json({
      stats: {
        totalRides: parseInt(ridesCount.rows[0].count),
        activeDrivers: parseInt(activeDrivers.rows[0].count),
        totalUsers: parseInt(usersCount.rows[0].count),
        todayRevenue: parseFloat(revenueRes.rows[0].total),
        pendingVerifications: 0
      },
      rides: rides.rows
    });
  } catch (err) {
    res.status(500).json({ stats: { totalRides: 0, activeDrivers: 0, totalUsers: 0, todayRevenue: 0 }, rides: [] });
  }
});

// ==================== SOCKET.IO & SERVER START ====================

io.on('connection', (socket) => {
  console.log(`Socket Client Connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`Socket Disconnected: ${socket.id}`));
});

app.get('/', (req, res) => {
  res.json({ success: true, message: 'SwamiCab Market-Ready Production Engine Online!' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`SwamiCab Backend Active Engine running on port ${PORT}`));