-- Additive MariaDB 10.6 migration. No legacy status inference or initialization.
CREATE TABLE IF NOT EXISTS marketing_migrations (version varchar(80) PRIMARY KEY, applied_at datetime NOT NULL DEFAULT current_timestamp()) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS important_flag tinyint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS mailing_plans (
 lead_id bigint unsigned PRIMARY KEY, enabled tinyint NOT NULL DEFAULT 0,
 months int unsigned NOT NULL DEFAULT 1, next_at datetime NULL,
 timezone varchar(64) NOT NULL DEFAULT 'Europe/Berlin', reminder_days int unsigned NOT NULL DEFAULT 3,
 owner_id bigint unsigned NULL, paused tinyint NOT NULL DEFAULT 0, pause_reason varchar(500) NULL,
 version int unsigned NOT NULL DEFAULT 1, manual_next tinyint NOT NULL DEFAULT 1,
 updated_at datetime NOT NULL DEFAULT current_timestamp(), INDEX idx_due(enabled,paused,next_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS marketing_audit (
 id bigint unsigned AUTO_INCREMENT PRIMARY KEY, lead_id bigint unsigned NULL, user_id bigint unsigned NULL,
 action varchar(64) NOT NULL, reason varchar(1000) NULL, before_json longtext NULL, after_json longtext NULL,
 created_at datetime NOT NULL DEFAULT current_timestamp(), INDEX idx_audit_lead(lead_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE todo_tasks MODIFY owner_user_id bigint NULL;
ALTER TABLE todo_tasks ADD COLUMN IF NOT EXISTS dedupe_key varchar(160) NULL;
ALTER TABLE todo_tasks ADD COLUMN IF NOT EXISTS shipment_id bigint unsigned NULL;
ALTER TABLE todo_tasks ADD COLUMN IF NOT EXISTS plan_version int unsigned NULL;
ALTER TABLE todo_tasks ADD COLUMN IF NOT EXISTS resolved_at datetime NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uk_todo_dedupe ON todo_tasks(dedupe_key);
ALTER TABLE campaign_batch_items ADD COLUMN IF NOT EXISTS plan_version int unsigned NULL;
CREATE TABLE IF NOT EXISTS mailing_reservations (
 lead_id bigint unsigned PRIMARY KEY, batch_id bigint unsigned NOT NULL, plan_version int unsigned NULL,
 created_at datetime NOT NULL DEFAULT current_timestamp(), INDEX idx_res_batch(batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS order_succeeded_at datetime NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS dispatched_at datetime NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS dispatch_evidence varchar(1000) NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS dispatch_source varchar(32) NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS signed_observed_at datetime NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS confirmed_received_at datetime NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS original_shipment_id bigint unsigned NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS released_for_mailing_at datetime NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS query_status varchar(32) NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS track_fact_status varchar(32) NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS last_query_json longtext NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS latest_event_at datetime NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS latest_event_desc text NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS sign_receive_type varchar(64) NULL;
CREATE INDEX IF NOT EXISTS idx_ship_lead_dispatch ON shipments(lead_id,dispatched_at);
CREATE INDEX IF NOT EXISTS idx_ship_signed ON shipments(lead_id,signed_at);
CREATE INDEX IF NOT EXISTS idx_batch_item_date ON campaign_batch_items(created_at,lead_id,batch_id);
CREATE TABLE IF NOT EXISTS mailing_events (
 id bigint unsigned AUTO_INCREMENT PRIMARY KEY, lead_id bigint unsigned NOT NULL,
 shipment_id bigint unsigned NOT NULL, event_type varchar(32) NOT NULL,
 event_key varchar(160) NOT NULL, event_at datetime NULL, observed_at datetime NOT NULL,
 evidence varchar(1000) NULL, is_resend tinyint NOT NULL DEFAULT 0,
 UNIQUE KEY uk_mail_event(event_type,event_key), INDEX idx_mail_count(lead_id,event_type,event_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS mailing_exceptions (
 id bigint unsigned AUTO_INCREMENT PRIMARY KEY, lead_id bigint unsigned NOT NULL, shipment_id bigint unsigned NOT NULL,
 kind varchar(48) NOT NULL, owner_id bigint unsigned NULL, status varchar(16) NOT NULL DEFAULT 'open',
 blocking tinyint NOT NULL DEFAULT 0, reason varchar(1000) NOT NULL, note text NULL,
 attachment varchar(500) NULL, resolved_at datetime NULL, created_at datetime NOT NULL DEFAULT current_timestamp(),
 UNIQUE KEY uk_exception(shipment_id,kind), INDEX idx_exception_lead(lead_id,status,blocking)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE INDEX IF NOT EXISTS idx_mail_event_date ON mailing_events(event_at,event_type,lead_id);
CREATE TABLE IF NOT EXISTS ai_sessions (
 id varchar(36) PRIMARY KEY, user_id bigint unsigned NOT NULL, title varchar(160) NOT NULL,
 created_at datetime NOT NULL DEFAULT current_timestamp(), INDEX idx_ai_user(user_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ai_messages (
 id bigint unsigned AUTO_INCREMENT PRIMARY KEY, session_id varchar(36) NOT NULL, role varchar(16) NOT NULL,
 content mediumtext NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp(), INDEX idx_ai_message(session_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ai_runs (
 id varchar(36) PRIMARY KEY, session_id varchar(36) NOT NULL, user_id bigint unsigned NOT NULL,
 request_key varchar(80) NOT NULL, model varchar(100) NOT NULL, status varchar(24) NOT NULL,
 input_tokens int NOT NULL DEFAULT 0, output_tokens int NOT NULL DEFAULT 0, reserved_usd decimal(12,6) NOT NULL DEFAULT 0,
 error_code varchar(64) NULL, created_at datetime NOT NULL DEFAULT current_timestamp(),
 UNIQUE KEY uk_ai_request(user_id,request_key), INDEX idx_ai_budget(created_at,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ai_tool_audit (
 id bigint unsigned AUTO_INCREMENT PRIMARY KEY, run_id varchar(36) NOT NULL, name varchar(64) NOT NULL,
 args_json text NOT NULL, row_count int NOT NULL, evidence_json text NOT NULL,
 created_at datetime NOT NULL DEFAULT current_timestamp(), INDEX idx_ai_tool(run_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO marketing_migrations(version) VALUES ('20261112-marketing');
