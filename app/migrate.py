"""Migrasi skema otomatis (idempotent) — dijalankan saat aplikasi start.

Tujuan: memisahkan Dataset (TRAIN/TEST) dari tabel operasional qc_hold.
  1. Tambah kolom fitur & label ke tabel dataset_record.
  2. qc_hold_id dibuat NULLABLE + FK ON DELETE SET NULL (hanya referensi sumber).
  3. Backfill fitur dataset_record dari qc_hold yang direferensikan.
  4. Pindahkan data hasil upload lama (qc_code 'QC-IMP-%') keluar dari qc_hold:
     record dataset dilepas dari qc_hold, lalu baris QC-IMP di qc_hold dihapus.
"""
from sqlalchemy import text, inspect

NEW_COLUMNS = [
    ('source', "VARCHAR(20) DEFAULT 'UPLOAD'"),
    ('record_code', 'VARCHAR(80) NULL'),
    ('part_no', 'VARCHAR(100) NULL'),
    ('product_category_id', 'INT NULL'),
    ('defect_category_id', 'INT NULL'),
    ('defect_severity', 'SMALLINT NULL'),
    ('defect_description', 'TEXT NULL'),
    ('decision_action_id', 'INT NULL'),
]


def _fk_names(conn, table, column):
    rows = conn.execute(text(
        "SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c "
        "AND REFERENCED_TABLE_NAME IS NOT NULL"
    ), {'t': table, 'c': column}).fetchall()
    return [r[0] for r in rows]


def _fk_delete_rule(conn, name):
    row = conn.execute(text(
        "SELECT DELETE_RULE FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS "
        "WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = :n"
    ), {'n': name}).fetchone()
    return row[0] if row else None


def migrate_dataset_separation(db, logger=None):
    log = (logger.info if logger else print)
    engine = db.engine
    if engine.dialect.name != 'mysql':
        return

    insp = inspect(engine)
    if 'dataset_record' not in insp.get_table_names():
        return  # akan dibuat oleh db.create_all() dengan skema baru

    existing = {c['name']: c for c in insp.get_columns('dataset_record')}

    with engine.begin() as conn:
        # 1. Tambah kolom baru
        added = []
        for col, ddl in NEW_COLUMNS:
            if col not in existing:
                conn.execute(text(f'ALTER TABLE dataset_record ADD COLUMN {col} {ddl}'))
                added.append(col)
        if added:
            log(f'[migrate] dataset_record: kolom ditambahkan {added}')

        # 2. qc_hold_id -> NULLABLE + FK ON DELETE SET NULL
        if not existing.get('qc_hold_id', {}).get('nullable', True):
            for fk in _fk_names(conn, 'dataset_record', 'qc_hold_id'):
                conn.execute(text(f'ALTER TABLE dataset_record DROP FOREIGN KEY `{fk}`'))
            conn.execute(text('ALTER TABLE dataset_record MODIFY qc_hold_id BIGINT NULL'))
            conn.execute(text(
                'ALTER TABLE dataset_record ADD CONSTRAINT fk_dsrec_qc_hold '
                'FOREIGN KEY (qc_hold_id) REFERENCES qc_hold(id) ON DELETE SET NULL'
            ))
            log('[migrate] dataset_record.qc_hold_id -> NULLABLE, ON DELETE SET NULL')
        else:
            for fk in _fk_names(conn, 'dataset_record', 'qc_hold_id'):
                if _fk_delete_rule(conn, fk) == 'CASCADE':
                    conn.execute(text(f'ALTER TABLE dataset_record DROP FOREIGN KEY `{fk}`'))
                    conn.execute(text(
                        'ALTER TABLE dataset_record ADD CONSTRAINT fk_dsrec_qc_hold '
                        'FOREIGN KEY (qc_hold_id) REFERENCES qc_hold(id) ON DELETE SET NULL'
                    ))

        # FK untuk kolom fitur (jika belum ada)
        for col, ref in [('product_category_id', 'product_category'),
                         ('defect_category_id', 'defect_category'),
                         ('decision_action_id', 'decision_action')]:
            if not _fk_names(conn, 'dataset_record', col):
                conn.execute(text(
                    f'ALTER TABLE dataset_record ADD CONSTRAINT fk_dsrec_{col} '
                    f'FOREIGN KEY ({col}) REFERENCES {ref}(id) ON DELETE SET NULL'
                ))

        # 3. Backfill snapshot fitur dari qc_hold (hanya record yang belum terisi)
        res = conn.execute(text(
            "UPDATE dataset_record dr JOIN qc_hold q ON dr.qc_hold_id = q.id "
            "SET dr.record_code = q.qc_code, dr.part_no = q.part_no, "
            "    dr.product_category_id = q.product_category_id, "
            "    dr.defect_category_id = q.defect_category_id, "
            "    dr.defect_severity = q.defect_severity, "
            "    dr.defect_description = q.defect_description, "
            "    dr.decision_action_id = q.decision_action_id, "
            "    dr.source = IF(q.qc_code LIKE 'QC-IMP-%', 'UPLOAD', 'QC_HOLD') "
            "WHERE dr.record_code IS NULL"
        ))
        if res.rowcount:
            log(f'[migrate] backfill fitur dataset_record: {res.rowcount} baris')

        # 4. Lepaskan record upload lama dari qc_hold, lalu hapus baris QC-IMP di qc_hold
        res = conn.execute(text(
            "UPDATE dataset_record dr JOIN qc_hold q ON dr.qc_hold_id = q.id "
            "SET dr.qc_hold_id = NULL, dr.source = 'UPLOAD' "
            "WHERE q.qc_code LIKE 'QC-IMP-%'"
        ))
        if res.rowcount:
            log(f'[migrate] {res.rowcount} record dataset hasil upload dilepas dari qc_hold')

        res = conn.execute(text("DELETE FROM qc_hold WHERE qc_code LIKE 'QC-IMP-%'"))
        if res.rowcount:
            log(f'[migrate] {res.rowcount} baris dataset upload lama dihapus dari tabel qc_hold')

        # Sinkronkan record_count
        conn.execute(text(
            "UPDATE dataset d SET record_count = "
            "(SELECT COUNT(*) FROM dataset_record dr WHERE dr.dataset_id = d.id)"
        ))
