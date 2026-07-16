from flask import Blueprint, jsonify, request, render_template
from flask_login import login_required, current_user
import pandas as pd
import io

from app.models import db, Dataset, DatasetRecord, QcHold
from app.auth import require_role
from .qc_hold import log_audit

bp = Blueprint('admin_datasets', __name__, url_prefix='/admin')


@bp.route('/dataset-training')
@login_required
@require_role('admin')
def dataset_training_page():
    return render_template('admin/dataset_training.html')

@bp.route('/dataset-testing')
@login_required
@require_role('admin')
def dataset_testing_page():
    return render_template('admin/dataset_testing.html')

@bp.route('/api/datasets', methods=['GET'])
@login_required
@require_role('admin')
def get_datasets():
    ds_type = request.args.get('type', 'TRAIN')
    datasets = Dataset.query.filter_by(type=ds_type).order_by(Dataset.created_at.desc()).all()
    return jsonify([d.to_dict() for d in datasets])

@bp.route('/api/datasets', methods=['POST'])
@login_required
@require_role('admin')
def create_dataset():
    data = request.json
    ds = Dataset(
        name=data.get('name'),
        type=data.get('type', 'TRAIN'),
        description=data.get('description'),
        record_count=0
    )
    db.session.add(ds)
    db.session.commit()
    log_audit('CREATE', 'dataset', ds.id, {'name': ds.name})
    return jsonify(ds.to_dict()), 201

@bp.route('/api/datasets/<int:id>', methods=['DELETE'])
@login_required
@require_role('admin')
def delete_dataset(id):
    ds = Dataset.query.get_or_404(id)
    db.session.delete(ds)
    db.session.commit()
    log_audit('DELETE', 'dataset', id)
    return jsonify({'success': True})

@bp.route('/api/datasets/<int:id>/records', methods=['GET'])
@login_required
@require_role('admin')
def get_dataset_records(id):
    records = db.session.query(DatasetRecord, QcHold).join(QcHold).filter(DatasetRecord.dataset_id == id).all()
    res = []
    for dr, qc in records:
        d = qc.to_dict()
        d['dataset_record_id'] = dr.id
        d['qc_hold_id'] = qc.id
        res.append(d)
    return jsonify(res)

@bp.route('/api/datasets/<int:id>/add-records', methods=['POST'])
@login_required
@require_role('admin')
def add_dataset_records(id):
    ds = Dataset.query.get_or_404(id)
    qc_ids = request.json.get('qc_hold_ids', [])
    added = 0
    for qid in qc_ids:
        # Check if exists
        exists = DatasetRecord.query.filter_by(dataset_id=id, qc_hold_id=qid).first()
        if not exists:
            dr = DatasetRecord(dataset_id=id, qc_hold_id=qid)
            db.session.add(dr)
            added += 1
    ds.record_count += added
    db.session.commit()
    log_audit('ADD_RECORDS', 'dataset', id, {'count': added})
    return jsonify({'success': True, 'added': added})

@bp.route('/api/datasets/<int:id>/remove-records', methods=['POST'])
@login_required
@require_role('admin')
def remove_dataset_records(id):
    ds = Dataset.query.get_or_404(id)
    qc_ids = request.json.get('qc_hold_ids', [])
    removed = 0
    for qid in qc_ids:
        dr = DatasetRecord.query.filter_by(dataset_id=id, qc_hold_id=qid).first()
        if dr:
            db.session.delete(dr)
            removed += 1
    ds.record_count -= removed
    db.session.commit()
    log_audit('REMOVE_RECORDS', 'dataset', id, {'count': removed})
    return jsonify({'success': True, 'removed': removed})

