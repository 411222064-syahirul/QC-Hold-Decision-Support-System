"""Modul Dataset (TRAIN / TEST).

Dataset disimpan di tabel `dataset_record` yang berdiri sendiri (snapshot fitur + label),
TERPISAH dari tabel operasional `qc_hold`:
- Upload Excel/CSV -> langsung ke dataset_record (tidak membuat baris qc_hold).
- Tambah dari QC Hold -> disalin (snapshot) ke dataset_record; qc_hold_id hanya referensi.
"""
from datetime import datetime
from flask import Blueprint, jsonify, request, render_template
from flask_login import login_required
import pandas as pd

from app.models import db, Dataset, DatasetRecord, QcHold, MLModel, DefectCategory, DecisionAction, ProductCategory
from app.auth import require_role
from .qc_hold import log_audit

bp = Blueprint('admin_datasets', __name__, url_prefix='/admin')


# â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
def _active_train_keys():
    """Kumpulan sample_key milik Dataset Training dari model aktif (untuk deteksi overlap)."""
    active_model = MLModel.query.filter_by(is_active=True).first()
    if not active_model or not active_model.dataset_id:
        return set(), None
    recs = DatasetRecord.query.filter_by(dataset_id=active_model.dataset_id).all()
    return {r.sample_key for r in recs}, active_model.dataset_id


def _dataset_qc_ids(dataset_id):
    rows = db.session.query(DatasetRecord.qc_hold_id).filter(
        DatasetRecord.dataset_id == dataset_id, DatasetRecord.qc_hold_id.isnot(None)
    ).all()
    return {r[0] for r in rows}


def _sync_count(ds):
    ds.record_count = DatasetRecord.query.filter_by(dataset_id=ds.id).count()


# â”€â”€ Pages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@bp.route('/dataset-training')
@login_required
@require_role('admin')
def dataset_training_page():
    return render_template('admin/dataset_training.html')


@bp.route('/dataset-testing')
@login_required
@require_role('admin')
def dataset_testing_page():
    models = MLModel.query.order_by(MLModel.created_at.desc()).all()
    train_datasets = Dataset.query.filter_by(type='TRAIN').order_by(Dataset.created_at.desc()).all()
    return render_template('admin/dataset_testing.html', models=models, train_datasets=train_datasets)


# â”€â”€ Dataset CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@bp.route('/api/datasets', methods=['GET'])
@login_required
@require_role('admin')
def get_datasets():
    ds_type = request.args.get('type', 'TRAIN')
    datasets = Dataset.query.filter_by(type=ds_type).order_by(Dataset.created_at.desc()).all()
    train_keys, _ = _active_train_keys() if ds_type == 'TEST' else (set(), None)

    result, dirty = [], False
    for d in datasets:
        recs = DatasetRecord.query.filter_by(dataset_id=d.id).all()
        if d.record_count != len(recs):
            d.record_count = len(recs)
            dirty = True
        labeled = [r for r in recs if r.decision_action_id is not None]
        overlap = sum(1 for r in labeled if r.sample_key in train_keys) if ds_type == 'TEST' else 0

        item = d.to_dict()
        item['labeled_count'] = len(labeled)
        item['overlap_count'] = overlap
        item['unseen_count'] = max(0, len(labeled) - overlap)
        item['upload_count'] = sum(1 for r in recs if r.qc_hold_id is None)
        item['qc_hold_ref_count'] = sum(1 for r in recs if r.qc_hold_id is not None)
        result.append(item)

    if dirty:
        db.session.commit()
    return jsonify(result)


@bp.route('/api/datasets', methods=['POST'])
@login_required
@require_role('admin')
def create_dataset():
    data = request.json or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Nama dataset wajib diisi'}), 400
    ds = Dataset(name=name, type=data.get('type', 'TRAIN'),
                 description=data.get('description'), record_count=0)
    db.session.add(ds)
    db.session.commit()
    log_audit('CREATE', 'dataset', ds.id, {'name': ds.name, 'type': ds.type})
    return jsonify(ds.to_dict()), 201


@bp.route('/api/datasets/<int:id>', methods=['DELETE'])
@login_required
@require_role('admin')
def delete_dataset(id):
    ds = Dataset.query.get_or_404(id)
    db.session.delete(ds)  # record dataset ikut terhapus; qc_hold TIDAK tersentuh
    db.session.commit()
    log_audit('DELETE', 'dataset', id)
    return jsonify({'success': True})


