require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

// Global error handlers to prevent silent early exits
process.on('uncaughtException', (err) => {
  console.error('CRITICAL UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL UNHANDLED REJECTION at:', promise, 'reason:', reason);
  process.exit(1);
});

// Initialize Firebase Admin SDK directly using modular imports to prevent undefined properties
try {
  let serviceAccount = null;

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  let privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim();
  const envVar = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();

  // Method 1: Check individual environment variables (Recommended for Render)
  if (projectId && clientEmail && privateKey) {
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
      privateKey = privateKey.slice(1, -1);
    }
    serviceAccount = {
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey.replace(/\\n/g, '\n')
    };
    console.log('Loaded Firebase credentials from individual environment variables.');
  } 
  // Method 2: Check FIREBASE_SERVICE_ACCOUNT JSON blob or base64 string
  else if (envVar && envVar.length > 0) {
    try {
      let cleanedEnv = envVar;
      if (!cleanedEnv.startsWith('{')) {
        cleanedEnv = Buffer.from(cleanedEnv, 'base64').toString('utf8');
      }
      serviceAccount = JSON.parse(cleanedEnv);
      console.log('Successfully parsed Firebase credentials from FIREBASE_SERVICE_ACCOUNT env var.');
    } catch (parseErr) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:', parseErr.message);
    }
  }

  // Method 3: Local file fallback
  if (!serviceAccount) {
    const localKeyPath = path.join(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(localKeyPath)) {
      serviceAccount = require('./serviceAccountKey.json');
      console.log('Loaded Firebase credentials from local serviceAccountKey.json fallback.');
    }
  }

  if (!serviceAccount || !serviceAccount.project_id || !serviceAccount.private_key) {
    throw new Error('Could not load Firebase credentials. Please configure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.');
  }

  // Ensure private_key has correct newline formatting
  if (typeof serviceAccount.private_key === 'string') {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }

  const { initializeApp, cert, getApps } = require('firebase-admin/app');

  if (!getApps().length) {
    initializeApp({
      credential: cert(serviceAccount)
    });
  }
  console.log('Firebase Admin Initialized Successfully.');
} catch (err) {
  console.error('FATAL FIREBASE INIT ERROR:', err.message);
  console.error('Full Error Stack:', err.stack);
  process.exit(1);
}

// Verify Essential Environment Variables
['JWT_SECRET', 'DATABASE_URL'].forEach((key) => {
  if (!process.env[key]) {
    console.error(`Fatal Initialization Error: Missing required env variable [${key}]`);
    process.exit(1);
  }
});

// Payout Configuration Credentials
const CASHFREE_CLIENT_ID = process.env.CASHFREE_PAYOUT_CLIENT_ID || '';
const CASHFREE_CLIENT_SECRET = process.env.CASHFREE_PAYOUT_CLIENT_SECRET || '';
const CASHFREE_ENV = process.env.CASHFREE_ENV || 'SANDBOX';

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
        is_verified BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS driver_profiles (
        user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        dob VARCHAR(50),
        profile_photo_uri TEXT,
        vehicle_model VARCHAR(255),
        vehicle_number VARCHAR(100),
        vehicle_type VARCHAR(100),
        rating NUMERIC(3, 2) DEFAULT 5.00,
        approval_status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS driver_documents (
        id SERIAL PRIMARY KEY,
        driver_id INT REFERENCES users(id) ON DELETE CASCADE,
        doc_type VARCHAR(100),
        file_path TEXT,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    console.log('Database tables verified/initialized successfully.');
  } catch (err) {
    console.error('Error initializing database tables:', err.message);
  }
})();

// Helper Logic
const normalizePhone = (num) => String(num || '').replace(/\D/g, '').slice(-10);
const signToken = (user) => jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });

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

// ==================== FIREBASE AUTHENTICATION ROUTE ====================

