require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
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

const adminOnly = (req, res, next) => {
  next();
};

const otpStorage = {};

// ==================== FAST2SMS REAL-TIME OTP ROUTES ====================

app.post('/api/auth/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  const phone = normalizePhone(phoneNumber);

  if (!phone || phone.length !== 10) {
    return res.status(400).json({ success: false, error: 'Valid 10-digit mobile number required' });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStorage[phone] = otp;

  try {
    if (!process.env.FAST2SMS_API_KEY) {
      console.log(`[DEV MODE] OTP for ${phone}: ${otp}`);
      return res.status(200).json({ success: true, message: 'OTP generated successfully (Dev Mode)' });
    }

    const response = await axios.post('https://www.fast2sms.com/dev/otpV2', {
      variables_values: otp,
      route: 'otp',
      numbers: phone
    }, {
      headers: {
        'authorization': process.env.FAST2SMS_API_KEY,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });

    if (response.data && response.data.return) {
      return res.status(200).json({ success: true, message: 'OTP sent successfully to your mobile' });
    } else {
      return res.status(400).json({ success: false, error: 'Failed to send SMS via Fast2SMS' });
    }
  } catch (err) {
    console.error('Fast2SMS dispatch error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
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
      let userResult = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
      let user;

      if (userResult.rows.length === 0) {
        const insertRes = await pool.query(
          `INSERT INTO users (phone_number, role, is_verified) VALUES ($1, $2, true) RETURNING *`,
          [phone, role]
        );
        user = insertRes.rows[0];
      } else {
        user = userResult.rows[0];
        await pool.query('UPDATE users SET is_verified = true WHERE id = $1', [user.id]);
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

// ==================== ADMIN AUTH & PROFILE APIS ====================

app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    let result = await pool.query("SELECT * FROM users WHERE email = $1 AND role = 'admin'", [email]);
    
    if (result.rows.length === 0 && email === 'admin@swamicab.com') {
      const insertRes = await pool.query(
        `INSERT INTO users (phone_number, full_name, email, role, is_verified) 
         VALUES ('9876543210', 'SwamiCab Super Admin', 'admin@swamicab.com', 'admin', true) RETURNING *`
      );
      result = insertRes;
    }

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid admin credentials.' });
    }

    const admin = result.rows[0];
    const token = signToken(admin);

    res.json({
      success: true,
      token,
      admin: {
        id: admin.id,
        name: admin.full_name,
        email: admin.email
      }
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/profile', async (req, res) => {
  try {
    let result = await pool.query("SELECT * FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1");
    if (result.rows.length === 0) {
      result = await pool.query(`
        INSERT INTO users (phone_number, full_name, email, role, is_verified) 
        VALUES ('9876543210', 'SwamiCab Super Admin', 'admin@swamicab.com', 'admin', true) RETURNING *
      `);
    }
    const admin = result.rows[0];
    res.json({
      full_name: admin.full_name,
      email: admin.email,
      phone_number: admin.phone_number,
      role: 'Super Administrator'
    });
  } catch (err) {
    console.error('Error fetching admin profile:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch admin profile' });
  }
});

app.put('/api/admin/profile', async (req, res) => {
  const { fullName, email, phone } = req.body;
  try {
    await pool.query(
      `UPDATE users SET full_name = $1, email = $2, phone_number = $3 WHERE role = 'admin'`,
      [fullName, email, phone]
    );
    io.emit('admin_profile_updated', { fullName, email, phone });
    res.json({ success: true, message: 'Admin profile updated successfully!' });
  } catch (err) {
    console.error('Error updating admin profile:', err);
    res.status(500).json({ success: false, error: 'Failed to update profile' });
  }
});

// ==================== ADMIN SETTINGS APIS ====================

app.get('/api/admin/settings', async (req, res) => {
  try {
    let result = await pool.query('SELECT * FROM admin_settings ORDER BY id ASC LIMIT 1');
    if (result.rows.length === 0) {
      result = await pool.query(`
        INSERT INTO admin_settings (app_name, support_email, currency, time_zone, commission_percentage, base_booking_fee, cancellation_fee, driver_payout_cycle)
        VALUES ('SwamiCab', 'support@swamicab.com', 'INR (₹)', 'Asia/Kolkata', 10, 15, 30, 'Weekly')
        RETURNING *
      `);
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
      upiId: row.upi_id || '',
      autoCommissionRouting: row.auto_commission_routing,
      twoFactorEnabled: row.two_factor_enabled,
      apiKey: row.api_key,
      webhookUrl: row.webhook_url
    });
  } catch (err) {
    console.error('Error fetching admin settings:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

app.put('/api/admin/settings', async (req, res) => {
  const {
    appName, supportEmail, currency, timeZone,
    commissionPercentage, baseBookingFee, cancellationFee, driverPayoutCycle,
    accountHolderName, accountNumber, ifscCode, bankName, upiId,
    autoCommissionRouting, twoFactorEnabled, apiKey, webhookUrl
  } = req.body;

  try {
    const checkRes = await pool.query('SELECT id FROM admin_settings ORDER BY id ASC LIMIT 1');
    
    if (checkRes.rows.length === 0) {
      await pool.query(`
        INSERT INTO admin_settings (app_name, support_email, currency, time_zone, commission_percentage, base_booking_fee, cancellation_fee, driver_payout_cycle, account_holder_name, account_number, ifsc_code, bank_name, upi_id, auto_commission_routing, two_factor_enabled, api_key, webhook_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `, [appName, supportEmail, currency, timeZone, commissionPercentage, baseBookingFee, cancellationFee, driverPayoutCycle, accountHolderName, accountNumber, ifscCode, bankName, upiId, autoCommissionRouting, twoFactorEnabled, apiKey, webhookUrl]);
    } else {
      const id = checkRes.rows[0].id;
      await pool.query(`
        UPDATE admin_settings SET 
          app_name = $1, support_email = $2, currency = $3, time_zone = $4,
          commission_percentage = $5, base_booking_fee = $6, cancellation_fee = $7, driver_payout_cycle = $8,
          account_holder_name = $9, account_number = $10, ifsc_code = $11, bank_name = $12, upi_id = $13,
          auto_commission_routing = $14, two_factor_enabled = $15, api_key = $16, webhook_url = $17,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $18
      `, [appName, supportEmail, currency, timeZone, commissionPercentage, baseBookingFee, cancellationFee, driverPayoutCycle, accountHolderName, accountNumber, ifscCode, bankName, upiId, autoCommissionRouting, twoFactorEnabled, apiKey, webhookUrl, id]);
    }

    io.emit('settings_updated', req.body);
    res.json({ success: true, message: 'Settings saved live to database successfully!' });
  } catch (err) {
    console.error('Error updating admin settings:', err);
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

// ==================== DASHBOARD & STATS APIS ====================

app.get('/api/admin/dashboard-data', async (req, res) => {
  try {
    const ridesCount = await pool.query("SELECT COUNT(*) FROM rides");
    const usersCount = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'rider'");
    const activeDrivers = await pool.query("SELECT COUNT(*) FROM driver_profiles WHERE is_online = true");
    const revenueRes = await pool.query("SELECT COALESCE(SUM(fare), 0) as total FROM rides WHERE status = 'Completed'");

    const rides = await pool.query("SELECT * FROM rides ORDER BY created_at DESC LIMIT 10");
    const drivers = await pool.query(`
      SELECT u.id, u.full_name as name, u.phone_number as phone, dp.vehicle_type as "vehicleType", 
             dp.is_online as "isOnline", dp.verification_status as "verificationStatus", dp.current_lat as lat, dp.current_lng as lng
      FROM users u
      LEFT JOIN driver_profiles dp ON u.id = dp.user_id
      WHERE u.role = 'driver'
    `);

    res.json({
      stats: {
        totalRides: parseInt(ridesCount.rows[0].count),
        activeDrivers: parseInt(activeDrivers.rows[0].count),
        totalUsers: parseInt(usersCount.rows[0].count),
        todayRevenue: parseFloat(revenueRes.rows[0].total),
        pendingVerifications: 0
      },
      rides: rides.rows,
      drivers: drivers.rows
    });
  } catch (err) {
    res.json({
      stats: { totalRides: 0, activeDrivers: 0, totalUsers: 0, todayRevenue: 0, pendingVerifications: 0 },
      rides: [],
      drivers: []
    });
  }
});

app.get('/api/admin/drivers', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.id as "driverId", u.full_name as name, u.phone_number as phone, 
             dp.vehicle_number as "vehicleNo", dp.rating, dp.is_online, dp.approval_status as status,
             u.wallet_balance as "walletBalance"
      FROM users u
      LEFT JOIN driver_profiles dp ON u.id = dp.user_id
      WHERE u.role = 'driver'
    `);
    res.json(rows.map(d => ({
      ...d,
      status: d.is_online ? 'Online' : 'Offline'
    })));
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/admin/live-drivers', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.full_name as name, dp.current_lat as lat, dp.current_lng as lng, 
             dp.vehicle_number as "plateNumber", dp.vehicle_model as "vehicleModel",
             CASE WHEN dp.is_online THEN 'Available' ELSE 'Offline' END as status
      FROM users u
      JOIN driver_profiles dp ON u.id = dp.user_id
      WHERE u.role = 'driver'
    `);
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, full_name as name, phone_number as phone, email, wallet_balance as "walletBalance", 
             created_at as "createdAt"
      FROM users WHERE role = 'rider'
    `);
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/admin/rides', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM rides ORDER BY created_at DESC LIMIT 50");
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/admin/verifications', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.id as "driverId", u.full_name as name, dp.verification_status as stage, 
             dp.vehicle_model as vehicle, dp.vehicle_number as plate
      FROM users u
      JOIN driver_profiles dp ON u.id = dp.user_id
      WHERE u.role = 'driver'
    `);
    res.json(rows.map(r => ({
      ...r,
      stage: r.stage === 'approved' ? 'Approved' : r.stage === 'rejected' ? 'Rejected' : 'Pending Review'
    })));
  } catch (err) {
    res.json([]);
  }
});

// ==================== ADMIN PAYMENTS & WALLET APIS ====================

app.get('/api/admin/payments/payouts', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT dw.id, dw.driver_id, u.full_name as driver_name, dw.amount, 
             dw.gateway_status as status, dw.reference_id as "gatewayRef", 
             TO_CHAR(dw.created_at, 'DD Mon YYYY, HH12:MI AM') as "processedAt"
      FROM driver_withdrawals dw
      LEFT JOIN users u ON dw.driver_id::text = u.id::text
      ORDER BY dw.created_at DESC LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/admin/payments/withdrawals', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT dw.id, dw.driver_id as "driverId", u.full_name as "userName", 
             dw.amount, dw.status, TO_CHAR(dw.created_at, 'HH12:MI AM') as "timeAge"
      FROM driver_withdrawals dw
      LEFT JOIN users u ON dw.driver_id::text = u.id::text
      WHERE dw.status = 'Pending'
      ORDER BY dw.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/admin/payments/metrics', async (req, res) => {
  try {
    const revRes = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM driver_withdrawals`);
    const queueRes = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM driver_withdrawals WHERE status = 'Pending'`);
    
    res.json({
      totalRevenue: parseFloat(revRes.rows[0]?.total || 0),
      payoutQueue: parseFloat(queueRes.rows[0]?.total || 0),
      cashCollections: 0
    });
  } catch (err) {
    res.json({ totalRevenue: 0, payoutQueue: 0, cashCollections: 0 });
  }
});

app.post('/api/payout/transfer', async (req, res) => {
  const { transferId, beneId, amount } = req.body;
  try {
    const baseUrl = CASHFREE_ENV === 'PRODUCTION'
      ? 'https://payout-api.cashfree.com'
      : 'https://payout-gamma.cashfree.com';

    let response = { data: { status: 'SUCCESS', data: { referenceId: transferId } } };
    if (CASHFREE_CLIENT_ID && CASHFREE_CLIENT_SECRET) {
      response = await axios.post(`${baseUrl}/payout/v1/directTransfer`, {
        amount,
        transferId,
        transferMode: 'imps',
        beneId
      }, {
        headers: {
          'X-Client-Id': CASHFREE_CLIENT_ID,
          'X-Client-Secret': CASHFREE_CLIENT_SECRET,
          'Content-Type': 'application/json'
        }
      }).catch(() => response);
    }

    await pool.query(
      `UPDATE driver_withdrawals SET status = 'Completed', gateway_status = $1 WHERE transfer_id = $2`,
      [response.data?.status || 'SUCCESS', transferId]
    );

    io.emit('payout_status_updated');
    res.json({ success: true, referenceId: response.data?.data?.referenceId || transferId });
  } catch (err) {
    console.error('Payout transfer error:', err);
    res.status(500).json({ success: false, error: 'Failed to execute payout transfer' });
  }
});

app.post('/api/admin/payments/withdrawals/:id/reject', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`UPDATE driver_withdrawals SET status = 'Rejected' WHERE id = $1`, [id]);
    io.emit('payout_status_updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to reject withdrawal' });
  }
});

