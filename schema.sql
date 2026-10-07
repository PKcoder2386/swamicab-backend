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
    saved_home TEXT,
    saved_work TEXT,
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

-- Driver Document Upload Management
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
    lat NUMERIC(10,8) DEFAULT 0.0,
    lng NUMERIC(11,8) DEFAULT 0.0,
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

-- Support & Help Desk
CREATE TABLE IF NOT EXISTS support_tickets (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    subject VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(20) CHECK (status IN ('open', 'in_progress', 'resolved')) DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Admin Platform Settings
CREATE TABLE IF NOT EXISTS admin_settings (
    id SERIAL PRIMARY KEY,
    app_name VARCHAR(255) DEFAULT 'SwamiCab',
    support_email VARCHAR(255) DEFAULT 'support@swamicab.com',
    currency VARCHAR(50) DEFAULT 'INR (₹)',
    time_zone VARCHAR(100) DEFAULT 'Asia/Kolkata',
    commission_percentage NUMERIC(5,2) DEFAULT 10.00,
    base_booking_fee NUMERIC(10,2) DEFAULT 15.00,
    cancellation_fee NUMERIC(10,2) DEFAULT 30.00,
    driver_payout_cycle VARCHAR(50) DEFAULT 'Weekly',
    account_holder_name VARCHAR(255) DEFAULT '',
    account_number VARCHAR(100) DEFAULT '',
    ifsc_code VARCHAR(20) DEFAULT '',
    bank_name VARCHAR(100) DEFAULT 'HDFC Bank',
    upiId VARCHAR(255) DEFAULT '',
    auto_commission_routing BOOLEAN DEFAULT TRUE,
    two_factor_enabled BOOLEAN DEFAULT FALSE,
    api_key VARCHAR(255) DEFAULT 'sc_live_984729384729384',
    webhook_url TEXT DEFAULT 'https://api.swamicab.com/webhooks/v1',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Performance Optimization Indexes
CREATE INDEX IF NOT EXISTS idx_driver_withdrawals_status ON driver_withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_saved_places_user ON saved_places(user_id);