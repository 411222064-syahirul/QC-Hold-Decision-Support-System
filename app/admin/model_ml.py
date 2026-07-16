import os
import joblib
from datetime import datetime
import pandas as pd
from flask import Blueprint, jsonify, request, render_template, current_app
from flask_login import login_required, current_user
from sklearn.tree import DecisionTreeClassifier, export_text
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score
from sklearn.preprocessing import LabelEncoder
import numpy as np

from app.models import db, MLModel, Dataset, DatasetRecord, QcHold, ModelMetrics, DecisionRule, DecisionAction, DefectCategory
from app.auth import require_role
from .qc_hold import log_audit

bp = Blueprint('admin_model_ml', __name__, url_prefix='/admin')

# Pastikan folder ml_models ada
MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'ml_models')
os.makedirs(MODELS_DIR, exist_ok=True)

@bp.route('/model-c45')
@login_required
@require_role('admin')
def model_c45_page():
    datasets = Dataset.query.filter_by(type='TRAIN').all()
    return render_template('admin/model_c45.html', datasets=datasets)

@bp.route('/decision-tree')
@login_required
@require_role('admin')
def decision_tree_page():
    return render_template('admin/decision_tree.html')

@bp.route('/api/models', methods=['GET'])
@login_required
@require_role('admin', 'kepala_qc')
def get_models():
    models = MLModel.query.order_by(MLModel.created_at.desc()).all()
    res = []
    for m in models:
        d = m.to_dict()
        metrics = ModelMetrics.query.filter_by(model_id=m.id).all()
        d['metrics'] = {mx.metric_name: mx.metric_value for mx in metrics}
        # Attach dataset name
        if m.dataset_id:
            from app.models import Dataset
            ds = Dataset.query.get(m.dataset_id)
            d['dataset_name'] = ds.name if ds else '—'
        else:
            d['dataset_name'] = '—'
        # Attach decision rules text
        rule = DecisionRule.query.filter_by(model_id=m.id).first()
        d['rules_text'] = rule.rule_text if rule else None
        res.append(d)
    return jsonify(res)

