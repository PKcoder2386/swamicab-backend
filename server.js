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
const Razorpay = require('razorpay');

// ==================== REQUIRED ENV CHECK ====================
['JWT_SECRET', 'FAST2SMS_API_KEY'].forEach((k) => {
  if (!process.env[k]) {
    console.error(`Missing required env variable: ${k}`);
    process.exit(1);
  }
});
const IS_PROD = process.env.NODE_ENV === 'production';

const app = express();
app.set('trust proxy', 1); // needed on Render/Heroku etc. for correct IP in rate limiting
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ==================== RAZORPAY (optional until keys are set) ====================
const razorpay =
  process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      })
    : null;

// ==================== DATABASE ====================
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        user: process.env.PGUSER || 'postgres',
        host: process.env.PGHOST || 'localhost',
        database: process.env.PGDATABASE || 'swamicab_db',
        password: process.env.PGPASSWORD,
        port: process.env.PGPORT || 5432,
      }
);

// ==================== HELPERS ====================
const normalizePhone = (num) => String(num || '').replace(/\D/g, '').slice(-10);
const isValidPhone = (p) => /^[6-9]\d{9}$/.test(p); // Indian mobile numbers
const hashOtp = (otp) =>
  crypto.createHmac('sha256', process.env.JWT_SECRET).update(String(otp)).digest('hex');
const signToken = (user) =>
  jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });

// ---- Fast2SMS ----
const sendSMS = async (phone, otp) => {
  try {
    const { data } = await axios.get('https://www.fast2sms.com/dev/bulkV2', {
      params: {
        authorization: process.env.FAST2SMS_API_KEY,
        route: 'otp',
        variables_values: otp,
        numbers: phone,
      },
      timeout: 10000,
    });
    console.log('Fast2SMS response:', JSON.stringify(data));
    return data && data.return === true;
  } catch (err) {
    console.error('Fast2SMS error:', err.response?.data || err.message);
    return false;
  }
};

// ---- Auth middleware ----
const auth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};
const adminOnly = (req, res, next) =>
  req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const driverOnly = (req, res, next) =>
  req.user?.role === 'driver' ? next() : res.status(403).json({ error: 'Drivers only' });
const selfOrAdmin = (paramName) => (req, res, next) =>
  String(req.user.id) === String(req.params[paramName]) || req.user.role === 'admin'
    ? next()
    : res.status(403).json({ error: 'Forbidden' });

// ---- Rate limiters ----
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => normalizePhone(req.body.phone_number || req.body.phone) || req.ip,
  message: { error: 'Too many OTP requests. Try again after 10 minutes.' },
});
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use('/api/', generalLimiter);

// ==================== HEALTH ====================
app.get('/', (req, res) =>
  res.json({ status: 'success', message: 'SwamiCab Backend API is live' })
);

