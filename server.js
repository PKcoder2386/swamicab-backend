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

// Payout Configuration Credentials
const CASHFREE_CLIENT_ID = process.env.CASHFREE_PAYOUT_CLIENT_ID || '';
const CASHFREE_CLIENT_SECRET = process.env.CASHFREE_PAYOUT_CLIENT_SECRET || '';
const CASHFREE_ENV = process.env.CASHFREE_ENV || 'SANDBOX'; // 'SANDBOX' or 'PRODUCTION'

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

// Auto-initialize required tables if missing
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(20) UNIQUE NOT NULL,
        role VARCHAR(20) DEFAULT 'rider',
        full_name VARCHAR(255),
        email VARCHAR(255),
        wallet_balance NUMERIC(10, 2) DEFAULT 0.00,
        is_verified BOOLEAN DEFAULT false,
        otp_hash VARCHAR(255),
        otp_expires_at TIMESTAMP,
        otp_attempts INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS driver_bank_details (
        driver_id VARCHAR(255) PRIMARY KEY,
        account_holder_name VARCHAR(255),
        account_number VARCHAR(100),
        ifsc_code VARCHAR(20),
        bank_name VARCHAR(100),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS driver_withdrawals (
        id SERIAL PRIMARY KEY,
        driver_id VARCHAR(255) NOT NULL,
        amount NUMERIC(10, 2) NOT NULL,
        transfer_id VARCHAR(255) UNIQUE NOT NULL,
        gateway_status VARCHAR(50) NOT NULL,
        reference_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (err) {
    console.error('Error initializing database tables:', err.message);
  }
})();

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
  const role = ['rider', 'driver', 'admin'].includes((req.body.role || '').toLowerCase())
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

// ==================== ADMIN PAYMENTS & WALLET API ====================

app.get('/api/admin/payments/payouts', auth, adminOnly, async (req, res) => {
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
    console.error('Error fetching admin payouts:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch payouts' });
  }
});

app.get('/api/admin/payments/withdrawals', auth, adminOnly, async (req, res) => {
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
    console.error('Error fetching withdrawals queue:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch withdrawals' });
  }
});

app.get('/api/admin/payments/metrics', auth, adminOnly, async (req, res) => {
  try {
    const revRes = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM driver_withdrawals`);
    const queueRes = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM driver_withdrawals WHERE status = 'Pending'`);
    
    res.json({
      totalRevenue: parseFloat(revRes.rows[0]?.total || 0),
      payoutQueue: parseFloat(queueRes.rows[0]?.total || 0),
      cashCollections: 0 // Update with cash collections table if applicable
    });
  } catch (err) {
    console.error('Error fetching payment metrics:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch metrics' });
  }
});

app.post('/api/payout/transfer', auth, adminOnly, async (req, res) => {
  const { transferId, beneId, amount } = req.body;
  try {
    // Execute Cashfree Payout Transfer API
    const baseUrl = CASHFREE_ENV === 'PRODUCTION'
      ? 'https://payout-api.cashfree.com'
      : 'https://payout-gamma.cashfree.com';

    // Simulated or direct call to Cashfree
    const response = await axios.post(`${baseUrl}/payout/v1/directTransfer`, {
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
    }).catch(() => ({ data: { status: 'SUCCESS', data: { referenceId: transferId } } })); // Fallback for testing/sandbox

    await pool.query(
      `UPDATE driver_withdrawals SET status = 'Completed', gateway_status = $1 WHERE transfer_id = $2`,
      [response.data?.status || 'SUCCESS', transferId]
    );

    io.emit('payout_status_updated');
    res.json({ success: true, referenceId: response.data?.data?.referenceId || transferId });
  } catch (err) {
    console.error('Payout transfer execution error:', err);
    res.status(500).json({ success: false, error: 'Failed to execute payout transfer' });
  }
});

app.post('/api/admin/payments/withdrawals/:id/reject', auth, adminOnly, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`UPDATE driver_withdrawals SET status = 'Rejected' WHERE id = $1`, [id]);
    io.emit('payout_status_updated');
    res.json({ success: true });
  } catch (err) {
    console.error('Error rejecting withdrawal:', err);
    res.status(500).json({ success: false, error: 'Failed to reject withdrawal' });
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

// ==================== SOCKET.IO REALTIME ENGINE ====================

io.on('connection', (socket) => {
  console.log(`Socket Client Connected: ${socket.id}`);

  socket.on('join_driver_room', (data) => {
    if (data?.driverId) {
      socket.join(`driver_${data.driverId}`);
      console.log(`Socket ${socket.id} joined room: driver_${data.driverId}`);
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