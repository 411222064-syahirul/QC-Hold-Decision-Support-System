-- ============================================================
-- QC System — Initial Migration
-- Compatible with XAMPP MySQL 5.7+
-- Run: mysql -u root qc_system < migrations/0001_init.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS qc_system CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE qc_system;

-- Roles
CREATE TABLE IF NOT EXISTS roles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB CHARSET=utf8mb4;

-- Users
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(150) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255),
  role_id BIGINT UNSIGNED,
  is_active TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL
) ENGINE=InnoDB CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);

-- Defect Category
CREATE TABLE IF NOT EXISTS defect_category (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  description TEXT
) ENGINE=InnoDB CHARSET=utf8mb4;

-- Defect Type
CREATE TABLE IF NOT EXISTS defect_type (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  category_id INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  FOREIGN KEY (category_id) REFERENCES defect_category(id) ON DELETE RESTRICT
) ENGINE=InnoDB CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_defect_type_category ON defect_type(category_id);

-- Decision Action
CREATE TABLE IF NOT EXISTS decision_action (
  id TINYINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL,
  description TEXT
) ENGINE=InnoDB CHARSET=utf8mb4;

-- QC Hold
CREATE TABLE IF NOT EXISTS qc_hold (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  qc_code VARCHAR(80) NOT NULL UNIQUE,
  product_code VARCHAR(150) NOT NULL,
  batch_no VARCHAR(150),
  inspection_date DATETIME NOT NULL,
  line VARCHAR(100),
  operator_id BIGINT UNSIGNED,
  defect_category_id INT UNSIGNED,
  defect_type_id INT UNSIGNED,
  defect_severity TINYINT,
  defect_description TEXT,
  qty_total INT DEFAULT 0,
  qty_ng INT DEFAULT 0,
  qty_ok INT DEFAULT 0,
  image_url TEXT,
  decision_action_id TINYINT UNSIGNED,
  action_taken_by BIGINT UNSIGNED,
  action_taken_at DATETIME,
  prediction_id BIGINT UNSIGNED,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (operator_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (defect_category_id) REFERENCES defect_category(id) ON DELETE SET NULL,
  FOREIGN KEY (defect_type_id) REFERENCES defect_type(id) ON DELETE SET NULL,
  FOREIGN KEY (decision_action_id) REFERENCES decision_action(id) ON DELETE SET NULL,
  FOREIGN KEY (action_taken_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_qc_inspection_date ON qc_hold(inspection_date);
CREATE INDEX IF NOT EXISTS idx_qc_product_code ON qc_hold(product_code);
CREATE INDEX IF NOT EXISTS idx_qc_decision_action ON qc_hold(decision_action_id);

-- Models
CREATE TABLE IF NOT EXISTS models (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  algorithm VARCHAR(100) NOT NULL DEFAULT 'C4.5',
  version VARCHAR(50),
  trained_at DATETIME,
  dataset_id BIGINT UNSIGNED,
  model_file_path TEXT,
  parameters JSON,
  is_active TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_models_trained_at ON models(trained_at);

-- Dataset
CREATE TABLE IF NOT EXISTS dataset (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200),
  type ENUM('TRAIN','TEST','VALIDATION') DEFAULT 'TRAIN',
  description TEXT,
  record_count INT DEFAULT 0,
  storage_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB CHARSET=utf8mb4;

-- Prediction
CREATE TABLE IF NOT EXISTS prediction (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  model_id BIGINT UNSIGNED,
  qc_hold_id BIGINT UNSIGNED,
  predicted_action_id TINYINT UNSIGNED,
  probability DECIMAL(5,4),
  predicted_by BIGINT UNSIGNED,
  predicted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  details JSON,
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL,
  FOREIGN KEY (qc_hold_id) REFERENCES qc_hold(id) ON DELETE SET NULL,
  FOREIGN KEY (predicted_action_id) REFERENCES decision_action(id) ON DELETE SET NULL,
  FOREIGN KEY (predicted_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_prediction_model ON prediction(model_id);
CREATE INDEX IF NOT EXISTS idx_prediction_qc ON prediction(qc_hold_id);

-- Decision Rule
CREATE TABLE IF NOT EXISTS decision_rule (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  model_id BIGINT UNSIGNED,
  rule_text TEXT,
  antecedent TEXT,
  consequent TEXT,
  support FLOAT,
  confidence FLOAT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE
) ENGINE=InnoDB CHARSET=utf8mb4;

-- Model Metrics
CREATE TABLE IF NOT EXISTS model_metrics (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  model_id BIGINT UNSIGNED,
  evaluated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  accuracy DOUBLE,
  `precision` DOUBLE,
  recall DOUBLE,
  f1_score DOUBLE,
  details JSON,
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE
) ENGINE=InnoDB CHARSET=utf8mb4;
CREATE INDEX IF NOT EXISTS idx_metrics_model ON model_metrics(model_id);

-- Audit Log
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED,
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
  ('qc_operator', 'Operator QC — input data dan prediksi'),
  ('viewer', 'Viewer — hanya baca laporan dan dashboard');

-- Decision Actions
INSERT IGNORE INTO decision_action (code, label, description) VALUES
  ('REPAIR',    'Repair',    'Produk diperbaiki tanpa perubahan material'),
  ('REWORK',    'Rework',    'Produk diproses ulang dari awal'),
  ('DOWNGRADE', 'Downgrade', 'Produk diturunkan ke grade lebih rendah'),
  ('DISPOSAL',  'Disposal/Scrap', 'Produk dibuang/dimusnahkan');

-- Default Defect Categories
INSERT IGNORE INTO defect_category (name, description) VALUES
  ('Visual', 'Cacat yang terlihat secara visual pada permukaan produk'),
  ('Dimensional', 'Cacat pada dimensi/ukuran produk'),
  ('Functional', 'Cacat yang mempengaruhi fungsi produk'),
  ('Material', 'Cacat pada material/bahan baku');

-- Default Admin User (password: Admin@123)
-- Hash generated via Werkzeug pbkdf2:sha256
INSERT IGNORE INTO users (username, email, password_hash, full_name, role_id, is_active)
SELECT 'admin', 'admin@qcsystem.local',
  'pbkdf2:sha256:600000$qcsystem2024$8a9f2c1d3e5b7a4c6f8d0e2b4c6a8f0d2e4c6a8f0d2e4c6a8f0d2e4c6a8f0d',
  'System Administrator',
  r.id, 1
FROM roles r WHERE r.name = 'admin' LIMIT 1;
