from datetime import datetime
from flask import Blueprint, jsonify, request, render_template
from flask_login import login_required, current_user
import os
import math
import joblib
import pandas as pd
import numpy as np

from app.models import db, MLModel, DecisionRecord, QcHold, DefectCategory, DecisionAction, ProductCategory, DatasetRecord
from app.auth import require_role
from .qc_hold import log_audit

bp = Blueprint('admin_c45', __name__, url_prefix='/admin')


@bp.route('/proses-keputusan')
@bp.route('/c45')
@login_required
@require_role('admin', 'kepala_qc')
def c45_page():
    return render_template('admin/c45.html')


# ─── Helper: Determine Status (YES / NO) from DecisionAction ──────
def get_decision_status(action: DecisionAction) -> str:
    """
    Returns:
      'NO'  --> jika decision (DISPOSAL)
      'YES' --> jika decision (REWORK/DISPOSISI/REPAIR)
    """
    if not action:
        return 'NO'
    code = (action.code or '').upper()
    label = (action.label or '').upper()
    if 'DISPOSAL' in code or 'SCRAP' in code or 'DISPOSAL' in label or 'SCRAP' in label:
        return 'NO'
    return 'YES'


# ─── Helper: Load active model bundle ────────────────────────────
def _load_active_model():
    """Returns (bundle, active_model, error_response_tuple)"""
    active_model = MLModel.query.filter_by(is_active=True).first()
    if not active_model:
        return None, None, (jsonify({'error': 'Belum ada model C4.5 yang aktif. Silakan aktifkan model terlebih dahulu.'}), 400)
    if not os.path.exists(active_model.model_file_path):
        return None, None, (jsonify({'error': 'File fisik model tidak ditemukan di server.'}), 404)
    bundle = joblib.load(active_model.model_file_path)
    return bundle, active_model, None


def _process_single(clf, features, encoders, qc: QcHold):
    """Run C4.5 classification for a single QcHold. Returns (action_id, probability)."""
    severity = qc.defect_severity if qc.defect_severity is not None else 1
    severity = min(3, max(1, severity))

    prod_cat_raw = str(qc.product_category_id) if qc.product_category_id else '0'
    if 'product_category' in encoders:
        le = encoders['product_category']
        try:
            prod_cat_code = int(le.transform([prod_cat_raw])[0])
        except ValueError:
            prod_cat_code = 0
    else:
        prod_cat_code = 0

    input_row = {
        'defect_category':       qc.defect_category_id or 0,
        'defect_severity':       severity,
        'product_category_code': prod_cat_code,
    }

    df_in = pd.DataFrame([input_row])[features]
    action_id = int(clf.predict(df_in)[0])

    try:
        prob = float(clf.predict_proba(df_in)[0].max())
    except Exception:
        prob = 1.0

    return action_id, prob


# ─── API: Get all OPEN QC Holds ──────────────────────────────────
@bp.route('/api/c45/open-qcs', methods=['GET'])
@login_required
@require_role('admin', 'kepala_qc')
def get_open_qcs():
    records = (
        QcHold.query
        .filter(QcHold.status == 'OPEN', ~QcHold.qc_code.like('QC-IMP-%'))
        .order_by(QcHold.created_at.desc())
        .all()
    )
    return jsonify([r.to_dict() for r in records])


# ─── API: Batch Process Decisions (Preview) ──────────────────────
@bp.route('/api/c45/batch', methods=['POST'])
@login_required
@require_role('admin', 'kepala_qc')
def batch_process():
    """Run C4.5 decision process on selected QC Hold IDs — preview only, not saved to DB."""
    data = request.json or {}
    qc_ids = data.get('qc_hold_ids', [])

    if not qc_ids:
        return jsonify({'error': 'Pilih minimal 1 QC Hold untuk diproses'}), 400

    bundle, active_model, err = _load_active_model()
    if err:
        return err

    clf      = bundle['model']
    features = bundle['features']
    encoders = bundle.get('label_encoders', {})

    results = []
    for qc_id in qc_ids:
        qc = QcHold.query.get(qc_id)
        if not qc or qc.status != 'OPEN':
            continue

        action_id, prob = _process_single(clf, features, encoders, qc)
        action = DecisionAction.query.get(action_id)
        decision_status = get_decision_status(action)
        is_disposal = (decision_status == 'NO')

        results.append({
            'qc_hold_id':      qc.id,
            'qc_code':         qc.qc_code,
            'part_no':         qc.part_no or '-',
            'product_category': qc.product_category.name if qc.product_category else '-',
            'defect_category': qc.defect_category.name if qc.defect_category else '-',
            'defect_severity': qc.defect_severity,
            'action_id':       action_id,
            'action_label':    action.label if action else f'Action {action_id}',
            'action_code':     action.code if action else '',
            'decision_status': decision_status,  # 'YES' (REWORK/DISPOSISI) or 'NO' (DISPOSAL)
            'probability':     round(prob * 100, 2),
            'is_disposal':     is_disposal,
        })

    return jsonify({
        'results': results,
        'model_name': active_model.name,
    })


# ─── API: Confirm & Apply Decisions ──────────────────────────────
@bp.route('/api/c45/confirm', methods=['POST'])
@login_required
@require_role('admin', 'kepala_qc')
def confirm_decisions():
    """Apply C4.5 decisions permanently: close QC holds, save decision_status (YES/NO), fill notes."""
    data = request.json or {}
    items = data.get('items', [])

    if not items:
        return jsonify({'error': 'Tidak ada data keputusan untuk dikonfirmasi'}), 400

    _, active_model, err = _load_active_model()
    if err:
        return err

    confirmed_count = 0
    for item in items:
        qc_id     = item.get('qc_hold_id')
        action_id = item.get('action_id')
        prob      = item.get('probability', 100.0)

        qc = QcHold.query.get(qc_id)
        if not qc or qc.status != 'OPEN':
            continue

        action = DecisionAction.query.get(action_id)
        if not action:
            continue

        decision_status = get_decision_status(action)
        is_disposal = (decision_status == 'NO')

        # Update QC Hold
        qc.decision_action_id = action_id
        qc.decision_status    = decision_status
        qc.status             = 'CLOSE'
        qc.notes              = (
            'Perbaikan NG (Gagal / Disposal)'
            if is_disposal
            else 'Perbaikan OK (Lanjut Proses Produksi)'
        )
        qc.action_taken_by    = current_user.id
        qc.action_taken_at    = datetime.utcnow()

        # Record C4.5 decision
        rec = DecisionRecord(
            model_id=active_model.id,
            qc_hold_id=qc_id,
            action_id=action_id,
            probability=round(prob / 100, 4),
            processed_by=current_user.id,
            processed_at=datetime.utcnow(),
            details={'decision_status': decision_status, 'decision_code': action.code},
        )
        db.session.add(rec)
        db.session.flush()
        qc.c45_record_id = rec.id
        confirmed_count += 1

    db.session.commit()
    log_audit('CONFIRM_DECISIONS', 'qc_hold', 0, {'confirmed_count': confirmed_count})

    return jsonify({'success': True, 'confirmed': confirmed_count})
