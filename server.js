require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Verify Essential Environment Variables
['JWT_SECRET', 'FAST2SMS_API_KEY', 'DATABASE_URL'].forEach((key) => {
  if (!process.env[key]) {
    console.error(`Fatal Initialization Error: Missing required env variable [${key}]`);
    process.exit(1);
  }
});

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure Upload Directory Structure Exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer Disk Storage Configuration for Document Files
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${req.body.docType || 'DOC'}-${req.body.driverId || 'UNKNOWN'}-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage });

// Database Connection Setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Helper Logic
const normalizePhone = (num) => String(num || '').replace(/\D/g, '').slice(-10);
const isValidPhone = (p) => /^[6-9]\d{9}$/.test(p);
const hashOtp = (otp) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(String(otp)).digest('hex');
const signToken = (user) => jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });

// Fast2SMS API Dispatch Gateway
const sendSMS = async (phone, otp) => {
  try {
    const { data } = await axios.get('https://www.fast2sms.com/dev/bulkV2', {
      params: {
        authorization: process.env.FAST2SMS_API_KEY,
        route: 'otp',
        variables_values: otp,
        numbers: phone
      },
      timeout: 10000
    });
    console.log(`Fast2SMS Response Payload: ${JSON.stringify(data)}`);
    return data && data.return === true;
  } catch (err) {
    console.error('Fast2SMS Transmission Failed:', err.response?.data || err.message);
    return false;
  }
};

// Authentication Middleware Guard
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

const driverOnly = (req, res, next) => {
  if (req.user?.role !== 'driver') return res.status(403).json({ success: false, error: 'Access restricted to drivers' });
  next();
};

const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ success: false, error: 'Access restricted to system administrators' });
  next();
};

// Rate Limiters
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => normalizePhone(req.body.phone_number || req.body.phone) || req.ip,
  message: { success: false, error: 'Too many OTP attempts. Retry after 10 minutes.' }
});

// ==================== AUTHENTICATION ROUTES ====================