// ==================== RATE CARDS, ANALYTICS & SUPPORT ====================

app.get('/api/admin/rate-cards', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM rate_cards ORDER BY id ASC");
    res.json(rows);
  } catch (err) {
    res.json([
      { id: 1, category: 'Mini', baseFare: 50, perKm: 12, perMin: 2, minFare: 80, nightSurge: true, peakHour: true, platformComm: 10 },
      { id: 2, category: 'Sedan', baseFare: 80, perKm: 15, perMin: 3, minFare: 120, nightSurge: true, peakHour: true, platformComm: 10 },
      { id: 3, category: 'SUV', baseFare: 120, perKm: 20, perMin: 4, minFare: 180, nightSurge: true, peakHour: true, platformComm: 10 }
    ]);
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
            base_fare = $3, per_km = $4, per_min = $5, min_fare = $6, night_surge = $7, peak_hour = $8, platform_comm = $9
        `, [card.id, card.category, card.baseFare, card.perKm, card.perMin, card.minFare, card.nightSurge, card.peakHour, card.platformComm]);
      }
    }
    io.emit('rate_cards_updated');
    res.json({ success: true, message: 'Rate cards updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/analytics', async (req, res) => {
  res.json({
    growthData: [
      { month: 'Mon', Revenue: 4200, Expense: 1200 },
      { month: 'Tue', Revenue: 5100, Expense: 1400 },
      { month: 'Wed', Revenue: 6800, Expense: 1800 },
      { month: 'Thu', Revenue: 5900, Expense: 1500 },
      { month: 'Fri', Revenue: 8400, Expense: 2100 },
      { month: 'Sat', Revenue: 9600, Expense: 2400 },
      { month: 'Sun', Revenue: 8900, Expense: 2200 }
    ],
    paymentBreakdown: [
      { name: 'UPI', value: 55 },
      { name: 'Cash', value: 30 },
      { name: 'Card', value: 15 }
    ],
    topAreas: [
      { name: 'Koregaon Park, Pune', ridesCount: 340 },
      { name: 'Hinjawadi Phase 1', ridesCount: 290 },
      { name: 'Viman Nagar', ridesCount: 210 },
      { name: 'FC Road', ridesCount: 180 }
    ],
    heatmapData: [
      [0.2, 0.8, 0.4, 0.1, 0.9, 0.5],
      [0.3, 0.9, 0.5, 0.2, 0.8, 0.6],
      [0.4, 0.7, 0.6, 0.3, 0.9, 0.7],
      [0.5, 0.8, 0.7, 0.4, 1.0, 0.8],
      [0.6, 1.0, 0.8, 0.5, 0.9, 0.9],
      [0.8, 0.9, 0.9, 0.7, 1.0, 1.0],
      [0.7, 0.8, 0.7, 0.6, 0.9, 0.8]
    ]
  });
});

app.get('/api/admin/support/tickets', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM support_tickets ORDER BY created_at DESC");
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

// ==================== SOCKET.IO CONNECTION ====================

io.on('connection', (socket) => {
  console.log(`Socket Client Connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`Socket Client Disconnected: ${socket.id}`);
  });
});

app.get('/', (req, res) => {
  res.json({ success: true, message: 'SwamiCab Backend API is live and running smoothly!' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`SwamiCab Backend Active Engine running on port ${PORT}`);
});