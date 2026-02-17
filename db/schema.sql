CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  role VARCHAR(40) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS leads (
  id VARCHAR(64) PRIMARY KEY,
  company_name VARCHAR(255) NOT NULL,
  contact_name VARCHAR(255) NULL,
  email VARCHAR(255) NULL,
  phone VARCHAR(100) NULL,
  country VARCHAR(100) NULL,
  address VARCHAR(500) NULL,
  source VARCHAR(100) NULL,
  priority VARCHAR(20) NULL,
  owner_id VARCHAR(64) NULL,
  workflow_stage VARCHAR(40) NOT NULL DEFAULT '已导入',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  INDEX idx_leads_stage (workflow_stage),
  INDEX idx_leads_source (source),
  INDEX idx_leads_owner (owner_id)
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

INSERT IGNORE INTO users (id, username, role) VALUES ('u_admin_001', 'admin', 'Admin');