# â”€â”€ Auto-generate Test Set â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@bp.route('/api/datasets/generate-test', methods=['POST'])
@login_required
@require_role('admin')
def generate_test_dataset():
    """
    - mode 'unseen': salin QC Hold berlabel (CLOSE) yang tidak dipakai Dataset Training acuan.
    - mode 'split' : ambil proporsi stratified dari record Dataset Training acuan,
                     opsional dikeluarkan dari Dataset Training (bebas data leakage).
    """
    import random
    data = request.json or {}
    name = (data.get('name') or '').strip()
    mode = data.get('mode', 'unseen')
    source_train_id = data.get('source_train_id')
    split_ratio = float(data.get('split_ratio', 0.25))
    remove_from_train = bool(data.get('remove_from_train', True))
    max_records = int(data.get('max_records', 200) or 200)

    if not name:
        name = f"Testing Set ({mode.upper()}) - {datetime.now().strftime('%d %b %Y %H:%M')}"

    train_ds = None
    if source_train_id:
        train_ds = Dataset.query.get(int(source_train_id))
    else:
        active_model = MLModel.query.filter_by(is_active=True).first()
        if active_model and active_model.dataset_id:
            train_ds = Dataset.query.get(active_model.dataset_id)

    new_ds = Dataset(name=name, type='TEST', description='', record_count=0)
    db.session.add(new_ds)
    db.session.flush()

    added = 0
    if mode == 'unseen':
        exclude_ids = _dataset_qc_ids(train_ds.id) if train_ds else set()
        q = QcHold.query.filter(QcHold.decision_action_id.isnot(None))
        if exclude_ids:
            q = q.filter(~QcHold.id.in_(exclude_ids))
        candidates = q.order_by(QcHold.created_at.desc()).limit(max_records).all()
        if not candidates:
            db.session.rollback()
            return jsonify({'error': 'Tidak ada data QC Hold berlabel di luar Dataset Training. '
                                     'Gunakan mode "Stratified Split" atau unggah file Excel/CSV.'}), 400
        for qc in candidates:
            db.session.add(DatasetRecord.from_qc_hold(new_ds.id, qc))
            added += 1
        desc = f"Unseen Holdout ({added} sampel QC Hold di luar {train_ds.name if train_ds else 'Train Set'})"

    elif mode == 'split':
        if not train_ds:
            db.session.rollback()
            return jsonify({'error': 'Pilih Dataset Training acuan untuk mode split.'}), 400
        source_recs = DatasetRecord.query.filter(
            DatasetRecord.dataset_id == train_ds.id, DatasetRecord.decision_action_id.isnot(None)
        ).all()
        if len(source_recs) < 5:
            db.session.rollback()
            return jsonify({'error': 'Data sumber terlalu sedikit untuk di-split (minimal 5 record berlabel).'}), 400

        by_class = {}
        for r in source_recs:
            by_class.setdefault(r.decision_action_id, []).append(r)
        rng = random.Random(42)
        picked = []
        for recs in by_class.values():
            rng.shuffle(recs)
            take = max(1, int(round(len(recs) * split_ratio)))
            if len(recs) > 1 and take >= len(recs):
                take = len(recs) - 1
            picked.extend(recs[:take])

        for r in picked:
            db.session.add(r.clone_to(new_ds.id, source='SPLIT'))
            added += 1

        if remove_from_train and len(source_recs) - len(picked) >= 10:
            for r in picked:
                db.session.delete(r)
            db.session.flush()
            _sync_count(train_ds)
        desc = f"Stratified Split ({int(split_ratio * 100)}%) dari {train_ds.name}"
    else:
        db.session.rollback()
        return jsonify({'error': 'Mode pembuatan dataset tidak valid'}), 400

    new_ds.description = data.get('description') or desc
    db.session.flush()
    _sync_count(new_ds)
    db.session.commit()
    log_audit('GENERATE_TEST_DATASET', 'dataset', new_ds.id, {'mode': mode, 'count': added})
    return jsonify({
        'success': True, 'dataset': new_ds.to_dict(), 'added_count': added,
        'message': f'Dataset Testing "{new_ds.name}" berhasil dibuat dengan {added} record.'
    }), 201


