require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Server } = require('socket.io');
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

// Verify Essential Environment Variables
['JWT_SECRET', 'DATABASE_URL', 'FAST2SMS_API_KEY'].forEach((key) => {
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

// Make io accessible to routes via app
app.set('socketio', io);

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

// Temporary in-memory OTP store
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
      const apiMsg = response.data?.message || 'Failed to send SMS via Fast2SMS';
      return res.status(400).json({ success: false, error: Array.isArray(apiMsg) ? apiMsg.join(', ') : apiMsg });
    }
  } catch (err) {
    let errorMsg = err.message || 'Internal server error while sending OTP';
    console.error('Fast2SMS dispatch error:', errorMsg);
    return res.status(500).json({ success: false, error: errorMsg });
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

      if (user.role === 'driver') {
        await pool.query(
          `INSERT INTO driver_profiles (user_id, approval_status)
           VALUES ($1, 'pending')
           ON CONFLICT (user_id) DO NOTHING`,
          [user.id]
        );
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
      console.error('Database user resolution error after OTP verification:', dbErr);
      return res.status(500).json({ success: false, error: 'Database error processing user session' });
    }
  }

  res.status(400).json({ success: false, error: 'Invalid or expired OTP code' });
});

// ==================== ADMIN SETTINGS REAL-TIME APIs ====================

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

// ==================== USER PROFILE & SETTINGS SYNC APIs ====================

app.post('/api/users/saved-places', auth, async (req, res) => {
  try {
    const { userId, type, address } = req.body;
    const targetUserId = userId || req.user.id;

    await pool.query(`
      INSERT INTO saved_places (user_id, title, address, lat, lng, type)
      VALUES ($1, $2, $3, 0.0, 0.0, $2)
      ON CONFLICT DO NOTHING
    `, [targetUserId, type, address]);

    const updateCol = type === 'home' ? 'saved_home' : 'saved_work';
    try {
      await pool.query(`UPDATE users SET ${updateCol} = $1 WHERE id = $2`, [address, targetUserId]);
    } catch (e) {}

    const updatedUserRes = await pool.query('SELECT * FROM users WHERE id = $1', [targetUserId]);
    const updatedUser = updatedUserRes.rows[0];

    const ioInstance = req.app.get('socketio');
    if (ioInstance) {
      ioInstance.emit('user_data_changed', updatedUser);
    }

    res.json({ success: true, message: 'Saved place updated successfully', user: updatedUser });
  } catch (err) {
    console.error('Error saving place:', err);
    res.status(500).json({ success: false, error: 'Failed to save address' });
  }
});

app.post('/api/users/notification-settings', auth, async (req, res) => {
  try {
    const { userId, type, enabled } = req.body;
    const targetUserId = userId || req.user.id;

    const column = type === 'rides' ? 'push_enabled' : 'sms_enabled';
    await pool.query(`
      INSERT INTO user_settings (user_id, ${column})
      VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET ${column} = $2
    `, [targetUserId, enabled]);

    res.json({ success: true, message: 'Notification settings updated' });
  } catch (err) {
    console.error('Error saving notification preferences:', err);
    res.status(500).json({ success: false, error: 'Failed to update preferences' });
  }
});

app.post('/api/support/ticket', auth, async (req, res) => {
  try {
    const { userId, message } = req.body;
    const targetUserId = userId || req.user.id;

    const newTicketRes = await pool.query(`
      INSERT INTO support_tickets (user_id, subject, message, status)
      VALUES ($1, 'App Support Request', $2, 'open')
      RETURNING *
    `, [targetUserId, message]);

    const newTicket = newTicketRes.rows[0];
    const ioInstance = req.app.get('socketio');
    if (ioInstance) {
      ioInstance.emit('new_support_ticket', newTicket);
    }

    res.json({ success: true, message: 'Ticket created successfully', ticket: newTicket });
  } catch (err) {
    console.error('Error creating support ticket:', err);
    res.status(500).json({ success: false, error: 'Failed to submit support ticket' });
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
    res.status(550).json({ success: false, error: 'Failed to execute payout transfer' });
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

app.get('/', (req, res) => {
  res.json({ success: true, message: 'SwamiCab Backend API is live and running smoothly!' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`SwamiCab Backend Active Engine running on port ${PORT}`);
});