import os
import joblib
from datetime import datetime
import pandas as pd
from flask import Blueprint, jsonify, request, render_template, current_app
from flask_login import login_required, current_user
from sklearn.tree import DecisionTreeClassifier, export_text
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score, confusion_matrix
from sklearn.preprocessing import LabelEncoder
import numpy as np

from app.models import db, MLModel, Dataset, DatasetRecord, QcHold, ModelMetrics, DecisionRule, DecisionAction, DefectCategory, ProductCategory
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
        train_mx = {}
        test_mx = {}
        for mx in metrics:
            val = float(mx.metric_value) if mx.metric_value is not None else 0.0
            if mx.dataset_type == 'TEST':
                test_mx[mx.metric_name] = val
            else:
                train_mx[mx.metric_name] = val
        d['metrics'] = train_mx
        d['test_metrics'] = test_mx
        # Attach dataset name
        if m.dataset_id:
            ds = Dataset.query.get(m.dataset_id)
            d['dataset_name'] = ds.name if ds else '—'
            d['dataset_record_count'] = ds.record_count if ds else 0
        else:
            d['dataset_name'] = '—'
            d['dataset_record_count'] = 0
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

        # Gabungkan record dataset (dedupe berdasarkan identitas sampel)
        seen_keys = set()
        for src in DatasetRecord.query.filter(DatasetRecord.dataset_id.in_(dataset_ids)).all():
            if src.sample_key in seen_keys:
                continue
            seen_keys.add(src.sample_key)
            db.session.add(src.clone_to(merged_ds.id, source='MERGE'))

        merged_ds.record_count = len(seen_keys)
        db.session.flush()

        primary_dataset_id = merged_ds.id
    else:
        primary_dataset_id = datasets[0].id

    # Ambil record dataset (tabel dataset_record — terpisah dari qc_hold)
    records = DatasetRecord.query.filter_by(dataset_id=primary_dataset_id).all()

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
            'product_category': str(r.product_category_id) if r.product_category_id else '0',
            'target': r.decision_action_id
        })

    df = pd.DataFrame(df_data)
    if df.empty:
        return jsonify({'error': 'Dataset tidak memiliki data valid yang berisi keputusan (decision action)'}), 400

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

    # Metrics calculation (Training metrics)
    y_pred = clf.predict(X)
    acc = accuracy_score(y, y_pred)
    prec = precision_score(y, y_pred, average='weighted', zero_division=0)
    rec = recall_score(y, y_pred, average='weighted', zero_division=0)
    f1 = f1_score(y, y_pred, average='weighted', zero_division=0)

    # Simpan model
    model_filename = f"model_c45_{datetime.now().strftime('%Y%m%d%H%M%S')}.joblib"
    model_path = os.path.join(MODELS_DIR, model_filename)

    # Simpan pipeline/encoders
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
        parameters={'max_depth': max_depth, 'min_samples_split': min_samples_split},
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
    model_record = MLModel.query.get_or_404(id)
    if not os.path.exists(model_record.model_file_path):
        return jsonify({'error': 'File model tidak ditemukan'}), 404

    bundle = joblib.load(model_record.model_file_path)
    clf = bundle['model']
    feature_names = bundle['features']

    def build_tree(node_index):
        is_leaf = clf.tree_.children_left[node_index] == -1 and clf.tree_.children_right[node_index] == -1

        val = clf.tree_.value[node_index][0]
        class_idx = np.argmax(val)
        class_name = str(clf.classes_[class_idx])

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
    """
    Evaluasi komprehensif model C4.5 terhadap Dataset Testing:
    1. Mengukur Kualitas Model (Accuracy, Precision, Recall, F1-Score, Per-Class Report, Confusion Matrix)
    2. Uji Generalisasi (Unseen Data Ratio, Data Leakage Detection, Pure Unseen Accuracy, Confidence Stability, Feature Importance)
    3. Deteksi Overfitting (Train vs Test Comparison, Generalization Gap, Overfitting Diagnosis & Rekomendasi)
    """
    data = request.json or {}
    dataset_id = data.get('dataset_id')
    model_id = data.get('model_id')

    if not dataset_id:
        return jsonify({'error': 'Pilih Dataset Testing terlebih dahulu.'}), 400

    test_ds = Dataset.query.get(dataset_id)
    if not test_ds:
        return jsonify({'error': 'Dataset Testing tidak ditemukan.'}), 404

    if model_id:
        target_model = MLModel.query.get(model_id)
    else:
        target_model = MLModel.query.filter_by(is_active=True).first()
        if not target_model:
            target_model = MLModel.query.order_by(MLModel.created_at.desc()).first()

    if not target_model:
        return jsonify({'error': 'Belum ada model C4.5 yang tersedia. Silakan latih model terlebih dahulu.'}), 400

    if not target_model.model_file_path or not os.path.exists(target_model.model_file_path):
        return jsonify({'error': f'File fisik model "{target_model.name}" tidak ditemukan di server.'}), 404

    bundle = joblib.load(target_model.model_file_path)
    clf = bundle['model']
    features = bundle['features']
    encoders = bundle.get('label_encoders', {})

    # Ambil Dataset Training model ini untuk cek overlap (data leakage) & perbandingan Train vs Test
    train_keys = set()
    train_ds_name = '—'
    if target_model.dataset_id:
        train_ds = Dataset.query.get(target_model.dataset_id)
        if train_ds:
            train_ds_name = train_ds.name
        train_keys = {r.sample_key for r in DatasetRecord.query.filter_by(dataset_id=target_model.dataset_id).all()}

    # Record Dataset Testing (tabel dataset_record — terpisah dari qc_hold)
    records = DatasetRecord.query.filter_by(dataset_id=dataset_id).all()

    if len(records) == 0:
        return jsonify({'error': f'Dataset "{test_ds.name}" masih kosong. Tambahkan record atau unggah data terlebih dahulu.'}), 400

    # Lookup maps for readable labels
    actions_map = {a.id: a for a in DecisionAction.query.all()}

    df_data = []
    valid_records = []
    for r in records:
        if not r.decision_action_id:
            continue

        severity = r.defect_severity if r.defect_severity is not None else 1
        severity = min(3, max(1, severity))

        df_data.append({
            'record_id': r.id,
            'defect_category': r.defect_category_id or 0,
            'defect_severity': severity,
            'product_category': str(r.product_category_id) if r.product_category_id else '0',
            'target': int(r.decision_action_id),
            'in_train': (r.sample_key in train_keys),
        })
        valid_records.append(r)

    if not df_data:
        return jsonify({'error': 'Dataset tidak memiliki record dengan label keputusan (Decision Action) yang valid.'}), 400

    df = pd.DataFrame(df_data)

    # Encode product_category
    if 'product_category' in encoders:
        le = encoders['product_category']
        known_classes = set(le.classes_)
        df['product_category_code'] = df['product_category'].apply(
            lambda val: int(le.transform([str(val)])[0]) if str(val) in known_classes else 0
        )
    else:
        df['product_category_code'] = 0

    X_test = df[features]
    y_test = df['target'].to_numpy()

    y_pred = clf.predict(X_test)
    try:
        y_proba = clf.predict_proba(X_test)
        max_probs = np.max(y_proba, axis=1)
    except Exception:
        max_probs = np.ones(len(y_test))

    # ── 1. Metrik Kualitas Model (Test Set) ──────────────────────────────────
    acc = float(accuracy_score(y_test, y_pred))
    prec = float(precision_score(y_test, y_pred, average='weighted', zero_division=0))
    rec = float(recall_score(y_test, y_pred, average='weighted', zero_division=0))
    f1 = float(f1_score(y_test, y_pred, average='weighted', zero_division=0))

    prec_macro = float(precision_score(y_test, y_pred, average='macro', zero_division=0))
    rec_macro = float(recall_score(y_test, y_pred, average='macro', zero_division=0))
    f1_macro = float(f1_score(y_test, y_pred, average='macro', zero_division=0))

    # ── 2. Metrik Training Model (untuk Deteksi Overfitting) ─────────────────
    train_metrics_db = {
        mx.metric_name: float(mx.metric_value)
        for mx in ModelMetrics.query.filter_by(model_id=target_model.id, dataset_type='TRAIN').all()
        if mx.metric_value is not None
    }
    if not train_metrics_db:
        # Fallback if dataset_type was not set on legacy rows
        train_metrics_db = {
            mx.metric_name: float(mx.metric_value)
            for mx in ModelMetrics.query.filter_by(model_id=target_model.id).all()
            if mx.metric_value is not None and mx.dataset_type != 'TEST'
        }

    train_acc = train_metrics_db.get('Accuracy', acc)
    train_prec = train_metrics_db.get('Precision', prec)
    train_rec = train_metrics_db.get('Recall', rec)
    train_f1 = train_metrics_db.get('F1-Score', f1)

    rule_rec = DecisionRule.query.filter_by(model_id=target_model.id).first()
    train_support = rule_rec.support if (rule_rec and rule_rec.support) else len(train_keys)

    # ── 3. Uji Generalisasi (Unseen vs Overlap Analysis) ─────────────────────
    total_tested = len(y_test)
    overlap_mask = df['in_train'].to_numpy(dtype=bool)
    overlap_count = int(np.sum(overlap_mask))
    unseen_count = int(total_tested - overlap_count)
    unseen_ratio = round((unseen_count / total_tested) * 100, 1) if total_tested > 0 else 0.0

    if unseen_count > 0:
        unseen_y_true = y_test[~overlap_mask]
        unseen_y_pred = y_pred[~overlap_mask]
        unseen_acc = float(accuracy_score(unseen_y_true, unseen_y_pred))
        unseen_f1 = float(f1_score(unseen_y_true, unseen_y_pred, average='weighted', zero_division=0))
    else:
        unseen_acc = acc
        unseen_f1 = f1

    avg_confidence = float(np.mean(max_probs))
    correct_mask = (y_test == y_pred)
    correct_count = int(np.sum(correct_mask))
    wrong_count = int(total_tested - correct_count)

    # ── 4. Deteksi Overfitting & Diagnosis ───────────────────────────────────
    acc_gap = float(train_acc - acc)
    f1_gap = float(train_f1 - f1)
    prec_gap = float(train_prec - prec)
    rec_gap = float(train_rec - rec)

    # Generalization score (0 - 100): rewards high test F1/Accuracy and penalizes positive train-test gap
    penalty = max(0.0, acc_gap) * 0.6 + max(0.0, f1_gap) * 0.4
    gen_score = round(max(0.0, min(1.0, ((acc + f1) / 2.0) - penalty)) * 100, 1)


    # ── 5. Confusion Matrix & Per-Class Metrics ──────────────────────────────
    all_classes = sorted(list(set(np.concatenate([y_test, y_pred, clf.classes_]))))
    cm = confusion_matrix(y_test, y_pred, labels=all_classes)

    class_labels = []
    class_report = []
    for idx_c, cls_id in enumerate(all_classes):
        act_obj = actions_map.get(int(cls_id))
        lbl = act_obj.label if act_obj else f'Action #{cls_id}'
        code = act_obj.code if act_obj else f'ACT_{cls_id}'
        class_labels.append(lbl)

        tp = int(cm[idx_c, idx_c])
        support_c = int(np.sum(cm[idx_c, :]))
        pred_c = int(np.sum(cm[:, idx_c]))

        prec_c = float(tp / pred_c) if pred_c > 0 else 0.0
        rec_c = float(tp / support_c) if support_c > 0 else 0.0
        f1_c = float(2 * prec_c * rec_c / (prec_c + rec_c)) if (prec_c + rec_c) > 0 else 0.0

        class_report.append({
            'class_id': int(cls_id),
            'label': lbl,
            'code': code,
            'precision': round(prec_c, 4),
            'recall': round(rec_c, 4),
            'f1_score': round(f1_c, 4),
            'support': support_c,
            'predicted_count': pred_c,
            'correct_count': tp,
        })

    # ── 6. Tree Complexity & Feature Importance ──────────────────────────────
    feature_label_map = {
        'defect_category': 'Kategori Defect',
        'defect_severity': 'Tingkat Keparahan (Severity)',
        'product_category_code': 'Kategori Produk'
    }
    importances = []
    if hasattr(clf, 'feature_importances_'):
        for f_name, f_imp in zip(features, clf.feature_importances_):
            importances.append({
                'feature': f_name,
                'label': feature_label_map.get(f_name, f_name),
                'importance': round(float(f_imp) * 100, 2)
            })
        importances.sort(key=lambda x: x['importance'], reverse=True)

    tree_info = {
        'max_depth_actual': int(clf.get_depth()) if hasattr(clf, 'get_depth') else None,
        'n_leaves': int(clf.get_n_leaves()) if hasattr(clf, 'get_n_leaves') else None,
        'n_nodes': int(clf.tree_.node_count) if hasattr(clf, 'tree_') else None,
        'feature_importances': importances,
    }

    # ── 7. Record-by-Record Comparison Details ───────────────────────────────
    sev_names = {1: 'LOW', 2: 'MEDIUM', 3: 'HIGH'}
    prediction_details = []
    for i, r in enumerate(valid_records):
        true_id = int(y_test[i])
        pred_id = int(y_pred[i])
        true_act = actions_map.get(true_id)
        pred_act = actions_map.get(pred_id)
        sev_num = min(3, max(1, r.defect_severity if r.defect_severity is not None else 1))

        prediction_details.append({
            'record_id': r.id,
            'qc_hold_id': r.qc_hold_id,
            'source': r.source,
            'qc_code': r.record_code,
            'product_category': r.product_category.name if r.product_category else '-',
            'defect_category': r.defect_category.name if r.defect_category else '-',
            'defect_severity': sev_num,
            'defect_severity_label': sev_names.get(sev_num, str(sev_num)),
            'actual_action': true_act.label if true_act else f'Action #{true_id}',
            'actual_code': true_act.code if true_act else '',
            'predicted_action': pred_act.label if pred_act else f'Action #{pred_id}',
            'predicted_code': pred_act.code if pred_act else '',
            'confidence': round(float(max_probs[i]) * 100, 1),
            'is_correct': bool(true_id == pred_id),
            'in_train': bool(overlap_mask[i]),
        })

    # Simpan metrik pengujian terbaru ke tabel model_metrics (dataset_type='TEST')
    ModelMetrics.query.filter_by(model_id=target_model.id, dataset_type='TEST').delete()
    for m_name, m_val in [('Accuracy', acc), ('Precision', prec), ('Recall', rec), ('F1-Score', f1)]:
        db.session.add(ModelMetrics(
            model_id=target_model.id,
            metric_name=m_name,
            metric_value=m_val,
            dataset_type='TEST'
        ))
    db.session.commit()

    log_audit('EVALUATE_MODEL', 'models', target_model.id, {
        'dataset_id': dataset_id,
        'dataset_name': test_ds.name,
        'test_accuracy': round(acc, 4),
        'train_accuracy': round(train_acc, 4),
    })

    return jsonify({
        # Backward-compatible top-level keys
        'accuracy': acc,
        'precision': prec,
        'recall': rec,
        'f1_score': f1,
        'total_tested': total_tested,
        'correct_count': correct_count,
        'wrong_count': wrong_count,

        # Model & Dataset metadata
        'model': {
            'id': target_model.id,
            'name': target_model.name,
            'algorithm': target_model.algorithm,
            'version': target_model.version,
            'is_active': target_model.is_active,
            'trained_at': str(target_model.trained_at) if target_model.trained_at else None,
            'train_dataset_name': train_ds_name,
            'train_support': train_support,
        },
        'dataset': {
            'id': test_ds.id,
            'name': test_ds.name,
            'description': test_ds.description,
            'record_count': test_ds.record_count,
        },

        # Quality Metrics (Train vs Test)
        'train_metrics': {
            'accuracy': round(train_acc, 4),
            'precision': round(train_prec, 4),
            'recall': round(train_rec, 4),
            'f1_score': round(train_f1, 4),
            'support': train_support,
        },
        'test_metrics': {
            'accuracy': round(acc, 4),
            'precision': round(prec, 4),
            'recall': round(rec, 4),
            'f1_score': round(f1, 4),
            'precision_macro': round(prec_macro, 4),
            'recall_macro': round(rec_macro, 4),
            'f1_macro': round(f1_macro, 4),
            'support': total_tested,
        },

        # Generalization & Unseen Data Analysis
        'generalization': {
            'generalization_score': gen_score,
            'unseen_count': unseen_count,
            'overlap_count': overlap_count,
            'unseen_ratio': unseen_ratio,
            'unseen_accuracy': round(unseen_acc, 4),
            'unseen_f1': round(unseen_f1, 4),
            'avg_confidence': round(avg_confidence * 100, 1),
        },

        # Overfitting Detection
        'overfitting': {
            'acc_gap': round(acc_gap, 4),
            'f1_gap': round(f1_gap, 4),
            'prec_gap': round(prec_gap, 4),
            'rec_gap': round(rec_gap, 4),
        },

        # Confusion Matrix & Per-Class Breakdown
        'confusion_matrix': {
            'labels': class_labels,
            'matrix': cm.tolist(),
        },
        'class_report': class_report,
        'tree_info': tree_info,
        'prediction_details': prediction_details,
    })
