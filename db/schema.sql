CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NULL,
  role VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS leads (
  id VARCHAR(64) PRIMARY KEY,
  company_name VARCHAR(255) NOT NULL,
  contact_name VARCHAR(255) NULL,
  email VARCHAR(255) NULL,
  phone VARCHAR(100) NULL,
  street VARCHAR(255) NULL,
  house_number VARCHAR(100) NULL,
  postal_code VARCHAR(100) NULL,
  city VARCHAR(100) NULL,
  country VARCHAR(100) NULL DEFAULT 'China',
  social_credit_code VARCHAR(64) NULL,
  website VARCHAR(255) NULL,
  company_profile TEXT NULL,
  brand_json JSON NULL,
  address VARCHAR(500) NULL,
  source VARCHAR(100) NULL,
  priority VARCHAR(20) NULL,
  owner_id VARCHAR(64) NULL,
  workflow_stage VARCHAR(40) NOT NULL DEFAULT '已导入',
  brochure_sent_count INT NOT NULL DEFAULT 0,
  visit_count INT NOT NULL DEFAULT 0,
  last_visit_at DATETIME NULL,
  next_visit_reminder DATETIME NULL,
  brochure_limit_days INT NOT NULL DEFAULT 30,
  brochure_limit_count INT NOT NULL DEFAULT 2,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uk_social_credit_code (social_credit_code),
  INDEX idx_leads_stage (workflow_stage),
  INDEX idx_leads_source (source),
  INDEX idx_leads_owner (owner_id),
  INDEX idx_leads_city (city),
  INDEX idx_leads_reminder (next_visit_reminder)
);

CREATE TABLE IF NOT EXISTS lead_activity_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  lead_id VARCHAR(64) NOT NULL,
  activity_type VARCHAR(40) NOT NULL,
  note TEXT NULL,
  operator_id VARCHAR(64) NULL,
  metadata_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lead_activity_lead (lead_id),
  INDEX idx_lead_activity_type (activity_type),
  INDEX idx_lead_activity_created (created_at)
);

CREATE TABLE IF NOT EXISTS lead_files (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  lead_id VARCHAR(64) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_url VARCHAR(500) NOT NULL,
  file_type VARCHAR(80) NULL,
  operator_id VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lead_files_lead (lead_id)
);

CREATE TABLE IF NOT EXISTS workflow_stage_history (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  lead_id VARCHAR(64) NOT NULL,
  from_stage VARCHAR(40) NULL,
  to_stage VARCHAR(40) NOT NULL,
  operator_id VARCHAR(64) NULL,
  note VARCHAR(500) NULL,
  created_at DATETIME NOT NULL,
  INDEX idx_wsh_lead (lead_id)
);

CREATE TABLE IF NOT EXISTS lead_followups (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  lead_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NULL,
  channel VARCHAR(40) NOT NULL,
  content TEXT NOT NULL,
  result VARCHAR(40) NULL,
  created_at DATETIME NOT NULL,
  INDEX idx_followups_lead (lead_id),
  INDEX idx_followups_result (result)
);

CREATE TABLE IF NOT EXISTS campaign_batches (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  template_name VARCHAR(255) NULL,
  note VARCHAR(500) NULL,
  status VARCHAR(40) NOT NULL,
  operator_id VARCHAR(64) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_batch_items (
  id VARCHAR(64) PRIMARY KEY,
  batch_id VARCHAR(64) NOT NULL,
  lead_id VARCHAR(64) NOT NULL,
  shipment_id VARCHAR(64) NULL,
  yto_order_no VARCHAR(100) NULL,
  push_status VARCHAR(40) NULL,
  push_error VARCHAR(500) NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uk_batch_lead (batch_id, lead_id),
  INDEX idx_batch_items_batch (batch_id),
  INDEX idx_batch_items_lead (lead_id)
);

CREATE TABLE IF NOT EXISTS shipments (
  id VARCHAR(64) PRIMARY KEY,
  lead_id VARCHAR(64) NOT NULL,
  carrier VARCHAR(40) NOT NULL,
  waybill_no VARCHAR(80) NULL,
  push_status VARCHAR(40) NOT NULL,
  logistics_status VARCHAR(40) NOT NULL,
  receiver_name VARCHAR(255) NULL,
  receiver_phone VARCHAR(100) NULL,
  receiver_country VARCHAR(100) NULL,
  receiver_address VARCHAR(500) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  INDEX idx_shipments_lead (lead_id),
  INDEX idx_shipments_status (logistics_status),
  INDEX idx_shipments_push (push_status)
);

CREATE TABLE IF NOT EXISTS shipment_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  shipment_id VARCHAR(64) NOT NULL,
  event_time DATETIME NULL,
  status VARCHAR(60) NULL,
  description VARCHAR(500) NULL,
  location VARCHAR(255) NULL,
  created_at DATETIME NOT NULL,
  INDEX idx_shipment_events_sid (shipment_id)
);

CREATE TABLE IF NOT EXISTS courier_integrations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  courier_code VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL,
  base_url VARCHAR(255) NOT NULL,
  app_key VARCHAR(255) NOT NULL,
  app_secret VARCHAR(255) NOT NULL,
  customer_code VARCHAR(128) NULL,
  enabled TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_courier_code (courier_code)
);

CREATE TABLE IF NOT EXISTS courier_api_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  courier_code VARCHAR(32) NOT NULL,
  biz_type VARCHAR(32) NOT NULL,
  biz_id VARCHAR(64) NOT NULL,
  request_url VARCHAR(255) NOT NULL,
  request_body JSON NULL,
  response_body JSON NULL,
  http_status INT NULL,
  success TINYINT NOT NULL DEFAULT 0,
  error_message VARCHAR(500) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_courier_api_biz (courier_code, biz_type, biz_id),
  INDEX idx_courier_api_created_at (created_at)
);

INSERT IGNORE INTO users (id, username, role, status) VALUES ('u_admin_001', 'admin', 'Admin', 'active');
INSERT IGNORE INTO users (id, username, role, status) VALUES ('u_super_001', 'supervisor', 'Supervisor', 'active');
INSERT IGNORE INTO users (id, username, role, status) VALUES ('u_emp_001', 'employee', 'Salesperson', 'active');
