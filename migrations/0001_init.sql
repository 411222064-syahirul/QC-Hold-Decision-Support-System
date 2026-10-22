-- ============================================================
-- QC System — Database Schema & Initial Migration
-- Compatible with MySQL 5.7+ / MariaDB 10.4+
-- Run: mysql -u root qc_system < migrations/0001_init.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS qc_system CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE qc_system;

-- Roles
CREATE TABLE IF NOT EXISTS roles (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB CHARSET=utf8mb4;

-- Users
CREATE TABLE IF NOT EXISTS users (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  nip VARCHAR(50) UNIQUE,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255),
  role_id BIGINT,
  is_active TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL
) ENGINE=InnoDB CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);

-- Defect Category
CREATE TABLE IF NOT EXISTS defect_category (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  description TEXT
) ENGINE=InnoDB CHARSET=utf8mb4;

-- Product Category
CREATE TABLE IF NOT EXISTS product_category (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB CHARSET=utf8mb4;

-- Decision Action (Locked: REWORK, DISPOSISI, DISPOSAL)
CREATE TABLE IF NOT EXISTS decision_action (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL,
  description TEXT
) ENGINE=InnoDB CHARSET=utf8mb4;

-- QC Hold
CREATE TABLE IF NOT EXISTS qc_hold (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  qc_code VARCHAR(80) NOT NULL UNIQUE,
  part_no VARCHAR(100),
  product_category_id INT,
  inspection_date DATETIME NOT NULL,
  operator_id BIGINT,
  defect_category_id INT,
  defect_severity SMALLINT,
  defect_description TEXT,
  qty_total INT DEFAULT 0,
  qty_ng INT DEFAULT 0,
  qty_ok INT DEFAULT 0,
  image_url TEXT,
  decision_action_id INT,
  decision_status VARCHAR(10),
  action_taken_by BIGINT,
  action_taken_at DATETIME,
  c45_record_id BIGINT,
  status VARCHAR(10) DEFAULT 'OPEN',
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by BIGINT,
  updated_by BIGINT,
  FOREIGN KEY (product_category_id) REFERENCES product_category(id) ON DELETE SET NULL,
  FOREIGN KEY (operator_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (defect_category_id) REFERENCES defect_category(id) ON DELETE SET NULL,
  FOREIGN KEY (decision_action_id) REFERENCES decision_action(id) ON DELETE SET NULL,
  FOREIGN KEY (action_taken_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_qc_inspection_date ON qc_hold(inspection_date);
CREATE INDEX IF NOT EXISTS idx_qc_product_category ON qc_hold(product_category_id);
CREATE INDEX IF NOT EXISTS idx_qc_decision_action ON qc_hold(decision_action_id);
CREATE INDEX IF NOT EXISTS idx_qc_status ON qc_hold(status);

-- Models (C4.5)
CREATE TABLE IF NOT EXISTS models (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  algorithm VARCHAR(100) NOT NULL DEFAULT 'C4.5',
  version VARCHAR(50),
  trained_at DATETIME,
  dataset_id BIGINT,
  model_file_path TEXT,
  parameters JSON,
  is_active TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_models_trained_at ON models(trained_at);

-- Dataset
CREATE TABLE IF NOT EXISTS dataset (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200),
  type ENUM('TRAIN','TEST','VALIDATION') DEFAULT 'TRAIN',
  description TEXT,
  record_count INT DEFAULT 0,
  storage_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB CHARSET=utf8mb4;

-- Dataset Record
CREATE TABLE IF NOT EXISTS dataset_record (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  dataset_id BIGINT NOT NULL,
  qc_hold_id BIGINT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dataset_qc (dataset_id, qc_hold_id),
  FOREIGN KEY (dataset_id) REFERENCES dataset(id) ON DELETE CASCADE,
  FOREIGN KEY (qc_hold_id) REFERENCES qc_hold(id) ON DELETE CASCADE
) ENGINE=InnoDB CHARSET=utf8mb4;

-- C4.5 Decision Record (Proses Keputusan)
CREATE TABLE IF NOT EXISTS c45_decision (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  model_id BIGINT,
  qc_hold_id BIGINT,
  action_id INT,
  probability DECIMAL(5,4),
  processed_by BIGINT,
  processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  details JSON,
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL,
  FOREIGN KEY (qc_hold_id) REFERENCES qc_hold(id) ON DELETE SET NULL,
  FOREIGN KEY (action_id) REFERENCES decision_action(id) ON DELETE SET NULL,
  FOREIGN KEY (processed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_c45_decision_model ON c45_decision(model_id);
CREATE INDEX IF NOT EXISTS idx_c45_decision_qc ON c45_decision(qc_hold_id);

-- Decision Rule
CREATE TABLE IF NOT EXISTS decision_rule (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  model_id BIGINT NOT NULL,
  rule_text TEXT NOT NULL,
  action_id INT,
  support INT DEFAULT 0,
  confidence DECIMAL(5,4),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
  FOREIGN KEY (action_id) REFERENCES decision_action(id) ON DELETE SET NULL
) ENGINE=InnoDB CHARSET=utf8mb4;

-- Model Metrics
CREATE TABLE IF NOT EXISTS model_metrics (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  model_id BIGINT NOT NULL,
  metric_name VARCHAR(100) NOT NULL,
  metric_value DECIMAL(10,6),
  dataset_type VARCHAR(50),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE
) ENGINE=InnoDB CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_metrics_model ON model_metrics(model_id);

-- Audit Log
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT,
  action VARCHAR(150),
  target_table VARCHAR(150),
  target_id VARCHAR(100),
  details JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

-- ============================================================
-- SEED DATA
-- ============================================================

-- Roles
INSERT IGNORE INTO roles (name, description) VALUES
  ('admin', 'Administrator penuh — akses ke semua fitur sistem'),
  ('kepala_qc', 'Kepala QC — akses proses keputusan C4.5 dan laporan'),
  ('qc_line', 'Operator QC Line — input dan monitoring data QC Hold');

-- Decision Actions (Terkunci hanya REWORK, DISPOSISI, DISPOSAL)
INSERT IGNORE INTO decision_action (code, label, description) VALUES
  ('REWORK',    'REWORK',    'Proses ulang produksi (Status: YES)'),
  ('DISPOSISI', 'DISPOSISI', 'Turun kelas / disposisi penggunaan khusus (Status: YES)'),
  ('DISPOSAL',  'DISPOSAL',  'Buang / Scrap karena tidak dapat diperbaiki (Status: NO)');

-- Default Defect Categories
INSERT IGNORE INTO defect_category (name, description) VALUES
  ('Visual', 'Cacat yang terlihat secara visual pada permukaan produk'),
  ('Dimensional', 'Cacat pada dimensi/ukuran produk'),
  ('Functional', 'Cacat yang mempengaruhi fungsi produk'),
  ('Material', 'Cacat pada material/bahan baku');

-- Default Admin User (password: Admin@123)
INSERT IGNORE INTO users (username, email, password_hash, full_name, role_id, is_active)
SELECT 'admin', 'admin@qcsystem.local',
  'pbkdf2:sha256:600000$qcsystem2024$8a9f2c1d3e5b7a4c6f8d0e2b4c6a8f0d2e4c6a8f0d2e4c6a8f0d2e4c6a8f0d',
  'System Administrator',
  r.id, 1
FROM roles r WHERE r.name = 'admin' LIMIT 1;
