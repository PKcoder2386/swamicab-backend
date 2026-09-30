-- Core Users Table (Riders, Drivers, Admins)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(15) UNIQUE NOT NULL,
    full_name VARCHAR(100),
    email VARCHAR(100) UNIQUE,
    role VARCHAR(20) CHECK (role IN ('rider', 'driver', 'admin')) DEFAULT 'rider',
    otp_code VARCHAR(6),
    otp_expires_at TIMESTAMP,
    is_verified BOOLEAN DEFAULT FALSE,
    wallet_balance NUMERIC(10,2) DEFAULT 0.00,
    rating NUMERIC(3,2) DEFAULT 5.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver Profile & Verification Pipeline
CREATE TABLE IF NOT EXISTS driver_profiles (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    license_number VARCHAR(50),
    vehicle_number VARCHAR(50),
    vehicle_type VARCHAR(30) DEFAULT 'Sedan',
    verification_status VARCHAR(20) CHECK (verification_status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
    is_online BOOLEAN DEFAULT FALSE,
    consecutive_cancellations INT DEFAULT 0,
    current_lat NUMERIC(10,8),
    current_lng NUMERIC(11,8),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Rides Management
CREATE TABLE IF NOT EXISTS rides (
    id SERIAL PRIMARY KEY,
    ride_code VARCHAR(20) UNIQUE NOT NULL,
    rider_id INT REFERENCES users(id),
    driver_id INT REFERENCES users(id),
    pickup_address TEXT NOT NULL,
    dropoff_address TEXT NOT NULL,
    pickup_lat NUMERIC(10,8),
    pickup_lng NUMERIC(11,8),
    dropoff_lat NUMERIC(10,8),
    dropoff_lng NUMERIC(11,8),
    fare_amount NUMERIC(10,2) NOT NULL,
    commission_amount NUMERIC(10,2) DEFAULT 0.00,
    status VARCHAR(20) CHECK (status IN ('requested', 'accepted', 'arrived', 'in_progress', 'completed', 'cancelled')) DEFAULT 'requested',
    start_otp VARCHAR(4),
    cancelled_by VARCHAR(10) CHECK (cancelled_by IN ('rider', 'driver')),
    cancellation_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Rate Card Manager
CREATE TABLE IF NOT EXISTS rate_cards (
    id SERIAL PRIMARY KEY,
    vehicle_type VARCHAR(50) UNIQUE NOT NULL,
    base_fare NUMERIC(8,2) NOT NULL,
    per_km_rate NUMERIC(8,2) NOT NULL,
    per_minute_rate NUMERIC(8,2) NOT NULL,
    minimum_fare NUMERIC(8,2) NOT NULL
);

-- Wallet & Payments (Updated with status column)
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    amount NUMERIC(10,2) NOT NULL,
    type VARCHAR(20) CHECK (type IN ('credit', 'debit')),
    description TEXT,
    status VARCHAR(20) DEFAULT 'Completed',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Support & Help Desk
CREATE TABLE IF NOT EXISTS support_tickets (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    subject VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(20) CHECK (status IN ('open', 'in_progress', 'resolved')) DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Admin System Settings
CREATE TABLE IF NOT EXISTS admin_settings (
    id SERIAL PRIMARY KEY,
    account_holder_name VARCHAR(255),
    account_number VARCHAR(100),
    ifsc_code VARCHAR(50),
    bank_name VARCHAR(100),
    upi_id VARCHAR(100),
    auto_commission_routing BOOLEAN DEFAULT TRUE,
    commission_percentage NUMERIC(5,2) DEFAULT 10.00,
    two_factor_enabled BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- SOS Alerts Tracking
CREATE TABLE IF NOT EXISTS sos_alerts (
    id SERIAL PRIMARY KEY,
    ride_id INT REFERENCES rides(id) ON DELETE CASCADE,
    triggered_by_user_id INT REFERENCES users(id),
    user_type VARCHAR(10) CHECK (user_type IN ('rider', 'driver')),
    lat NUMERIC(10,8),
    lng NUMERIC(11,8),
    status VARCHAR(20) DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver Bank Payout Requests
CREATE TABLE IF NOT EXISTS payout_requests (
    id SERIAL PRIMARY KEY,
    driver_id INT REFERENCES users(id),
    amount NUMERIC(10,2) NOT NULL,
    account_number VARCHAR(50),
    ifsc_code VARCHAR(20),
    bank_name VARCHAR(100),
    status VARCHAR(20) CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')) DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);