@bp.route('/api/models/train', methods=['POST'])
@login_required
@require_role('admin')
def train_model():
    data = request.json
    dataset_ids = data.get('dataset_ids', [])
    model_name = data.get('name')
    
    if not dataset_ids or not model_name:
        return jsonify({'error': 'Dataset dan Nama Model wajib diisi'}), 400
        
    if not isinstance(dataset_ids, list):
        dataset_ids = [dataset_ids]
        
    datasets = Dataset.query.filter(Dataset.id.in_(dataset_ids)).all()
    if not datasets:
        return jsonify({'error': 'Dataset tidak ditemukan'}), 404
        
    # Jika memilih lebih dari 1 dataset, buat Dataset gabungan secara otomatis
    if len(datasets) > 1:
        merged_ds = Dataset(
            name=f"Merged: {', '.join([ds.name for ds in datasets])[:150]}",
            type='TRAIN',
            description=f"Gabungan dari: {', '.join([ds.name for ds in datasets])}"
        )
        db.session.add(merged_ds)
        db.session.flush()
        
        unique_qc_hold_ids = db.session.query(DatasetRecord.qc_hold_id).filter(DatasetRecord.dataset_id.in_(dataset_ids)).distinct().all()
        for (qc_id,) in unique_qc_hold_ids:
            db.session.add(DatasetRecord(dataset_id=merged_ds.id, qc_hold_id=qc_id))
            
        merged_ds.record_count = len(unique_qc_hold_ids)
        db.session.flush()
        
        primary_dataset_id = merged_ds.id
    else:
        primary_dataset_id = datasets[0].id
        
    # Ambil data QC hold berdasarkan dataset (satu atau gabungan)
    records = db.session.query(QcHold).join(DatasetRecord, DatasetRecord.qc_hold_id == QcHold.id).filter(DatasetRecord.dataset_id == primary_dataset_id).all()
    
    if len(records) < 10:
        return jsonify({'error': 'Jumlah record pada dataset terlalu sedikit (minimal 10)'}), 400
        
    # Bentuk DataFrame
    df_data = []
    for r in records:
        if not r.decision_action_id:
            continue
            
        severity = r.defect_severity if r.defect_severity is not None else 1
        severity = min(3, max(1, severity))
            
        df_data.append({
            'defect_category': r.defect_category_id,
            'defect_severity': severity,
            'product_category': r.product_category_id,
            'target': r.decision_action_id
        })
        
    df = pd.DataFrame(df_data)
    if df.empty:
        return jsonify({'error': 'Dataset tidak memiliki data valid yang berisi keputasan (decision action)'}), 400
        
    # Preprocessing
    df = df.fillna(0)
    
    # Categorical encoding
    if 'product_category' in df.columns:
        le = LabelEncoder()
        df['product_category'] = df['product_category'].astype(str)
        df['product_category_code'] = le.fit_transform(df['product_category'])
    else:
        df['product_category_code'] = 0
        
    features = ['defect_category', 'defect_severity', 'product_category_code']
    X = df[features]
    y = df['target']
    
    # Read Hyperparameters
    max_depth = data.get('max_depth')
    if max_depth is not None and str(max_depth).strip() != '':
        max_depth = int(max_depth)
    else:
        max_depth = None
        
    min_samples_split = data.get('min_samples_split')
    if min_samples_split is not None and str(min_samples_split).strip() != '':
        min_samples_split = int(min_samples_split)
    else:
        min_samples_split = 2
    
    # Train Model C4.5 Equivalent (Decision Tree with Entropy)
    clf = DecisionTreeClassifier(
        criterion='entropy', 
        random_state=42,
        max_depth=max_depth,
        min_samples_split=min_samples_split
    )
    clf.fit(X, y)
    
    # Metrics calculation (Training metrics untuk simplifikasi jika tidak ada test set terpisah)
    y_pred = clf.predict(X)
    acc = accuracy_score(y, y_pred)
    prec = precision_score(y, y_pred, average='weighted', zero_division=0)
    rec = recall_score(y, y_pred, average='weighted', zero_division=0)
    f1 = f1_score(y, y_pred, average='weighted', zero_division=0)
    
    # Simpan model
    model_filename = f"model_c45_{datetime.now().strftime('%Y%m%d%H%M%S')}.joblib"
    model_path = os.path.join(MODELS_DIR, model_filename)
    
    # Simpan pipeline/encoders (bisa di bundle di dalam dictionary)
    model_bundle = {
        'model': clf,
        'features': features,
        'label_encoders': {'product_category': le} if 'product_category' in df.columns else {}
    }
    joblib.dump(model_bundle, model_path)
    
    # Buat record di DB
    new_model = MLModel(
        name=model_name,
        algorithm='C4.5',
        version='1.0',
        trained_at=datetime.utcnow(),
        dataset_id=primary_dataset_id,
        model_file_path=model_path,
        is_active=False
    )
    db.session.add(new_model)
    db.session.flush()
    
    # Simpan metrics
    for m_name, m_val in [('Accuracy', acc), ('Precision', prec), ('Recall', rec), ('F1-Score', f1)]:
        db.session.add(ModelMetrics(model_id=new_model.id, metric_name=m_name, metric_value=m_val, dataset_type='TRAIN'))
        
    # Extract rules
    tree_rules = export_text(clf, feature_names=features)
    rule_record = DecisionRule(
        model_id=new_model.id,
        rule_text=tree_rules,
        support=len(df),
        confidence=acc
    )
    db.session.add(rule_record)
    
    db.session.commit()
    log_audit('TRAIN_MODEL', 'models', new_model.id, {'name': model_name, 'accuracy': float(acc)})
    
    return jsonify({
        'success': True,
        'model': new_model.to_dict(),
        'metrics': {
            'Accuracy': float(acc), 'Precision': float(prec), 'Recall': float(rec), 'F1-Score': float(f1)
        }
    }), 201

@bp.route('/api/models/<int:id>/activate', methods=['POST'])
@login_required
@require_role('admin')
def activate_model(id):
    # Nonaktifkan semua model dulu
    MLModel.query.update({MLModel.is_active: False})
    
    model = MLModel.query.get_or_404(id)
    model.is_active = True
    db.session.commit()
    log_audit('ACTIVATE_MODEL', 'models', id)
    return jsonify({'success': True, 'message': f'Model {model.name} diaktifkan'})

@bp.route('/api/models/<int:id>', methods=['DELETE'])
@login_required
@require_role('admin')
def delete_model(id):
    model = MLModel.query.get_or_404(id)
    if model.is_active:
        return jsonify({'error': 'Model aktif tidak dapat dihapus. Aktifkan model lain terlebih dahulu.'}), 400

    # Hapus file fisik .joblib
    try:
        if model.model_file_path and os.path.exists(model.model_file_path):
            os.remove(model.model_file_path)
    except Exception as e:
        current_app.logger.warning(f'Gagal hapus file model: {e}')

    model_name = model.name
    db.session.delete(model)
    db.session.commit()
    log_audit('DELETE_MODEL', 'models', id, {'name': model_name})
    return jsonify({'success': True, 'message': f'Model "{model_name}" berhasil dihapus'})


