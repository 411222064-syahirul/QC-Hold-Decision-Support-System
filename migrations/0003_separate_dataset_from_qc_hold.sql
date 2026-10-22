-- ============================================================
-- QC System — Migration 0003: Pisahkan Dataset dari tabel qc_hold
-- Run: mysql -u root qc_system < migrations/0003_separate_dataset_from_qc_hold.sql
-- Catatan: migrasi yang sama juga dijalankan otomatis oleh `python main.py`
--          (app/migrate.py). Jalankan file ini HANYA jika ingin manual.
-- ============================================================
USE qc_system;

-- 1. Kolom fitur & label milik dataset sendiri
ALTER TABLE dataset_record
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'UPLOAD',
  ADD COLUMN IF NOT EXISTS record_code VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS part_no VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS product_category_id INT NULL,
  ADD COLUMN IF NOT EXISTS defect_category_id INT NULL,
  ADD COLUMN IF NOT EXISTS defect_severity SMALLINT NULL,
  ADD COLUMN IF NOT EXISTS defect_description TEXT NULL,
  ADD COLUMN IF NOT EXISTS decision_action_id INT NULL;

-- 2. qc_hold_id hanya referensi sumber (nullable, SET NULL)
--    Ganti nama FK lama sesuai hasil: SHOW CREATE TABLE dataset_record;
-- ALTER TABLE dataset_record DROP FOREIGN KEY dataset_record_ibfk_2;
ALTER TABLE dataset_record MODIFY qc_hold_id BIGINT NULL;
-- ALTER TABLE dataset_record ADD CONSTRAINT fk_dsrec_qc_hold
--   FOREIGN KEY (qc_hold_id) REFERENCES qc_hold(id) ON DELETE SET NULL;

-- 3. Backfill snapshot fitur
UPDATE dataset_record dr JOIN qc_hold q ON dr.qc_hold_id = q.id
SET dr.record_code = q.qc_code, dr.part_no = q.part_no,
    dr.product_category_id = q.product_category_id,
    dr.defect_category_id = q.defect_category_id,
    dr.defect_severity = q.defect_severity,
    dr.defect_description = q.defect_description,
    dr.decision_action_id = q.decision_action_id,
    dr.source = IF(q.qc_code LIKE 'QC-IMP-%', 'UPLOAD', 'QC_HOLD')
WHERE dr.record_code IS NULL;

-- 4. Keluarkan data upload lama dari qc_hold
UPDATE dataset_record dr JOIN qc_hold q ON dr.qc_hold_id = q.id
SET dr.qc_hold_id = NULL, dr.source = 'UPLOAD'
WHERE q.qc_code LIKE 'QC-IMP-%';

DELETE FROM qc_hold WHERE qc_code LIKE 'QC-IMP-%';

UPDATE dataset d SET record_count =
  (SELECT COUNT(*) FROM dataset_record dr WHERE dr.dataset_id = d.id);
