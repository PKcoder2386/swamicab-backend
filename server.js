require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: process.env.PGUSER || 'postgres',
  host: process.env.PGHOST || 'localhost',
  database: process.env.PGDATABASE || 'swamicab_db',
  password: process.env.PGPASSWORD || 'Pranit@2386',
  port: process.env.PGPORT || 5432,
});

// Helper for Fast2SMS Gateway
const sendSMS = async (numbers, message) => {
  if (!process.env.FAST2SMS_API_KEY) return;
  try {
    await axios.post(
      'https://www.fast2sms.com/dev/bulkV2',
      {
        route: 'q',
        message: message,
        numbers: numbers,
      },
      {
        headers: { authorization: process.env.FAST2SMS_API_KEY },
      }
    );
  } catch (err) {
    console.error('SMS Gateway Error:', err.message);
  }
};

// ==================== AUTH & MOBILE OTP ====================

// Send OTP to Mobile App
app.post('/api/auth/send-otp', async (req, res) => {
  const { phone_number } = req.body;
  if (!phone_number) return res.status(400).json({ error: 'Phone number required' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 mins validity

  try {
    await pool.query(
      `INSERT INTO users (phone_number, otp_code, otp_expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone_number) 
       DO UPDATE SET otp_code = $2, otp_expires_at = $3;`,
      [phone_number, otp, expiresAt]
    );

    // Dispatch via Fast2SMS Gateway
    await sendSMS(phone_number, `Your SwamiCab verification OTP is: ${otp}`);

    res.json({ success: true, message: 'OTP sent successfully', debug_otp: otp });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Verify Mobile OTP
app.post('/api/auth/verify-otp', async (req, res) => {
  const { phone_number, otp_code } = req.body;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE phone_number = $1 AND otp_code = $2 AND otp_expires_at > NOW()',
      [phone_number, otp_code]
    );

    if (rows.length === 0) return res.status(400).json({ error: 'Invalid or expired OTP' });

    const user = rows[0];
    await pool.query('UPDATE users SET is_verified = true, otp_code = NULL WHERE id = $1', [user.id]);

    res.json({ success: true, user: { id: user.id, phone_number: user.phone_number, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: 'OTP verification failed' });
  }
});

// ==================== RIDE LIFECYCLE & OTP VERIFICATION ====================

// Start Ride with Customer's OTP
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

// Complete Ride & Deduct 10% Platform Commission
app.post('/api/rides/complete', async (req, res) => {
  const { ride_id } = req.body;

  try {
    const { rows } = await pool.query('SELECT * FROM rides WHERE id = $1', [ride_id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Ride not found' });

    const ride = rows[0];
    const commission = (parseFloat(ride.fare_amount) * 0.10).toFixed(2);
    const driverEarnings = (parseFloat(ride.fare_amount) - commission).toFixed(2);

    // Update Ride & Driver Wallet Balances
    await pool.query("UPDATE rides SET status = 'completed', commission_amount = $1 WHERE id = $2", [commission, ride_id]);
    await pool.query("UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2", [driverEarnings, ride.driver_id]);

    // Record Transaction Log
    await pool.query(
      "INSERT INTO wallet_transactions (user_id, amount, type, description) VALUES ($1, $2, 'credit', $3)",
      [ride.driver_id, driverEarnings, `Ride #${ride.ride_code} payout after 10% commission`]
    );

    io.emit(`ride_status_${ride_id}`, { status: 'completed' });
    res.json({ success: true, driverEarnings, commission });
  } catch (err) {
    res.status(500).json({ error: 'Error completing ride' });
  }
});

// Driver Cancellation Penalty Check (₹100 Penalty on 5th Cancellation)
app.post('/api/rides/cancel-by-driver', async (req, res) => {
  const { ride_id, driver_id, reason } = req.body;

  try {
    await pool.query(
      "UPDATE rides SET status = 'cancelled', cancelled_by = 'driver', cancellation_reason = $1 WHERE id = $2",
      [reason, ride_id]
    );

    // Increment driver's cancellation counter
    const driverRes = await pool.query(
      "UPDATE driver_profiles SET consecutive_cancellations = consecutive_cancellations + 1 WHERE user_id = $1 RETURNING consecutive_cancellations",
      [driver_id]
    );

    const cancellations = driverRes.rows[0].consecutive_cancellations;

    if (cancellations >= 5) {
      // Deduct ₹100 Penalty and Reset Counter
      await pool.query("UPDATE users SET wallet_balance = wallet_balance - 100 WHERE id = $1", [driver_id]);
      await pool.query("UPDATE driver_profiles SET consecutive_cancellations = 0 WHERE user_id = $1", [driver_id]);
      await pool.query(
        "INSERT INTO wallet_transactions (user_id, amount, type, description) VALUES ($1, 100, 'debit', 'Penalty: 5 consecutive ride cancellations')",
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
    const alertMessage = `EMERGENCY ALERT: SOS triggered by ${user_type} (ID: ${user_id}) on Ride #${ride_id}. Location: https://maps.google.com/?q=${lat},${lng}`;

    await sendSMS(adminPhone, alertMessage);
    io.emit('admin_sos_alert', { ride_id, user_id, user_type, lat, lng });

    res.json({ success: true, message: 'Emergency contacts and Admin notified' });
  } catch (err) {
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
    const balance = parseFloat(userRes.rows[0].wallet_balance);

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

// ==================== ALL ADMIN MODULES APIs ====================

// 1. Dashboard Overview
app.get('/api/admin/overview', async (req, res) => {
  try {
    const totalRides = await pool.query('SELECT COUNT(*) FROM rides');
    const activeDrivers = await pool.query('SELECT COUNT(*) FROM driver_profiles WHERE is_online = true');
    const totalEarnings = await pool.query("SELECT SUM(fare_amount) FROM rides WHERE status = 'completed'");
    const pendingVerifications = await pool.query("SELECT COUNT(*) FROM driver_profiles WHERE verification_status = 'pending'");

    res.json({
      totalRides: parseInt(totalRides.rows[0].count),
      activeDrivers: parseInt(activeDrivers.rows[0].count),
      totalEarnings: parseFloat(totalEarnings.rows[0].sum || 0),
      pendingVerifications: parseInt(pendingVerifications.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'Overview data fetch failed' });
  }
});

// 2. Live Tracking Active Drivers
app.get('/api/admin/live-drivers', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT user_id, current_lat, current_lng, is_online FROM driver_profiles WHERE is_online = true'
  );
  res.json(rows);
});

// 3. Rides Management
app.get('/api/admin/rides', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM rides ORDER BY created_at DESC');
  res.json(rows);
});

// 4. Driver Management & Verification Pipeline
app.get('/api/admin/drivers', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT dp.*, u.full_name, u.phone_number, u.rating 
    FROM driver_profiles dp 
    JOIN users u ON dp.user_id = u.id
  `);
  res.json(rows);
});

app.patch('/api/admin/drivers/:id/verify', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  await pool.query('UPDATE driver_profiles SET verification_status = $1 WHERE id = $2', [status, id]);
  io.emit('driver_verification_updated', { driverId: id, status });
  res.json({ success: true });
});

// 5. Users Management
app.get('/api/admin/users', async (req, res) => {
  const { rows } = await pool.query('SELECT id, full_name, email, phone_number, role, wallet_balance, is_verified FROM users');
  res.json(rows);
});

// 6. Wallet & Payments
app.get('/api/admin/transactions', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT wt.*, u.full_name, u.phone_number 
    FROM wallet_transactions wt 
    JOIN users u ON wt.user_id = u.id 
    ORDER BY wt.created_at DESC
  `);
  res.json(rows);
});

// 7. Rate Card Manager
app.get('/api/admin/rate-cards', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM rate_cards');
  res.json(rows);
});

app.post('/api/admin/rate-cards', async (req, res) => {
  const { vehicle_type, base_fare, per_km_rate, per_minute_rate, minimum_fare } = req.body;
  const { rows } = await pool.query(`
    INSERT INTO rate_cards (vehicle_type, base_fare, per_km_rate, per_minute_rate, minimum_fare)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (vehicle_type) DO UPDATE SET
      base_fare = EXCLUDED.base_fare, per_km_rate = EXCLUDED.per_km_rate,
      per_minute_rate = EXCLUDED.per_minute_rate, minimum_fare = EXCLUDED.minimum_fare
    RETURNING *;
  `, [vehicle_type, base_fare, per_km_rate, per_minute_rate, minimum_fare]);
  res.json(rows[0]);
});

// 8. Reports & Analytics
app.get('/api/admin/reports', async (req, res) => {
  const dailyEarnings = await pool.query(`
    SELECT DATE(created_at) as date, SUM(fare_amount) as total 
    FROM rides WHERE status = 'completed' GROUP BY DATE(created_at) ORDER BY DATE(created_at) ASC LIMIT 30
  `);
  res.json({ dailyEarnings: dailyEarnings.rows });
});

// 9. Support & Help Desk
app.get('/api/admin/support-tickets', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT st.*, u.full_name, u.phone_number 
    FROM support_tickets st 
    JOIN users u ON st.user_id = u.id 
    ORDER BY st.created_at DESC
  `);
  res.json(rows);
});

// 10. Admin Profile APIs
app.get('/api/admin/profile', async (req, res) => {
  const { rows } = await pool.query("SELECT full_name, email, phone_number, role FROM users WHERE role = 'admin' LIMIT 1");
  res.json(rows[0] || {});
});

app.put('/api/admin/profile', async (req, res) => {
  const { fullName, email, phone } = req.body;
  const { rows } = await pool.query(
    "UPDATE users SET full_name = $1, email = $2, phone_number = $3 WHERE role = 'admin' RETURNING full_name, email, phone_number;",
    [fullName, email, phone]
  );
  res.json({ success: true, user: rows[0] });
});

// ==================== REAL-TIME SOCKET.IO ENGINE ====================

io.on('connection', (socket) => {
  // Driver Telemetry Location Streaming (Ola/Uber Engine)
  socket.on('update_driver_location', async ({ driverId, lat, lng }) => {
    await pool.query(
      'UPDATE driver_profiles SET current_lat = $1, current_lng = $2, updated_at = NOW() WHERE user_id = $3',
      [lat, lng, driverId]
    );
    io.emit('driver_location_changed', { driverId, lat, lng });
  });

  // Rider Booking Match Request (Generates 4-digit start_otp)
  socket.on('request_ride', async (rideData) => {
    const { rider_id, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, fare_amount } = rideData;
    const rideCode = '#SC' + Math.floor(100000 + Math.random() * 900000);
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();

    const { rows } = await pool.query(`
      INSERT INTO rides (ride_code, rider_id, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, fare_amount, start_otp, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'requested') RETURNING *;
    `, [rideCode, rider_id, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, fare_amount, startOtp]);

    io.emit('new_ride_requested', rows[0]);
  });

  // Real-Time Profile Updates Broadcast
  socket.on('update_admin_profile', (profile) => {
    socket.broadcast.emit('admin_profile_updated', profile);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`SwamiCab Production Backend running on port ${PORT}`));