@bp.route('/api/qc-hold-available', methods=['GET'])
@login_required
@require_role('admin')
def get_available_qc_holds():
    dataset_id = request.args.get('dataset_id')
    if not dataset_id:
        return jsonify([])
    
    # Subquery for records already in dataset
    subq = db.session.query(DatasetRecord.qc_hold_id).filter_by(dataset_id=dataset_id).subquery()
    
    # Query QcHolds not in subq
    available = QcHold.query.filter(~QcHold.id.in_(subq)).order_by(QcHold.created_at.desc()).all()
    return jsonify([q.to_dict() for q in available])

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
        # Check file extension and load dataframe
        if file.filename.endswith('.csv'):
            df = pd.read_csv(file)
        else:
            # First try reading sheet 'QC Hold' with header=2, else fallback
            try:
                df = pd.read_excel(file, sheet_name='QC Hold', header=2)
            except:
                df = pd.read_excel(file)

        # Normalize column names for easier mapping
        df.columns = [str(c).strip().replace('\n', ' ') for c in df.columns]
        
        # Define possible column names in Indonesian/dataset specific
        col_product = next((c for c in df.columns if 'KATEGORI PRODUK' in c.upper() or 'LINE' in c.upper() or 'PRODUK' in c.upper()), None)
        col_cat = next((c for c in df.columns if 'JENIS MASALAH' in c.upper() or 'DEFECT CATEGORY' in c.upper()), None)
        col_severity = next((c for c in df.columns if 'SEVERITY' in c.upper() or 'KEPARAHAN' in c.upper()), None)
        col_action = next((c for c in df.columns if 'KEPUTUSAN' in c.upper() or 'TINDAKAN' in c.upper() or 'ACTION' in c.upper()), None)
        
        # Import process
        inserted_count = 0
        
        # Cache for lookup
        from app.models import DefectCategory, DecisionAction, Prediction, ProductCategory
        from datetime import datetime
        
        # Helper to get or create lookup tables
        def get_or_create_product_cat(name):
            if pd.isna(name) or str(name).strip() == '':
                name = 'Lain-lain'
            name_str = str(name).strip().upper()
            c = ProductCategory.query.filter_by(name=name_str).first()
            if not c:
                c = ProductCategory(name=name_str)
                db.session.add(c)
                db.session.flush()
            return c.id

        def get_or_create_cat(name):
            if pd.isna(name) or str(name).strip() == '':
                name = 'Lain-lain'
            c = DefectCategory.query.filter_by(name=str(name).strip().upper()).first()
            if not c:
                c = DefectCategory(name=str(name).strip().upper())
                db.session.add(c)
                db.session.flush()
            return c.id
            
        def get_or_create_action(name):
            if pd.isna(name) or str(name).strip() == '':
                return None
            name_str = str(name).strip().upper()
            code = name_str.split()[0] # e.g. REWORK - DISPOSISI -> REWORK
            a = DecisionAction.query.filter_by(code=code).first()
            if not a:
                a = DecisionAction.query.filter_by(label=name_str).first()
            if not a:
                a = DecisionAction(code=code, label=name_str)
                db.session.add(a)
                db.session.flush()
            return a.id

        for idx, row in df.iterrows():
            cat_id = get_or_create_cat(row[col_cat] if col_cat else 'Umum')
            action_id = get_or_create_action(row[col_action] if col_action else None)
            
            # Parsing values
            line_val = str(row[col_product]) if col_product else f"Lain-lain"
            product_cat_id = get_or_create_product_cat(line_val)
            
            severity_val = 1
            if col_severity and not pd.isna(row[col_severity]):
                s_val = str(row[col_severity]).strip().upper()
                if s_val == 'LOW':
                    severity_val = 1
                elif s_val == 'MEDIUM':
                    severity_val = 2
                elif s_val == 'HIGH':
                    severity_val = 3
                else:
                    try:
                        severity_val = max(1, min(3, int(float(row[col_severity]))))
                    except:
                        pass
            
            qc_code = f"QC-IMP-{datetime.now().strftime('%Y%m%d%H%M%S')}-{idx}"
            
            # Create QcHold
            qc = QcHold(
                qc_code=qc_code,
                product_category_id=product_cat_id,
                inspection_date=datetime.utcnow(),
                defect_category_id=cat_id,
                defect_severity=severity_val,
                decision_action_id=action_id,
                operator_id=current_user.id
            )
            db.session.add(qc)
            db.session.flush()
            
            # Link to dataset
            dr = DatasetRecord(dataset_id=ds.id, qc_hold_id=qc.id)
            db.session.add(dr)
            inserted_count += 1
            
        ds.record_count += inserted_count
        db.session.commit()
        
        log_audit('UPLOAD_FILE', 'dataset', ds.id, {'filename': file.filename, 'inserted': inserted_count})
        
        return jsonify({
            'success': True,
            'message': f'File {file.filename} berhasil diunggah. {inserted_count} data Qc Hold berhasil ditambahkan ke dataset.'
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