@bp.route('/api/models/<int:id>/tree', methods=['GET'])
@login_required
@require_role('admin')
def get_model_tree(id):
    # Ini untuk ECharts Tree visualization.
    # Secara teknis kita perlu mengekstrak _tree dari object clf dan merubahnya ke dict recursive.
    model_record = MLModel.query.get_or_404(id)
    if not os.path.exists(model_record.model_file_path):
        return jsonify({'error': 'File model tidak ditemukan'}), 404
        
    bundle = joblib.load(model_record.model_file_path)
    clf = bundle['model']
    feature_names = bundle['features']
    
    # Helper recursive function for scikit-learn tree
    def build_tree(node_index):
        is_leaf = clf.tree_.children_left[node_index] == -1 and clf.tree_.children_right[node_index] == -1
        
        # Hitung kelas mayoritas
        val = clf.tree_.value[node_index][0]
        class_idx = np.argmax(val)
        class_name = str(clf.classes_[class_idx])
        
        # Coba ambil nama action-nya dari DB
        action = DecisionAction.query.get(int(class_name))
        action_label = action.label if action else f"Action {class_name}"
        
        if is_leaf:
            return {
                'name': f"Keputusan:\\n{action_label}",
                'value': int(sum(val)),
                'itemStyle': {'color': '#28a745'}
            }
        else:
            feature_idx = clf.tree_.feature[node_index]
            feature_name = feature_names[feature_idx]
            threshold = clf.tree_.threshold[node_index]
            
            return {
                'name': f"{feature_name}\\n<= {threshold:.2f}",
                'children': [
                    build_tree(clf.tree_.children_left[node_index]),
                    build_tree(clf.tree_.children_right[node_index])
                ]
            }
            
    tree_data = build_tree(0)
    
    # Load raw rules format
    rule_record = DecisionRule.query.filter_by(model_id=id).first()
    rules_text = rule_record.rule_text if rule_record else ""
    
    return jsonify({
        'tree': tree_data,
        'rules': rules_text
    })

@bp.route('/api/models/evaluate', methods=['POST'])
@login_required
@require_role('admin')
def evaluate_model():
    data = request.json
    dataset_id = data.get('dataset_id')
    
    if not dataset_id:
        return jsonify({'error': 'Pilih dataset terlebih dahulu'}), 400
        
    active_model = MLModel.query.filter_by(is_active=True).first()
    if not active_model:
        return jsonify({'error': 'Tidak ada model yang aktif.'}), 400
        
    import os
    if not os.path.exists(active_model.model_file_path):
        return jsonify({'error': 'File fisik model tidak ditemukan.'}), 404
        
    bundle = joblib.load(active_model.model_file_path)
    clf = bundle['model']
    features = bundle['features']
    encoders = bundle.get('label_encoders', {})
    
    records = db.session.query(QcHold).join(DatasetRecord, DatasetRecord.qc_hold_id == QcHold.id).filter(DatasetRecord.dataset_id == dataset_id).all()
    
    if len(records) == 0:
        return jsonify({'error': 'Dataset kosong.'}), 400
        
    # Build DataFrame
    df_data = []
    from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score, confusion_matrix
    
    for r in records:
        if not r.decision_action_id:
            continue
            
        severity = r.defect_severity if r.defect_severity is not None else 1
        severity = min(3, max(1, severity))
            
        row_data = {
            'defect_category': r.defect_category_id,
            'defect_severity': severity,
            'product_category': r.product_category_id,
            'target': r.decision_action_id
        }
        df_data.append(row_data)
        
    if not df_data:
        return jsonify({'error': 'Dataset tidak memiliki label valid.'}), 400
        
    df = pd.DataFrame(df_data)
    
    # Encode
    if 'product_category' in encoders:
        le = encoders['product_category']
        def encode_cat(val):
            try:
                return le.transform([str(val)])[0]
            except ValueError:
                return 0
        df['product_category_code'] = df['product_category'].apply(encode_cat)
    else:
        df['product_category_code'] = 0
        
    X_test = df[features]
    y_test = df['target']
    
    y_pred = clf.predict(X_test)
    
    acc = accuracy_score(y_test, y_pred)
    prec = precision_score(y_test, y_pred, average='weighted', zero_division=0)
    rec = recall_score(y_test, y_pred, average='weighted', zero_division=0)
    f1 = f1_score(y_test, y_pred, average='weighted', zero_division=0)
    
    return jsonify({
        'accuracy': acc,
        'precision': prec,
        'recall': rec,
        'f1_score': f1,
        'total_tested': len(y_test)
    })