# â”€â”€ Records â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@bp.route('/api/datasets/<int:id>/records', methods=['GET'])
@login_required
@require_role('admin')
def get_dataset_records(id):
    ds = Dataset.query.get_or_404(id)
    train_keys, train_ds_id = _active_train_keys()
    if train_ds_id == ds.id:
        train_keys = set()
    recs = DatasetRecord.query.filter_by(dataset_id=id).order_by(DatasetRecord.id.desc()).all()
    res = []
    for r in recs:
        d = r.to_dict()
        d['in_active_train'] = r.sample_key in train_keys
        res.append(d)
    return jsonify(res)


@bp.route('/api/datasets/<int:id>/add-records', methods=['POST'])
@login_required
@require_role('admin')
def add_dataset_records(id):
    """Salin (snapshot) QC Hold terpilih ke dataset. Tabel qc_hold tidak diubah."""
    ds = Dataset.query.get_or_404(id)
    qc_ids = (request.json or {}).get('qc_hold_ids', [])
    existing = _dataset_qc_ids(id)
    added = 0
    for qid in qc_ids:
        if qid in existing:
            continue
        qc = QcHold.query.get(qid)
        if not qc or not qc.decision_action_id:
            continue
        db.session.add(DatasetRecord.from_qc_hold(id, qc))
        added += 1
    db.session.flush()
    _sync_count(ds)
    db.session.commit()
    log_audit('ADD_RECORDS', 'dataset', id, {'count': added})
    return jsonify({'success': True, 'added': added})


@bp.route('/api/datasets/<int:id>/remove-records', methods=['POST'])
@login_required
@require_role('admin')
def remove_dataset_records(id):
    """Hapus record dari dataset (berdasarkan dataset_record id). qc_hold tidak tersentuh."""
    ds = Dataset.query.get_or_404(id)
    data = request.json or {}
    record_ids = data.get('record_ids', [])
    q = DatasetRecord.query.filter(DatasetRecord.dataset_id == id)
    if record_ids:
        q = q.filter(DatasetRecord.id.in_(record_ids))
    elif data.get('qc_hold_ids'):
        q = q.filter(DatasetRecord.qc_hold_id.in_(data['qc_hold_ids']))
    else:
        return jsonify({'error': 'Tidak ada record yang dipilih'}), 400
    removed = q.delete(synchronize_session=False)
    db.session.flush()
    _sync_count(ds)
    db.session.commit()
    log_audit('REMOVE_RECORDS', 'dataset', id, {'count': removed})
    return jsonify({'success': True, 'removed': removed})


@bp.route('/api/qc-hold-available', methods=['GET'])
@login_required
@require_role('admin')
def get_available_qc_holds():
    """Daftar QC Hold operasional berlabel yang bisa disalin ke dataset."""
    dataset_id = request.args.get('dataset_id', type=int)
    if not dataset_id:
        return jsonify([])
    ds = Dataset.query.get(dataset_id)
    already = _dataset_qc_ids(dataset_id)

    active_model = MLModel.query.filter_by(is_active=True).first()
    train_ids = _dataset_qc_ids(active_model.dataset_id) if active_model and active_model.dataset_id else set()

    q = QcHold.query.filter(QcHold.decision_action_id.isnot(None))
    if already:
        q = q.filter(~QcHold.id.in_(already))
    available = q.order_by(QcHold.created_at.desc()).limit(500).all()

    res = []
    for item in available:
        d = item.to_dict()
        d['in_active_train'] = item.id in train_ids
        res.append(d)
    if ds and ds.type == 'TEST':
        res.sort(key=lambda x: 1 if x['in_active_train'] else 0)
    return jsonify(res)