app.post('/api/auth/send-otp', otpLimiter, async (req, res) => {
  const phone = normalizePhone(req.body.phone_number || req.body.phone);
  const role = ['rider', 'driver'].includes((req.body.role || '').toLowerCase())
    ? req.body.role.toLowerCase()
    : 'rider';

  if (!isValidPhone(phone)) return res.status(400).json({ success: false, error: 'Provide a valid 10-digit mobile number' });

  const otp = crypto.randomInt(100000, 1000000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  try {
    await pool.query(
      `INSERT INTO users (phone_number, role, otp_hash, otp_expires_at, otp_attempts)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (phone_number)
       DO UPDATE SET otp_hash = $3, otp_expires_at = $4, otp_attempts = 0, role = $2`,
      [phone, role, hashOtp(otp), expiresAt]
    );

    const sent = await sendSMS(phone, otp);
    if (!sent) {
      return res.status(502).json({ success: false, error: 'Failed to send SMS OTP via Fast2SMS gateway.' });
    }
    res.json({ success: true, message: 'OTP transmitted successfully via mobile SMS.' });
  } catch (err) {
    console.error('send-otp system error:', err);
    res.status(500).json({ success: false, error: 'Internal Auth Dispatch Failure' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const phone = normalizePhone(req.body.phone_number || req.body.phone);
  const otp = String(req.body.otp_code || req.body.otp || '');

  if (!isValidPhone(phone) || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ success: false, error: 'Invalid phone format or 6-digit OTP code' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
    const user = rows[0];

    if (!user || !user.otp_hash || !user.otp_expires_at || new Date(user.otp_expires_at) < new Date()) {
      return res.status(400).json({ success: false, error: 'OTP code expired. Request a new OTP.' });
    }

    if (user.otp_attempts >= 5) {
      return res.status(429).json({ success: false, error: 'Maximum attempts exceeded. Request a new OTP.' });
    }

    const inputHash = Buffer.from(hashOtp(otp));
    const storedHash = Buffer.from(user.otp_hash);
    if (!crypto.timingSafeEqual(inputHash, storedHash)) {
      await pool.query('UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = $1', [user.id]);
      return res.status(400).json({ success: false, error: 'Incorrect OTP entered' });
    }

    await pool.query(
      'UPDATE users SET is_verified = true, otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0 WHERE id = $1',
      [user.id]
    );

    if (user.role === 'driver') {
      await pool.query(
        `INSERT INTO driver_profiles (user_id, approval_status)
         VALUES ($1, 'pending')
         ON CONFLICT (user_id) DO NOTHING`,
        [user.id]
      );
    }

    res.json({
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
  } catch (err) {
    console.error('verify-otp error:', err);
    res.status(500).json({ success: false, error: 'Authentication verification failed' });
  }
});

// ==================== DRIVER PROFILE & DASHBOARD API ====================

app.get('/api/driver/profile', auth, driverOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.full_name as name, u.phone_number as phone, dp.rating, dp.vehicle_number, dp.vehicle_type, dp.approval_status
       FROM users u
       JOIN driver_profiles dp ON u.id = dp.user_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Driver account record not found' });

    const driver = rows[0];
    res.json({
      success: true,
      data: {
        name: driver.name || 'SwamiCab Driver',
        rating: parseFloat(driver.rating || 5.0),
        approvalStatus: driver.approval_status,
        vehicle: {
          number: driver.vehicle_number || 'Pending Reg',
          type: driver.vehicle_type || 'Cab'
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error resolving driver profile' });
  }
});

app.get('/api/driver/earnings/summary', auth, driverOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
        COALESCE(SUM(total_fare), 0.0) as total_earnings,
        COUNT(id) as completed_rides,
        COALESCE(SUM(total_fare * 0.10), 0.0) as platform_fees,
        COALESCE(SUM(incentive_amount), 0.0) as incentives,
        COALESCE(SUM(surge_amount), 0.0) as surge_earnings,
        COALESCE(SUM(distance_km), 0.0) as total_distance
       FROM rides
       WHERE driver_id = $1 AND status = 'completed' AND DATE(created_at) = CURRENT_DATE`,
      [req.user.id]
    );

    const summary = rows[0];
    const totalEarnings = parseFloat(summary.total_earnings);
    const platformFees = parseFloat(summary.platform_fees);
    const incentives = parseFloat(summary.incentives);
    const surgeEarnings = parseFloat(summary.surge_earnings);

    res.json({
      success: true,
      data: {
        totalEarnings: totalEarnings,
        completedRidesCount: parseInt(summary.completed_rides),
        rideEarnings: totalEarnings - incentives - surgeEarnings,
        platformFee: platformFees,
        incentives: incentives,
        surgeEarnings: surgeEarnings,
        netTakeHome: totalEarnings - platformFees + incentives,
        totalDistanceKm: parseFloat(summary.total_distance)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error fetching dynamic earnings data' });
  }
});

app.get('/api/driver/wallet/summary', auth, driverOnly, async (req, res) => {
  try {
    const userRes = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [req.user.id]);
    const walletBalance = parseFloat(userRes.rows[0]?.wallet_balance || 0.0);

    const deductionsRes = await pool.query(
      `SELECT id, ride_id, platform_fee_amount, date_time, description
       FROM wallet_deductions
       WHERE driver_id = $1
       ORDER BY date_time DESC LIMIT 20`,
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        walletBalance: walletBalance,
        deductions: deductionsRes.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to retrieve wallet summary' });
  }
});

app.get('/api/driver/incentives/summary', auth, driverOnly, async (req, res) => {
  try {
    const questRes = await pool.query(
      `SELECT completed_trips, target_trips, current_bonus, total_surge_earned, peak_hours_logged
       FROM driver_incentive_quests
       WHERE driver_id = $1 AND week_start_date <= CURRENT_DATE
       ORDER BY week_start_date DESC LIMIT 1`,
      [req.user.id]
    );

    const logsRes = await pool.query(
      `SELECT id, title, amount, date_time, type
       FROM driver_bonus_logs
       WHERE driver_id = $1
       ORDER BY date_time DESC LIMIT 10`,
      [req.user.id]
    );

    const q = questRes.rows[0] || {
      completed_trips: 0,
      target_trips: 50,
      current_bonus: 0,
      total_surge_earned: 0,
      peak_hours_logged: 0
    };

    res.json({
      success: true,
      data: {
        weeklyBonusAmount: parseFloat(q.current_bonus),
        completedTrips: parseInt(q.completed_trips),
        targetTrips: parseInt(q.target_trips),
        totalSurgeEarned: parseFloat(q.total_surge_earned),
        peakHoursLogged: parseFloat(q.peak_hours_logged),
        bonusLogs: logsRes.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch incentive summary details' });
  }
});

// ==================== DRIVER DOCUMENT UPLOADS & STATUS ====================

app.post('/api/driver/upload-docs', upload.single('document'), async (req, res) => {
  const { driverId, docType } = req.body;
  if (!driverId || !docType || !req.file) {
    return res.status(400).json({ success: false, error: 'Missing driverId, docType, or document file payload' });
  }

  try {
    const columnMap = {
      DL: 'dl_url',
      RC: 'rc_url',
      INSURANCE: 'insurance_url',
      AADHAAR: 'aadhaar_url',
      VEHICLE_PHOTOS: 'vehicle_photos_url'
    };

    const targetColumn = columnMap[docType.toUpperCase()];
    if (!targetColumn) return res.status(400).json({ success: false, error: 'Invalid document type submitted' });

    const fileUrl = `/uploads/${req.file.filename}`;

    await pool.query(
      `INSERT INTO driver_documents (driver_id, ${targetColumn})
       VALUES ($1, $2)
       ON CONFLICT (driver_id)
       DO UPDATE SET ${targetColumn} = $2`,
      [driverId, fileUrl]
    );

    res.json({ success: true, message: `${docType} document uploaded successfully`, fileUrl });
  } catch (err) {
    console.error('Upload DB error:', err);
    res.status(500).json({ success: false, error: 'Failed to process document file storage' });
  }
});

app.get('/api/driver/documents/status', async (req, res) => {
  const { driverId } = req.query;
  if (!driverId) return res.status(400).json({ success: false, error: 'driverId parameter required' });

  try {
    const { rows } = await pool.query(
      `SELECT dl_url, rc_url, insurance_url, aadhaar_url, vehicle_photos_url
       FROM driver_documents WHERE driver_id = $1`,
      [driverId]
    );

    if (!rows.length) {
      return res.json({
        dl_uploaded: false,
        rc_uploaded: false,
        insurance_uploaded: false,
        aadhaar_uploaded: false,
        vehicle_photos_uploaded: false
      });
    }

    const docs = rows[0];
    res.json({
      dl_uploaded: !!docs.dl_url,
      rc_uploaded: !!docs.rc_url,
      insurance_uploaded: !!docs.insurance_url,
      aadhaar_uploaded: !!docs.aadhaar_url,
      vehicle_photos_uploaded: !!docs.vehicle_photos_url
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error resolving document status' });
  }
});

// ==================== ADMIN CONTROL PANEL ENDPOINTS ====================

app.get('/api/admin/pending-drivers', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id as user_id, u.full_name, u.phone_number, dp.vehicle_number, dp.vehicle_type, dp.approval_status,
              dd.dl_url, dd.rc_url, dd.insurance_url, dd.aadhaar_url, dd.vehicle_photos_url
       FROM users u
       JOIN driver_profiles dp ON u.id = dp.user_id
       LEFT JOIN driver_documents dd ON u.id = dd.driver_id
       WHERE dp.approval_status = 'pending'`
    );
    res.json({ success: true, pendingDrivers: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list pending driver approvals' });
  }
});

app.post('/api/admin/approve-driver', auth, adminOnly, async (req, res) => {
  const { driverUserId, status } = req.body; // status: 'approved' or 'rejected'
  if (!driverUserId || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid payload elements' });
  }

  try {
    await pool.query(
      'UPDATE driver_profiles SET approval_status = $1 WHERE user_id = $2',
      [status, driverUserId]
    );

    io.to(`driver_${driverUserId}`).emit('driver_approval_update', { approvalStatus: status });

    res.json({ success: true, message: `Driver state updated to ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error updating driver approval status' });
  }
});

// ==================== SOCKET.IO REALTIME ENGINE ====================

io.on('connection', (socket) => {
  console.log(`Socket Client Connected: ${socket.id}`);

  socket.on('join_driver_room', (data) => {
    if (data?.driverId) {
      socket.join(`driver_${data.driverId}`);
      console.log(`Socket ${socket.id} joined room: driver_${data.driverId}`);
    }
  });

  socket.on('get_driver_incentives', async (data) => {
    try {
      const driverId = data?.driverId;
      if (!driverId) return;

      const questRes = await pool.query(
        `SELECT completed_trips, target_trips, current_bonus, total_surge_earned, peak_hours_logged
         FROM driver_incentive_quests
         WHERE driver_id = $1 AND week_start_date <= CURRENT_DATE
         ORDER BY week_start_date DESC LIMIT 1`,
        [driverId]
      );

      const logsRes = await pool.query(
        `SELECT id, title, amount, date_time, type
         FROM driver_bonus_logs
         WHERE driver_id = $1
         ORDER BY date_time DESC LIMIT 10`,
        [driverId]
      );

      const q = questRes.rows[0] || {
        completed_trips: 32,
        target_trips: 50,
        current_bonus: 1200,
        total_surge_earned: 1450,
        peak_hours_logged: 14.5
      };

      socket.emit('weekly_quest_update', {
        completedRides: parseInt(q.completed_trips),
        targetRides: parseInt(q.target_trips),
        bonusUnlocked: parseInt(q.current_bonus),
        nextTierBonus: 800
      });

      socket.emit('surge_log_update', {
        totalSurgeEarned: parseFloat(q.total_surge_earned),
        peakHoursCount: `${q.peak_hours_logged} hrs`,
        logs: logsRes.rows.map((log) => ({
          title: log.title,
          timestamp: log.date_time,
          bonusAmount: parseFloat(log.amount)
        }))
      });
    } catch (err) {
      console.error('Socket incentive retrieval failed:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Socket Client Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`SwamiCab Backend Active Engine running on port ${PORT}`);
});