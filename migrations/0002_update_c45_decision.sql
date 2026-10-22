-- ============================================================
-- QC System — Incremental Migration: Proses Keputusan C4.5 & Locked Decision Action
-- Run: mysql -u root qc_system < migrations/0002_update_c45_decision.sql
-- ============================================================

USE qc_system;
SET FOREIGN_KEY_CHECKS = 0;

ALTER TABLE qc_hold
  ADD COLUMN IF NOT EXISTS decision_status VARCHAR(10) DEFAULT NULL AFTER decision_action_id;

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'qc_hold' AND COLUMN_NAME = 'prediction_id'
);
SET @sql_qc_col = IF(
  @col_exists > 0,
  'ALTER TABLE qc_hold CHANGE COLUMN prediction_id c45_record_id BIGINT DEFAULT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql_qc_col;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @tbl_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prediction'
);
SET @sql_rename_tbl = IF(
  @tbl_exists > 0,
  'RENAME TABLE prediction TO c45_decision',
  'SELECT 1'
);
PREPARE stmt FROM @sql_rename_tbl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_act = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'c45_decision' AND COLUMN_NAME = 'predicted_action_id'
);
SET @sql_col_act = IF(
  @col_act > 0,
  'ALTER TABLE c45_decision CHANGE COLUMN predicted_action_id action_id INT DEFAULT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql_col_act;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_by = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'c45_decision' AND COLUMN_NAME = 'predicted_by'
);
SET @sql_col_by = IF(
  @col_by > 0,
  'ALTER TABLE c45_decision CHANGE COLUMN predicted_by processed_by BIGINT DEFAULT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql_col_by;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_at = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'c45_decision' AND COLUMN_NAME = 'predicted_at'
);
SET @sql_col_at = IF(
  @col_at > 0,
  'ALTER TABLE c45_decision CHANGE COLUMN predicted_at processed_at DATETIME DEFAULT CURRENT_TIMESTAMP',
  'SELECT 1'
);
PREPARE stmt FROM @sql_col_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO decision_action (code, label, description) VALUES
  ('REWORK',    'REWORK',    'Proses ulang produksi (Status: YES)'),
  ('DISPOSISI', 'DISPOSISI', 'Turun kelas / disposisi penggunaan khusus (Status: YES)'),
  ('DISPOSAL',  'DISPOSAL',  'Buang / Scrap karena tidak dapat diperbaiki (Status: NO)');

UPDATE decision_action SET label = 'REWORK', description = 'Proses ulang produksi (Status: YES)' WHERE code = 'REWORK';
UPDATE decision_action SET label = 'DISPOSISI', description = 'Turun kelas / disposisi penggunaan khusus (Status: YES)' WHERE code = 'DISPOSISI';
UPDATE decision_action SET label = 'DISPOSAL', description = 'Buang / Scrap karena tidak dapat diperbaiki (Status: NO)' WHERE code = 'DISPOSAL';

SET @rework_id = (SELECT id FROM decision_action WHERE code = 'REWORK' LIMIT 1);
UPDATE qc_hold SET decision_action_id = @rework_id
  WHERE decision_action_id IS NOT NULL
    AND decision_action_id NOT IN (SELECT id FROM (SELECT id FROM decision_action WHERE code IN ('REWORK', 'DISPOSISI', 'DISPOSAL')) AS t);

DELETE FROM decision_action WHERE code NOT IN ('REWORK', 'DISPOSISI', 'DISPOSAL');

UPDATE qc_hold q
JOIN decision_action d ON q.decision_action_id = d.id
SET q.decision_status = CASE
  WHEN UPPER(d.code) IN ('DISPOSAL', 'SCRAP') THEN 'NO'
  ELSE 'YES'
END
WHERE q.decision_status IS NULL;

SET FOREIGN_KEY_CHECKS = 1;
