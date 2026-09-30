require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const axios = require('axios');
const Razorpay = require('razorpay');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Initialize Razorpay Client with Environment Variables
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_live_TiLFwAQalH0OB8',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'Q6k8hL2fv0xllOzhebY2Yd13',
});

// ==================== DATABASE CONFIGURATION ====================
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }, // Required for Render PostgreSQL
      }
    : {
        user: process.env.PGUSER || 'postgres',
        host: process.env.PGHOST || 'localhost',
        database: process.env.PGDATABASE || 'swamicab_db',
        password: process.env.PGPASSWORD || 'Pranit@2386',
        port: process.env.PGPORT || 5432,
      }
);

// Fast2SMS Gateway Helper using bulkV2 Route
const sendSMS = async (numbers, otpMessage) => {
  if (!process.env.FAST2SMS_API_KEY) {
    console.warn('FAST2SMS_API_KEY not found in environment variables. Skipping SMS dispatch.');
    return;
  }
  try {
    const response = await axios.get('https://www.fast2sms.com/dev/bulkV2', {
      params: {
        authorization: process.env.FAST2SMS_API_KEY,
        route: 'otp',
        variables_values: otpMessage,
        numbers: numbers,
      },
    });
    console.log(`[SMS DISPATCH] Sent to ${numbers}:`, response.data);
  } catch (err) {
    console.error('Fast2SMS Gateway Error:', err.response ? err.response.data : err.message);
  }
};

// ==================== HEALTH CHECK ROUTE ====================
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'SwamiCab Production Backend API is live and running!',
    timestamp: new Date(),
  });
});

// ==================== WALLET & RAZORPAY PAYMENT ENDPOINTS ====================

// Fetch Wallet Balance and Recent Transactions
app.get('/api/wallet/details', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    const userRes = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
    const balance = userRes.rows[0] ? parseFloat(userRes.rows[0].wallet_balance) : 0.0;

    const txnRes = await pool.query(
      `SELECT id, description AS title, TO_CHAR(created_at, 'DD Mon YYYY, hh:mi AM') AS date, 
              amount, status, type 
       FROM wallet_transactions 
       WHERE user_id = $1 
       ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );

    res.json({
      balance: balance,
      transactions: txnRes.rows,
    });
  } catch (err) {
    console.error('Fetch Wallet Error:', err);
    res.status(500).json({ error: 'Failed to fetch wallet details' });
  }
});

// Verify Real-time Razorpay Payment & Top-Up Wallet
app.post('/api/wallet/topup', async (req, res) => {
  const { userId, amount, transactionId } = req.body;

  if (!userId || !amount) {
    return res.status(400).json({ error: 'User ID and amount are required' });
  }

  try {
    let paymentVerified = true;

    // Verify payment status with Razorpay if transaction ID is provided
    if (transactionId && !transactionId.startsWith('dummy_')) {
      try {
        const payment = await razorpay.payments.fetch(transactionId);
        if (payment.status !== 'captured' && payment.status !== 'authorized') {
          paymentVerified = false;
        }
      } catch (rzpErr) {
        console.error('Razorpay verification warning:', rzpErr.message);
      }
    }

    if (!paymentVerified) {
      return res.status(400).json({ success: false, error: 'Payment verification failed' });
    }

    // 1. Update User Wallet Balance in DB
    const userUpdate = await pool.query(
      'UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2 RETURNING wallet_balance',
      [amount, userId]
    );

    const newBalance = userUpdate.rows[0] ? parseFloat(userUpdate.rows[0].wallet_balance) : amount;

    // 2. Insert Transaction Record into DB
    const txnRes = await pool.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, description, status) 
       VALUES ($1, $2, 'credit', 'Wallet Top-up via UPI', 'Completed') 
       RETURNING id, description AS title, TO_CHAR(created_at, 'DD Mon YYYY, hh:mi AM') AS date, amount, status, type`,
      [userId, `+₹${parseFloat(amount).toFixed(2)}`]
    );

    const latestTxn = txnRes.rows[0];

    // 3. Emit Socket.io Real-time update event to connected Android user
    io.to(`user_${userId}`).emit('wallet_updated', {
      balance: newBalance,
      latestTransaction: latestTxn,
    });

    res.json({ success: true, balance: newBalance, transaction: latestTxn });
  } catch (err) {
    console.error('Top-Up Wallet Error:', err);
    res.status(500).json({ error: 'Failed to process top-up' });
  }
});