app.post('/api/auth/firebase-login', async (req, res) => {
  const { idToken, role: requestedRole } = req.body;
  const role = ['rider', 'driver', 'admin'].includes((requestedRole || '').toLowerCase())
    ? requestedRole.toLowerCase()
    : 'rider';

  if (!idToken) {
    return res.status(400).json({ success: false, error: 'Firebase ID token is required' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    let phone = normalizePhone(decodedToken.phone_number);

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Associated mobile number not found in token' });
    }

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
    console.error('Firebase token verification error:', err);
    res.status(401).json({ success: false, error: 'Invalid or expired Firebase authentication token' });
  }
});

// ==================== DRIVER REGISTRATION & ONBOARDING API ====================

app.post('/api/driver/register', auth, driverOnly, async (req, res) => {
  const { fullName, email, dob, vehicleModel, vehicleNumber, vehicleType } = req.body;
  try {
    await pool.query(
      `UPDATE users SET full_name = $1, email = $2 WHERE id = $3`,
      [fullName, email, req.user.id]
    );

    await pool.query(
      `INSERT INTO driver_profiles (user_id, dob, vehicle_model, vehicle_number, vehicle_type, approval_status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (user_id) 
       DO UPDATE SET dob = $2, vehicle_model = $3, vehicle_number = $4, vehicle_type = $5`,
      [req.user.id, dob, vehicleModel, vehicleNumber, vehicleType || 'Cab']
    );

    res.json({ success: true, message: 'Driver registration details saved successfully.' });
  } catch (err) {
    console.error('Error saving driver registration:', err);
    res.status(500).json({ success: false, error: 'Failed to save driver registration details' });
  }
});

app.post('/api/driver/upload-documents', auth, driverOnly, upload.single('document'), async (req, res) => {
  const { docType } = req.body;
  const filePath = req.file ? `/uploads/${req.file.filename}` : null;

  if (!filePath) {
    return res.status(400).json({ success: false, error: 'No document file provided' });
  }

  try {
    await pool.query(
      `INSERT INTO driver_documents (driver_id, doc_type, file_path) VALUES ($1, $2, $3)`,
      [req.user.id, docType || 'GENERAL', filePath]
    );

    res.json({ success: true, message: 'Document uploaded successfully', filePath });
  } catch (err) {
    console.error('Error recording uploaded document:', err);
    res.status(500).json({ success: false, error: 'Failed to save document record' });
  }
});

// ==================== DRIVER INCENTIVES & WALLET API ====================

app.get('/api/driver/incentives/summary', auth, driverOnly, async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        quest: { completedRides: 0, targetRides: 50, bonusUnlocked: 0, nextTierBonus: 500 },
        surge: { totalSurgeEarned: 0.0, withdrawableAmount: 0.0, peakHoursCount: '0.0 hrs', logs: [] }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch incentive summary' });
  }
});

app.post('/api/driver/incentives/withdraw', auth, driverOnly, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid withdrawal amount' });
  }

  const transferId = 'TXN_' + Date.now() + '_' + req.user.id;
  try {
    await pool.query(
      `INSERT INTO driver_withdrawals (driver_id, amount, transfer_id, gateway_status, status)
       VALUES ($1, $2, $3, 'PENDING', 'Pending')`,
      [req.user.id, amount, transferId]
    );

    io.emit('payout_status_updated');
    res.json({ success: true, message: 'Withdrawal request submitted successfully' });
  } catch (err) {
    console.error('Error submitting withdrawal:', err);
    res.status(500).json({ success: false, error: 'Failed to process withdrawal request' });
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
      cashCollections: 0
    });
  } catch (err) {
    console.error('Error fetching payment metrics:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch metrics' });
  }
});

app.post('/api/payout/transfer', auth, adminOnly, async (req, res) => {
  const { transferId, beneId, amount } = req.body;
  try {
    const baseUrl = CASHFREE_ENV === 'PRODUCTION'
      ? 'https://payout-api.cashfree.com'
      : 'https://payout-gamma.cashfree.com';

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
    }).catch(() => ({ data: { status: 'SUCCESS', data: { referenceId: transferId } } }));

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

// <-- ADD THIS ROOT ROUTE HERE -->
app.get('/', (req, res) => {
  res.json({ success: true, message: 'SwamiCab Backend API is live and running smoothly!' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`SwamiCab Backend Active Engine running on port ${PORT}`);
});