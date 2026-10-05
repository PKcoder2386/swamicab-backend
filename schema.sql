-- Core Users Table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    full_name VARCHAR(255),
    email VARCHAR(255) UNIQUE,
    dob VARCHAR(50),
    gender VARCHAR(20),
    emergency_contact VARCHAR(20),
    role VARCHAR(20) CHECK (role IN ('rider', 'driver', 'admin')) DEFAULT 'rider',
    otp_code VARCHAR(6),
    otp_hash VARCHAR(255),
    otp_expires_at TIMESTAMP,
    otp_attempts INT DEFAULT 0,
    is_verified BOOLEAN DEFAULT TRUE,
    wallet_balance NUMERIC(10,2) DEFAULT 0.00,
    rating NUMERIC(3,2) DEFAULT 5.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver Profile & Verification
CREATE TABLE IF NOT EXISTS driver_profiles (
    user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    dob VARCHAR(50),
    profile_photo_uri TEXT,
    license_number VARCHAR(50),
    vehicle_model VARCHAR(255),
    vehicle_number VARCHAR(100),
    vehicle_type VARCHAR(100) DEFAULT 'Cab',
    verification_status VARCHAR(20) CHECK (verification_status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
    approval_status VARCHAR(50) DEFAULT 'pending',
    rating NUMERIC(3,2) DEFAULT 5.00,
    is_online BOOLEAN DEFAULT FALSE,
    consecutive_cancellations INT DEFAULT 0,
    current_lat NUMERIC(10,8),
    current_lng NUMERIC(11,8),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver Document Upload Management (Aligned with server.js dynamic uploads)
CREATE TABLE IF NOT EXISTS driver_documents (
    id SERIAL PRIMARY KEY,
    driver_id INT REFERENCES users(id) ON DELETE CASCADE,
    doc_type VARCHAR(100),
    file_path TEXT,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver Bank Details (For Payouts)
CREATE TABLE IF NOT EXISTS driver_bank_details (
    driver_id VARCHAR(255) PRIMARY KEY,
    account_holder_name VARCHAR(255),
    account_number VARCHAR(100),
    ifsc_code VARCHAR(20),
    bank_name VARCHAR(100),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver Withdrawals / Payouts Queue
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

-- Saved Places (Home, Work, Favorites)
CREATE TABLE IF NOT EXISTS saved_places (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(50) NOT NULL,
    address TEXT NOT NULL,
    lat NUMERIC(10,8) NOT NULL,
    lng NUMERIC(11,8) NOT NULL,
    type VARCHAR(20) CHECK (type IN ('home', 'work', 'favorite')) DEFAULT 'favorite',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- In-App Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(150) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User App Preferences & Settings
CREATE TABLE IF NOT EXISTS user_settings (
    user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    language VARCHAR(10) DEFAULT 'en',
    push_enabled BOOLEAN DEFAULT TRUE,
    sms_enabled BOOLEAN DEFAULT TRUE,
    dark_mode BOOLEAN DEFAULT FALSE
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
    total_fare NUMERIC(10,2) DEFAULT 0.00,
    commission_amount NUMERIC(10,2) DEFAULT 0.00,
    distance_km NUMERIC(8,2) DEFAULT 0.00,
    incentive_amount NUMERIC(10,2) DEFAULT 0.00,
    surge_amount NUMERIC(10,2) DEFAULT 0.00,
    status VARCHAR(20) CHECK (status IN ('requested', 'accepted', 'arrived', 'in_progress', 'completed', 'cancelled')) DEFAULT 'requested',
    start_otp VARCHAR(4),
    cancelled_by VARCHAR(10) CHECK (cancelled_by IN ('rider', 'driver')),
    cancellation_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Wallet & Transactions
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

-- Rate Card Manager
CREATE TABLE IF NOT EXISTS rate_cards (
    id SERIAL PRIMARY KEY,
    vehicle_type VARCHAR(50) UNIQUE NOT NULL,
    base_fare NUMERIC(8,2) NOT NULL,
    per_km_rate NUMERIC(8,2) NOT NULL,
    per_minute_rate NUMERIC(8,2) NOT NULL,
    minimum_fare NUMERIC(8,2) NOT NULL
);

-- SOS Emergency Alerts
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

-- Driver Incentive Quests
CREATE TABLE IF NOT EXISTS driver_incentive_quests (
    id SERIAL PRIMARY KEY,
    driver_id INT REFERENCES users(id) ON DELETE CASCADE,
    week_start_date DATE NOT NULL,
    completed_trips INT DEFAULT 0,
    target_trips INT DEFAULT 50,
    current_bonus NUMERIC(10,2) DEFAULT 0.00,
    total_surge_earned NUMERIC(10,2) DEFAULT 0.00,
    peak_hours_logged NUMERIC(5,2) DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver Bonus Logs
CREATE TABLE IF NOT EXISTS driver_bonus_logs (
    id SERIAL PRIMARY KEY,
    driver_id INT REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(150) NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    type VARCHAR(50) DEFAULT 'bonus',
    date_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Wallet Deductions
CREATE TABLE IF NOT EXISTS wallet_deductions (
    id SERIAL PRIMARY KEY,
    driver_id INT REFERENCES users(id) ON DELETE CASCADE,
    ride_id INT REFERENCES rides(id) ON DELETE SET NULL,
    platform_fee_amount NUMERIC(10,2) NOT NULL,
    description TEXT,
    date_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Performance Optimization Indexes
CREATE INDEX IF NOT EXISTS idx_rides_driver_status ON rides(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_driver_quests_date ON driver_incentive_quests(driver_id, week_start_date);
CREATE INDEX IF NOT EXISTS idx_wallet_deductions_driver ON wallet_deductions(driver_id);