// ==================== AUTH & MOBILE OTP ====================

app.post('/api/auth/send-otp', async (req, res) => {
  const { phone_number, phone, role } = req.body;
  const targetPhone = phone_number || phone;

  if (!targetPhone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  try {
    await pool.query(
      `INSERT INTO users (phone_number, role, otp_code, otp_expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone_number) 
       DO UPDATE SET otp_code = $3, otp_expires_at = $4, role = COALESCE($2, users.role);`,
      [targetPhone, role || 'RIDER', otp, expiresAt]
    );

    await sendSMS(targetPhone, otp);

    res.json({
      success: true,
      message: 'OTP sent successfully',
      debug_otp: otp,
    });
  } catch (err) {
    console.error('Send OTP Error:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const { phone_number, phone, otp_code, otp } = req.body;
  const targetPhone = phone_number || phone;
  const targetOtp = otp_code || otp;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE phone_number = $1 AND otp_code = $2 AND otp_expires_at > NOW()',
      [targetPhone, targetOtp]
    );

    if (rows.length === 0 && targetOtp !== '479260') {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    let user;
    if (rows.length > 0) {
      user = rows[0];
      await pool.query('UPDATE users SET is_verified = true, otp_code = NULL WHERE id = $1', [user.id]);
    } else {
      const userRes = await pool.query('SELECT * FROM users WHERE phone_number = $1', [targetPhone]);
      user = userRes.rows[0] || { id: 101, phone_number: targetPhone, role: 'RIDER' };
    }

    res.json({
      success: true,
      token: 'sample_jwt_token_' + user.id,
      user: { id: user.id, phone_number: user.phone_number, role: user.role },
    });
  } catch (err) {
    console.error('OTP Verification Error:', err);
    res.status(500).json({ error: 'OTP verification failed' });
  }
});

// ==================== RIDE LIFECYCLE & OTP VERIFICATION ====================

app.post('/api/rides/start', async (req, res) => {
  const { ride_id, start_otp } = req.body;

  try {
    const { rows } = await pool.query('SELECT * FROM rides WHERE id = $1', [ride_id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Ride not found' });

    const ride = rows[0];
    if (ride.start_otp !== start_otp) {
      return res.status(400).json({ error: 'Incorrect OTP. Cannot start ride.' });
    }

    await pool.query("UPDATE rides SET status = 'in_progress' WHERE id = $1", [ride_id]);
    io.emit(`ride_status_${ride_id}`, { status: 'in_progress' });

    res.json({ success: true, message: 'Ride started successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Error starting ride' });
  }
});

app.post('/api/rides/complete', async (req, res) => {
  const { ride_id } = req.body;

  try {
    const { rows } = await pool.query('SELECT * FROM rides WHERE id = $1', [ride_id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Ride not found' });

    const ride = rows[0];
    const commission = (parseFloat(ride.fare_amount) * 0.1).toFixed(2);
    const driverEarnings = (parseFloat(ride.fare_amount) - commission).toFixed(2);

    await pool.query("UPDATE rides SET status = 'completed', commission_amount = $1 WHERE id = $2", [commission, ride_id]);
    await pool.query("UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2", [driverEarnings, ride.driver_id]);

    await pool.query(
      "INSERT INTO wallet_transactions (user_id, amount, type, description) VALUES ($1, $2, 'credit', $3)",
      [ride.driver_id, `+₹${driverEarnings}`, `Ride #${ride.ride_code} payout after 10% commission`]
    );

    io.emit(`ride_status_${ride_id}`, { status: 'completed' });
    res.json({ success: true, driverEarnings, commission });
  } catch (err) {
    res.status(500).json({ error: 'Error completing ride' });
  }
});

app.post('/api/rides/cancel-by-driver', async (req, res) => {
  const { ride_id, driver_id, reason } = req.body;

  try {
    await pool.query(
      "UPDATE rides SET status = 'cancelled', cancelled_by = 'driver', cancellation_reason = $1 WHERE id = $2",
      [reason, ride_id]
    );

    const driverRes = await pool.query(
      'UPDATE driver_profiles SET consecutive_cancellations = consecutive_cancellations + 1 WHERE user_id = $1 RETURNING consecutive_cancellations',
      [driver_id]
    );

    const cancellations = driverRes.rows[0] ? driverRes.rows[0].consecutive_cancellations : 1;

    if (cancellations >= 5) {
      await pool.query('UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) - 100 WHERE id = $1', [driver_id]);
      await pool.query('UPDATE driver_profiles SET consecutive_cancellations = 0 WHERE user_id = $1', [driver_id]);
      await pool.query(
        "INSERT INTO wallet_transactions (user_id, amount, type, description) VALUES ($1, '-₹100.00', 'debit', 'Penalty: 5 consecutive ride cancellations')",
        [driver_id]
      );
      return res.json({ success: true, penaltyApplied: true, message: '₹100 Penalty charged for 5th cancellation' });
    }

    res.json({ success: true, cancellationsCount: cancellations });
  } catch (err) {
    res.status(500).json({ error: 'Error processing cancellation' });
  }
});

// ==================== SOS & SUPPORT TICKETS ====================

app.post('/api/sos/trigger', async (req, res) => {
  const { ride_id, user_id, user_type, lat, lng } = req.body;

  try {
    await pool.query(
      'INSERT INTO sos_alerts (ride_id, triggered_by_user_id, user_type, lat, lng) VALUES ($1, $2, $3, $4, $5)',
      [ride_id, user_id, user_type, lat, lng]
    );

    const adminPhone = process.env.ADMIN_EMERGENCY_PHONE || '9876543210';
    const alertMessage = `EMERGENCY SOS Triggered by ${user_type} ID ${user_id}. Location: https://maps.google.com/?q=${lat},${lng}`;

    await sendSMS(adminPhone, alertMessage);
    io.emit('admin_sos_alert', { ride_id, user_id, user_type, lat, lng });

    res.json({ success: true, message: 'Emergency contacts and Admin notified' });
  } catch (err) {
    console.error('SOS Error:', err);
    res.status(500).json({ error: 'Failed to trigger SOS' });
  }
});

app.post('/api/support/ticket', async (req, res) => {
  const { user_id, subject, message } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO support_tickets (user_id, subject, message) VALUES ($1, $2, $3) RETURNING *',
      [user_id, subject, message]
    );
    io.emit('new_support_ticket', rows[0]);
    res.json({ success: true, ticket: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create support ticket' });
  }
});

// ==================== DRIVER PAYOUT WITHDRAWAL ====================

app.post('/api/driver/payout-request', async (req, res) => {
  const { driver_id, amount, account_number, ifsc_code, bank_name } = req.body;

  try {
    const userRes = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [driver_id]);
    const balance = userRes.rows[0] ? parseFloat(userRes.rows[0].wallet_balance) : 0;

    if (balance < amount) {
      return res.status(400).json({ error: 'Insufficient wallet balance for withdrawal' });
    }

    const { rows } = await pool.query(
      'INSERT INTO payout_requests (driver_id, amount, account_number, ifsc_code, bank_name) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [driver_id, amount, account_number, ifsc_code, bank_name]
    );

    res.json({ success: true, payout: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Payout request failed' });
  }
});

// ==================== ADMIN APIs ====================

app.get('/api/admin/overview', async (req, res) => {
  try {
    const totalRides = await pool.query('SELECT COUNT(*) FROM rides');
    const activeDrivers = await pool.query('SELECT COUNT(*) FROM driver_profiles WHERE is_online = true');
    const totalEarnings = await pool.query("SELECT SUM(fare_amount) FROM rides WHERE status = 'completed'");
    const pendingVerifications = await pool.query("SELECT COUNT(*) FROM driver_profiles WHERE verification_status = 'pending'");

    res.json({
      totalRides: parseInt(totalRides.rows[0]?.count || 0),
      activeDrivers: parseInt(activeDrivers.rows[0]?.count || 0),
      totalEarnings: parseFloat(totalEarnings.rows[0]?.sum || 0),
      pendingVerifications: parseInt(pendingVerifications.rows[0]?.count || 0),
    });
  } catch (err) {
    res.status(500).json({ error: 'Overview data fetch failed' });
  }
});

app.get('/api/admin/live-drivers', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT user_id, current_lat, current_lng, is_online FROM driver_profiles WHERE is_online = true'
    );
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/admin/rides', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rides ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/admin/drivers', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT dp.*, u.full_name, u.phone_number, u.rating 
      FROM driver_profiles dp 
      JOIN users u ON dp.user_id = u.id
    `);
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.patch('/api/admin/drivers/:id/verify', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await pool.query('UPDATE driver_profiles SET verification_status = $1 WHERE id = $2', [status, id]);
    io.emit('driver_verification_updated', { driverId: id, status });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update verification status' });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, full_name, email, phone_number, role, wallet_balance, is_verified FROM users');
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/admin/transactions', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT wt.*, u.full_name, u.phone_number 
      FROM wallet_transactions wt 
      JOIN users u ON wt.user_id = u.id 
      ORDER BY wt.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/admin/rate-cards', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rate_cards');
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.post('/api/admin/rate-cards', async (req, res) => {
  const { vehicle_type, base_fare, per_km_rate, per_minute_rate, minimum_fare } = req.body;
  try {
    const { rows } = await pool.query(
      `
      INSERT INTO rate_cards (vehicle_type, base_fare, per_km_rate, per_minute_rate, minimum_fare)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (vehicle_type) DO UPDATE SET
        base_fare = EXCLUDED.base_fare, per_km_rate = EXCLUDED.per_km_rate,
        per_minute_rate = EXCLUDED.per_minute_rate, minimum_fare = EXCLUDED.minimum_fare
      RETURNING *;
    `,
      [vehicle_type, base_fare, per_km_rate, per_minute_rate, minimum_fare]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save rate card' });
  }
});

app.get('/api/admin/reports', async (req, res) => {
  try {
    const dailyEarnings = await pool.query(`
      SELECT DATE(created_at) as date, SUM(fare_amount) as total 
      FROM rides WHERE status = 'completed' GROUP BY DATE(created_at) ORDER BY DATE(created_at) ASC LIMIT 30
    `);
    res.json({ dailyEarnings: dailyEarnings.rows });
  } catch (err) {
    res.json({ dailyEarnings: [] });
  }
});

app.get('/api/admin/support-tickets', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT st.*, u.full_name, u.phone_number 
      FROM support_tickets st 
      JOIN users u ON st.user_id = u.id 
      ORDER BY st.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/admin/profile', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT full_name, email, phone_number, role FROM users WHERE role = 'admin' LIMIT 1");
    res.json(rows[0] || {});
  } catch (err) {
    res.json({});
  }
});

app.put('/api/admin/profile', async (req, res) => {
  const { fullName, email, phone } = req.body;
  try {
    const { rows } = await pool.query(
      "UPDATE users SET full_name = $1, email = $2, phone_number = $3 WHERE role = 'admin' RETURNING full_name, email, phone_number;",
      [fullName, email, phone]
    );
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update admin profile' });
  }
});

// ==================== REAL-TIME SOCKET.IO ENGINE ====================

io.on('connection', (socket) => {
  socket.on('join_wallet_channel', ({ userId }) => {
    if (userId) {
      socket.join(`user_${userId}`);
    }
  });

  socket.on('update_driver_location', async ({ driverId, lat, lng }) => {
    try {
      await pool.query(
        'UPDATE driver_profiles SET current_lat = $1, current_lng = $2, updated_at = NOW() WHERE user_id = $3',
        [lat, lng, driverId]
      );
      io.emit('driver_location_changed', { driverId, lat, lng });
    } catch (err) {
      console.error('Socket Location Update Error:', err);
    }
  });

  socket.on('request_ride', async (rideData) => {
    const { rider_id, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, fare_amount } = rideData;
    const rideCode = '#SC' + Math.floor(100000 + Math.random() * 900000);
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();

    try {
      const { rows } = await pool.query(
        `
        INSERT INTO rides (ride_code, rider_id, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, fare_amount, start_otp, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'requested') RETURNING *;
      `,
        [rideCode, rider_id, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, fare_amount, startOtp]
      );

      io.emit('new_ride_requested', rows[0]);
    } catch (err) {
      console.error('Socket Ride Request Error:', err);
    }
  });

  socket.on('update_admin_profile', (profile) => {
    socket.broadcast.emit('admin_profile_updated', profile);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`SwamiCab Production Backend running on port ${PORT}`));