// ==================== AUTH ====================
app.post('/api/auth/send-otp', otpLimiter, async (req, res) => {
  const phone = normalizePhone(req.body.phone_number || req.body.phone);
  const role = ['rider', 'driver'].includes((req.body.role || '').toLowerCase())
    ? req.body.role.toLowerCase()
    : 'rider';

  if (!isValidPhone(phone))
    return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });

  const otp = crypto.randomInt(100000, 1000000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  try {
    await pool.query(
      `INSERT INTO users (phone_number, role, otp_hash, otp_expires_at, otp_attempts)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (phone_number)
       DO UPDATE SET otp_hash = $3, otp_expires_at = $4, otp_attempts = 0`,
      [phone, role, hashOtp(otp), expiresAt]
    );

    const sent = await sendSMS(phone, otp);
    if (!sent) {
      return res.status(502).json({
        error: 'Could not send SMS right now. Please try again in a moment.',
      });
    }
    res.json({ success: true, message: 'OTP sent to your mobile number' });
  } catch (err) {
    console.error('send-otp error:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const phone = normalizePhone(req.body.phone_number || req.body.phone);
  const otp = String(req.body.otp_code || req.body.otp || '');

  if (!isValidPhone(phone) || !/^\d{6}$/.test(otp))
    return res.status(400).json({ error: 'Invalid phone or OTP' });

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
    const user = rows[0];

    if (!user || !user.otp_hash || !user.otp_expires_at || new Date(user.otp_expires_at) < new Date())
      return res.status(400).json({ error: 'OTP expired. Please request a new one.' });

    if (user.otp_attempts >= 5)
      return res.status(429).json({ error: 'Too many wrong attempts. Request a new OTP.' });

    const a = Buffer.from(hashOtp(otp));
    const b = Buffer.from(user.otp_hash);
    if (!crypto.timingSafeEqual(a, b)) {
      await pool.query('UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = $1', [user.id]);
      return res.status(400).json({ error: 'Incorrect OTP' });
    }

    await pool.query(
      'UPDATE users SET is_verified = true, otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0 WHERE id = $1',
      [user.id]
    );

    if (user.role === 'driver') {
      await pool.query(
        'INSERT INTO driver_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
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
        email: user.email,
      },
    });
  } catch (err) {
    console.error('verify-otp error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ==================== USER PROFILE ====================
app.get('/api/user/profile/:id', auth, selfOrAdmin('id'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone_number, dob, gender, emergency_contact, wallet_balance, role
       FROM users WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.put('/api/user/profile/:id', auth, selfOrAdmin('id'), async (req, res) => {
  const { full_name, email, dob, gender, emergency_contact } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE users SET full_name=$1, email=$2, dob=$3, gender=$4, emergency_contact=$5
       WHERE id=$6
       RETURNING id, full_name, email, phone_number, dob, gender, emergency_contact, role, wallet_balance, is_verified, created_at`,
      [full_name, email || null, dob || null, gender, emergency_contact, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    io.to('admins').emit('user_profile_updated', rows[0]);
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update user details' });
  }
});

// ==================== SAVED PLACES ====================
app.get('/api/user/saved-places/:userId', auth, selfOrAdmin('userId'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM saved_places WHERE user_id = $1 ORDER BY id DESC',
      [req.params.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch saved places' });
  }
});

app.post('/api/user/saved-places', auth, async (req, res) => {
  const { title, address, lat, lng, type } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO saved_places (user_id, title, address, lat, lng, type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, title, address, lat || 0, lng || 0, type || 'favorite']
    );
    res.json({ success: true, place: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save place' });
  }
});

app.delete('/api/user/saved-places/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM saved_places WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete saved place' });
  }
});

// ==================== NOTIFICATIONS & SETTINGS ====================
app.get('/api/user/notifications/:userId', auth, selfOrAdmin('userId'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
      [req.params.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.get('/api/user/settings/:userId', auth, selfOrAdmin('userId'), async (req, res) => {
  try {
    let { rows } = await pool.query('SELECT * FROM user_settings WHERE user_id = $1', [
      req.params.userId,
    ]);
    if (!rows.length) {
      const init = await pool.query(
        'INSERT INTO user_settings (user_id) VALUES ($1) RETURNING *',
        [req.params.userId]
      );
      rows = init.rows;
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.put('/api/user/settings/:userId', auth, selfOrAdmin('userId'), async (req, res) => {
  const { language, push_enabled, sms_enabled, dark_mode } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO user_settings (user_id, language, push_enabled, sms_enabled, dark_mode)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET
         language=EXCLUDED.language, push_enabled=EXCLUDED.push_enabled,
         sms_enabled=EXCLUDED.sms_enabled, dark_mode=EXCLUDED.dark_mode
       RETURNING *`,
      [req.params.userId, language, push_enabled, sms_enabled, dark_mode]
    );
    res.json({ success: true, settings: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ==================== SUPPORT ====================
app.post('/api/support/ticket', auth, async (req, res) => {
  const { subject, message } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO support_tickets (user_id, subject, message) VALUES ($1,$2,$3) RETURNING *',
      [req.user.id, subject, message]
    );
    io.to('admins').emit('new_support_ticket', rows[0]);
    res.json({ success: true, ticket: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create support ticket' });
  }
});

// ==================== DRIVER SPECIFIC ENDPOINTS ====================
app.post('/api/driver/vehicle', auth, driverOnly, async (req, res) => {
  const { vehicle_type, vehicle_number, vehicle_model, license_number } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO driver_profiles (user_id, vehicle_type, vehicle_number, vehicle_model, license_number, verification_status)
       VALUES ($1,$2,$3,$4,$5,'pending')
       ON CONFLICT (user_id) DO UPDATE SET
         vehicle_type=$2, vehicle_number=$3, vehicle_model=$4, license_number=$5, verification_status='pending'
       RETURNING *`,
      [req.user.id, vehicle_type, vehicle_number, vehicle_model, license_number]
    );
    io.to('admins').emit('driver_submitted', rows[0]);
    res.json({ success: true, profile: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save vehicle details' });
  }
});

// Fetch Driver Profile
app.get('/api/driver/profile', auth, driverOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.full_name as name, u.phone_number as phone, u.email,
              d.rating, d.completed_rides, d.vehicle_type, d.vehicle_number, d.vehicle_model,
              d.verification_status, d.is_online
       FROM users u
       LEFT JOIN driver_profiles d ON u.id = d.user_id
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Driver profile not found' });

    const driver = rows[0];
    res.json({
      success: true,
      data: {
        id: driver.id,
        name: driver.name || 'Driver',
        phone: driver.phone,
        rating: parseFloat(driver.rating || 5.0),
        completedRides: parseInt(driver.completed_rides || 0),
        isOnline: driver.is_online || false,
        verificationStatus: driver.verification_status || 'pending',
        vehicle: {
          type: driver.vehicle_type || 'Cab',
          number: driver.vehicle_number || 'N/A',
          model: driver.vehicle_model || 'Standard'
        }
      }
    });
  } catch (err) {
    console.error('Driver profile error:', err);
    res.status(500).json({ error: 'Failed to fetch driver profile' });
  }
});

// Driver Daily Earnings Summary
app.get('/api/driver/earnings/summary', auth, driverOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
         COALESCE(SUM(fare_amount), 0) AS total_gross,
         COUNT(id) AS completed_count
       FROM rides 
       WHERE driver_id = $1 AND status = 'completed' AND DATE(completed_at) = CURRENT_DATE`,
      [req.user.id]
    );

    const grossFare = parseFloat(rows[0].total_gross);
    const completedCount = parseInt(rows[0].completed_count);
    const platformFee = grossFare * 0.10; // 10% platform commission
    const netEarnings = grossFare - platformFee;

    res.json({
      success: true,
      data: {
        totalEarnings: netEarnings,
        grossFare: grossFare,
        platformFee: platformFee,
        completedRidesCount: completedCount,
      }
    });
  } catch (err) {
    console.error('Earnings summary error:', err);
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

// Driver Wallet Details & Transaction History
app.get('/api/driver/wallet/summary', auth, driverOnly, async (req, res) => {
  try {
    const userQuery = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [req.user.id]);
    const txQuery = await pool.query(
      'SELECT id, amount, type, description, created_at FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );

    res.json({
      success: true,
      walletBalance: parseFloat(userQuery.rows[0]?.wallet_balance || 0),
      transactions: txQuery.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch wallet summary' });
  }
});

// Direct Driver Wallet Top-Up Endpoint
app.post('/api/driver/wallet/topup', auth, driverOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const { amount, txnId, paymentMethod } = req.body;
    const driverId = req.user.id;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid top-up amount' });
    }

    await client.query('BEGIN');

    // 1. Update Driver Wallet Balance in Database
    const walletRes = await client.query(
      'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 RETURNING wallet_balance',
      [amount, driverId]
    );

    const newBalance = parseFloat(walletRes.rows[0].wallet_balance);

    // 2. Save Transaction Log
    await client.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'credit', $3)`,
      [driverId, amount, `Direct Top-Up (${paymentMethod || 'UPI'}) - Txn: ${txnId || 'N/A'}`]
    );

    await client.query('COMMIT');

    // 3. Emit Socket event to driver app & owner dashboard
    io.to(`driver_${driverId}`).emit('wallet_updated', {
      balance: newBalance
    });

    io.emit('admin_driver_wallet_sync', {
      driverId,
      amount,
      type: 'TOPUP',
      newBalance
    });

    return res.json({ success: true, balance: newBalance });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Driver topup error:', err);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// Initiate Driver Wallet Top-Up (Razorpay)
app.post('/api/driver/wallet/topup/initiate', auth, driverOnly, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Payments gateway unconfigured' });

  const amount = Number(req.body.amount);
  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Minimum top-up amount is ₹100' });
  }

  try {
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `topup_d${req.user.id}_${Date.now()}`
    });

    res.json({ success: true, order, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('Razorpay Order Error:', err);
    res.status(500).json({ error: 'Failed to initiate top-up' });
  }
});

// Verify Driver Top-Up Payment
app.post('/api/driver/wallet/topup/verify', auth, driverOnly, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment signature verification failed' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const walletUpdate = await client.query(
      'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 RETURNING wallet_balance',
      [amount, req.user.id]
    );

    await client.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'credit', $3)`,
      [req.user.id, amount, `Wallet top-up via Payment ID: ${razorpay_payment_id}`]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      newBalance: walletUpdate.rows[0].wallet_balance
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Top-Up verification error:', err);
    res.status(500).json({ error: 'Failed to update wallet balance' });
  } finally {
    client.release();
  }
});

// Ride Completion & Platform Fee Commission Deduction Endpoint
app.post('/api/rides/complete', auth, driverOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rideId, paymentMode, totalFare } = req.body;
    const driverId = req.user.id;

    // Calculate 10% Platform Fee
    const platformFeePercent = 0.10;
    const deductionAmount = totalFare * platformFeePercent; // e.g. ₹500 * 0.10 = ₹50
    const driverNetEarnings = totalFare - deductionAmount;  // e.g. ₹450

    await client.query('BEGIN');

    // 1. Mark Ride as Completed
    await client.query(
      `UPDATE rides SET status = 'completed', completed_at = NOW() WHERE id = $1 AND driver_id = $2`,
      [rideId, driverId]
    );

    // 2. Increment completed rides counter in driver_profiles
    await client.query(
      `UPDATE driver_profiles SET completed_rides = COALESCE(completed_rides, 0) + 1 WHERE user_id = $1`,
      [driverId]
    );

    let walletRes;

    if (paymentMode === 'CASH') {
      // Deduct 10% commission directly from Driver's Prepaid Wallet
      walletRes = await client.query(
        `UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2 RETURNING wallet_balance`,
        [deductionAmount, driverId]
      );

      // Record Wallet Transaction Log
      await client.query(
        `INSERT INTO wallet_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'debit', $3)`,
        [driverId, deductionAmount, `10% Platform Commission Fee for Ride #${rideId}`]
      );

    } else if (paymentMode === 'ONLINE') {
      // Credit net earnings (90%) directly to driver wallet
      walletRes = await client.query(
        `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 RETURNING wallet_balance`,
        [driverNetEarnings, driverId]
      );

      // Record Wallet Transaction Log
      await client.query(
        `INSERT INTO wallet_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'credit', $3)`,
        [driverId, driverNetEarnings, `Net Fare Payout for Ride #${rideId}`]
      );
    }

    await client.query('COMMIT');

    const updatedBalance = parseFloat(walletRes?.rows[0]?.wallet_balance || 0);

    // 3. Socket Event: Update Driver App UI Live
    io.to(`driver_${driverId}`).emit('wallet_updated', {
      balance: updatedBalance,
      latestDeduction: {
        rideId,
        fare: totalFare,
        deduction: deductionAmount,
        type: 'PLATFORM_FEE'
      }
    });

    // 4. Socket Event: Sync Owner/Admin Dashboard Live
    io.emit('admin_driver_wallet_sync', {
      driverId,
      rideId,
      paymentMode,
      fareCollected: totalFare,
      commissionEarned: deductionAmount,
      driverRemainingBalance: updatedBalance,
      timestamp: new Date()
    });

    return res.json({
      success: true,
      message: "Ride completed successfully",
      walletBalance: updatedBalance
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Ride completion error:', err);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// ==================== PAYMENTS (Razorpay) ====================
app.post('/api/payments/create-order', auth, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Payments not configured' });
  const amount = Number(req.body.amount);
  if (!amount || amount < 1 || amount > 50000)
    return res.status(400).json({ error: 'Invalid amount' });
  try {
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // paise
      currency: 'INR',
      receipt: `u${req.user.id}_${Date.now()}`,
    });
    await pool.query(
      `INSERT INTO payments (user_id, razorpay_order_id, amount, status) VALUES ($1,$2,$3,'created')`,
      [req.user.id, order.id, amount]
    );
    res.json({ success: true, order, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('Razorpay order error:', err);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

app.post('/api/payments/verify', auth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  if (expected !== razorpay_signature)
    return res.status(400).json({ error: 'Payment verification failed' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE payments SET status='paid', razorpay_payment_id=$1
       WHERE razorpay_order_id=$2 AND user_id=$3 AND status='created' RETURNING amount`,
      [razorpay_payment_id, razorpay_order_id, req.user.id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Order not found or already processed' });
    }
    const wallet = await client.query(
      'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id=$2 RETURNING wallet_balance',
      [rows[0].amount, req.user.id]
    );
    await client.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, description)
       VALUES ($1,$2,'credit','Wallet top-up via Razorpay')`,
      [req.user.id, rows[0].amount]
    );
    await client.query('COMMIT');
    res.json({ success: true, wallet_balance: wallet.rows[0].wallet_balance });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Payment verify error:', err);
    res.status(500).json({ error: 'Payment processing failed' });
  } finally {
    client.release();
  }
});

// ==================== ADMIN ====================
app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone_number, role, wallet_balance, is_verified, dob, gender, emergency_contact, created_at
       FROM users ORDER BY id DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/admin/drivers/pending', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, u.full_name, u.phone_number FROM driver_profiles d
       JOIN users u ON u.id = d.user_id WHERE d.verification_status = 'pending'`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch drivers' });
  }
});

app.put('/api/admin/drivers/:userId/verify', auth, adminOnly, async (req, res) => {
  const status = req.body.status === 'approved' ? 'approved' : 'rejected';
  try {
    const { rows } = await pool.query(
      'UPDATE driver_profiles SET verification_status=$1 WHERE user_id=$2 RETURNING *',
      [status, req.params.userId]
    );
    res.json({ success: true, profile: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update driver' });
  }
});

app.get('/api/admin/overview', auth, adminOnly, async (req, res) => {
  try {
    const [rides, users, drivers, earnings] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM rides'),
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM driver_profiles WHERE is_online = true'),
      pool.query("SELECT SUM(fare_amount) FROM rides WHERE status = 'completed'"),
    ]);
    res.json({
      totalRides: parseInt(rides.rows[0].count),
      totalUsers: parseInt(users.rows[0].count),
      activeDrivers: parseInt(drivers.rows[0].count),
      totalEarnings: parseFloat(earnings.rows[0].sum || 0),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch overview' });
  }
});

// ==================== REAL-TIME: SOCKET.IO ====================
// Every socket must send the JWT: io(URL, { auth: { token } })
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

const DISPATCH_RADIUS_KM = 10;

io.on('connection', (socket) => {
  const { id: userId, role } = socket.user;
  socket.join(`user_${userId}`);
  if (role === 'admin') socket.join('admins');

  // ---- Driver goes online / offline ----
  socket.on('driver_online', async ({ lat, lng }) => {
    if (role !== 'driver') return;
    socket.join(`driver_${userId}`);
    await pool.query(
      'UPDATE driver_profiles SET is_online=true, current_lat=$2, current_lng=$3 WHERE user_id=$1',
      [userId, lat || null, lng || null]
    );
  });

  socket.on('driver_offline', async () => {
    if (role !== 'driver') return;
    await pool.query('UPDATE driver_profiles SET is_online=false WHERE user_id=$1', [userId]);
  });

  socket.on('driver_location', async ({ lat, lng, ride_id }) => {
    if (role !== 'driver') return;
    await pool.query('UPDATE driver_profiles SET current_lat=$2, current_lng=$3 WHERE user_id=$1', [
      userId, lat, lng,
    ]);
    if (ride_id) io.to(`ride_${ride_id}`).emit('driver_location_update', { lat, lng });
  });

  socket.on('disconnect', async () => {
    if (role === 'driver')
      await pool.query('UPDATE driver_profiles SET is_online=false WHERE user_id=$1', [userId]);
  });

  // ---- Rider requests a ride ----
  socket.on('request_ride', async (d) => {
    if (role !== 'rider') return;
    const rideCode = '#SC' + crypto.randomInt(100000, 1000000);
    const startOtp = crypto.randomInt(1000, 10000).toString();
    try {
      const rideRes = await pool.query(
        `INSERT INTO rides (ride_code, rider_id, pickup_address, dropoff_address, pickup_lat, pickup_lng,
                            dropoff_lat, dropoff_lng, fare_amount, start_otp, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'requested') RETURNING *`,
        [rideCode, userId, d.pickup_address, d.dropoff_address, d.pickup_lat, d.pickup_lng,
         d.dropoff_lat, d.dropoff_lng, d.fare_amount, startOtp]
      );
      const ride = rideRes.rows[0];
      socket.join(`ride_${ride.id}`);

      // Online + approved drivers within DISPATCH_RADIUS_KM (Haversine formula)
      const drivers = await pool.query(
        `SELECT user_id FROM driver_profiles
         WHERE is_online = true AND verification_status = 'approved'
           AND current_lat IS NOT NULL AND current_lng IS NOT NULL
           AND (6371 * acos(LEAST(1, cos(radians($1)) * cos(radians(current_lat)) *
                cos(radians(current_lng) - radians($2)) + sin(radians($1)) * sin(radians(current_lat))))) <= $3`,
        [d.pickup_lat, d.pickup_lng, DISPATCH_RADIUS_KM]
      );

      const offer = { ...ride };
      delete offer.start_otp; // drivers must not see the start OTP
      drivers.rows.forEach((dr) => io.to(`driver_${dr.user_id}`).emit('incoming_ride_offer', offer));

      socket.emit('ride_requested_success', ride);
      if (!drivers.rows.length) socket.emit('no_drivers_available', { ride_id: ride.id });
    } catch (err) {
      console.error('request_ride error:', err);
      socket.emit('ride_error', { error: 'Could not create ride' });
    }
  });

  // ---- Driver accepts (atomic: only the first driver wins) ----
  socket.on('accept_ride', async ({ ride_id }) => {
    if (role !== 'driver') return;
    try {
      const { rows } = await pool.query(
        `UPDATE rides SET driver_id=$1, status='accepted'
         WHERE id=$2 AND status='requested' RETURNING *`,
        [userId, ride_id]
      );
      if (!rows.length) return socket.emit('ride_error', { error: 'Ride already taken' });
      socket.join(`ride_${ride_id}`);
      const ride = rows[0];
      io.to(`user_${ride.rider_id}`).emit(`ride_status_${ride_id}`, { status: 'accepted', ride });
      io.to(`user_${ride.rider_id}`).emit('ride_accepted', ride);
      socket.emit('ride_accept_success', { ...ride, start_otp: undefined });
    } catch (err) {
      console.error('accept_ride error:', err);
    }
  });

  // ---- Driver reached pickup point ----
  socket.on('driver_arrived', async ({ ride_id }) => {
    if (role !== 'driver') return;
    const { rows } = await pool.query(
      `UPDATE rides SET status='arrived' WHERE id=$1 AND driver_id=$2 AND status='accepted' RETURNING id`,
      [ride_id, userId]
    );
    if (rows.length) io.to(`ride_${ride_id}`).emit(`ride_status_${ride_id}`, { status: 'arrived' });
  });

  // ---- Driver starts trip with rider's OTP ----
  socket.on('start_ride', async ({ ride_id, otp }) => {
    if (role !== 'driver') return;
    const { rows } = await pool.query(
      `UPDATE rides SET status='in_progress', started_at=NOW()
       WHERE id=$1 AND driver_id=$2 AND status IN ('accepted','arrived') AND start_otp=$3 RETURNING *`,
      [ride_id, userId, String(otp)]
    );
    if (!rows.length) return socket.emit('ride_error', { error: 'Wrong start OTP' });
    io.to(`ride_${ride_id}`).emit(`ride_status_${ride_id}`, { status: 'in_progress', ride: rows[0] });
  });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`SwamiCab Server running on port ${PORT}`));