# â”€â”€ Upload Excel / CSV (langsung ke dataset_record, BUKAN ke qc_hold) â”€â”€â”€â”€â”€â”€â”€â”€â”€
@bp.route('/api/datasets/<int:id>/upload', methods=['POST'])
@login_required
@require_role('admin')
def upload_dataset(id):
    ds = Dataset.query.get_or_404(id)
    if 'file' not in request.files:
        return jsonify({'error': 'Tidak ada file yang diunggah'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'File belum dipilih'}), 400

    try:
        if file.filename.lower().endswith('.csv'):
            df = pd.read_csv(file)
        else:
            try:
                df = pd.read_excel(file, sheet_name='QC Hold', header=2)
            except Exception:
                file.stream.seek(0)
                df = pd.read_excel(file)

        df.columns = [str(c).strip().replace('\n', ' ') for c in df.columns]
        up = lambda c: c.upper()
        col_product = next((c for c in df.columns if 'KATEGORI PRODUK' in up(c) or 'LINE' in up(c) or 'PRODUK' in up(c)), None)
        col_cat = next((c for c in df.columns if 'JENIS MASALAH' in up(c) or 'DEFECT' in up(c)), None)
        col_severity = next((c for c in df.columns if 'SEVERITY' in up(c) or 'KEPARAHAN' in up(c)), None)
        col_action = next((c for c in df.columns if 'KEPUTUSAN' in up(c) or 'TINDAKAN' in up(c) or 'ACTION' in up(c)), None)
        col_part = next((c for c in df.columns if 'PART' in up(c)), None)
        col_desc = next((c for c in df.columns if 'KETERANGAN' in up(c) or 'DESKRIPSI' in up(c) or 'DESCRIPTION' in up(c)), None)

        if not col_action:
            return jsonify({'error': 'Kolom Keputusan/Tindakan/Action tidak ditemukan pada file.'}), 400

        cache = {'prod': {}, 'cat': {}, 'act': {}}

        def get_or_create_product_cat(name):
            name_str = 'LAIN-LAIN' if pd.isna(name) or str(name).strip() in ('', 'nan') else str(name).strip().upper()
            if name_str not in cache['prod']:
                c = ProductCategory.query.filter_by(name=name_str).first()
                if not c:
                    c = ProductCategory(name=name_str)
                    db.session.add(c)
                    db.session.flush()
                cache['prod'][name_str] = c.id
            return cache['prod'][name_str]

        def get_or_create_cat(name):
            name_str = 'LAIN-LAIN' if pd.isna(name) or str(name).strip() in ('', 'nan') else str(name).strip().upper()
            if name_str not in cache['cat']:
                c = DefectCategory.query.filter_by(name=name_str).first()
                if not c:
                    c = DefectCategory(name=name_str)
                    db.session.add(c)
                    db.session.flush()
                cache['cat'][name_str] = c.id
            return cache['cat'][name_str]

        def get_action(name):
            if pd.isna(name) or str(name).strip() == '':
                return None
            name_str = str(name).strip().upper()
            code = name_str.split()[0]
            if code in ('DISPSOSAL', 'SCRAP'):
                code = 'DISPOSAL'
            if code not in cache['act']:
                a = DecisionAction.query.filter_by(code=code).first() or DecisionAction.query.filter_by(label=name_str).first()
                if not a:
                    a = DecisionAction(code=code, label=code)
                    db.session.add(a)
                    db.session.flush()
                cache['act'][code] = a.id
            return cache['act'][code]

        def parse_severity(val):
            if val is None or pd.isna(val):
                return 1
            s = str(val).strip().upper()
            mapping = {'LOW': 1, 'MEDIUM': 2, 'HIGH': 3}
            if s in mapping:
                return mapping[s]
            try:
                return max(1, min(3, int(float(val))))
            except Exception:
                return 1

        ts = datetime.now().strftime('%Y%m%d%H%M%S')
        inserted, skipped = 0, 0
        for idx, row in df.iterrows():
            action_id = get_action(row[col_action])
            if not action_id:
                skipped += 1
                continue
            rec = DatasetRecord(
                dataset_id=ds.id,
                qc_hold_id=None,
                source='UPLOAD',
                record_code=f"DS{ds.id}-{ts}-{inserted + 1:04d}",
                part_no=(str(row[col_part]).strip() if col_part and not pd.isna(row[col_part]) else None),
                product_category_id=get_or_create_product_cat(row[col_product] if col_product else None),
                defect_category_id=get_or_create_cat(row[col_cat] if col_cat else None),
                defect_severity=parse_severity(row[col_severity] if col_severity else None),
                defect_description=(str(row[col_desc]).strip() if col_desc and not pd.isna(row[col_desc]) else None),
                decision_action_id=action_id,
            )
            db.session.add(rec)
            inserted += 1

        db.session.flush()
        _sync_count(ds)
        db.session.commit()
        log_audit('UPLOAD_FILE', 'dataset', ds.id, {'filename': file.filename, 'inserted': inserted, 'skipped': skipped})

        msg = f'File {file.filename} berhasil diunggah: {inserted} record ditambahkan ke dataset "{ds.name}".'
        if skipped:
            msg += f' {skipped} baris dilewati (tanpa label keputusan).'
        return jsonify({'success': True, 'inserted_count': inserted, 'skipped_count': skipped, 'message': msg})

    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500
