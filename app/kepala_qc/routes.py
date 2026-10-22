"""Routes modul kepala_qc — Kepala Quality Control.

Skeleton awal: Dashboard dan QC Hold view tersedia.
Hak akses akan diperluas di iterasi berikutnya.
"""
from flask import Blueprint, render_template, jsonify
from flask_login import login_required

from app.models import db, QcHold, User, DecisionAction, DefectCategory
from app.auth import require_role

bp = Blueprint('kepala_qc', __name__, url_prefix='/kepala_qc')


@bp.route('/')
@bp.route('/dashboard')
@login_required
@require_role('kepala_qc')
def dashboard():
    from sqlalchemy import func, desc
    from datetime import datetime, timedelta

    base_q = QcHold.query.filter(~QcHold.qc_code.like('QC-IMP-%'))
    total_ng = db.session.query(
        func.coalesce(func.sum(QcHold.qty_ng), 0)
    ).filter(~QcHold.qc_code.like('QC-IMP-%')).scalar()
    total_ok = db.session.query(
        func.coalesce(func.sum(QcHold.qty_ok), 0)
    ).filter(~QcHold.qc_code.like('QC-IMP-%')).scalar()

    def _count_by_code(code):
        action = DecisionAction.query.filter_by(code=code).first()
        if not action:
            return 0
        return base_q.filter(QcHold.decision_action_id == action.id).count()

    stats = {
        'total_qc_hold': base_q.count(),
        'total_open': base_q.filter(QcHold.status == 'OPEN').count(),
        'total_close': base_q.filter(QcHold.status == 'CLOSE').count(),
        'total_ng': int(total_ng),
        'total_ok': int(total_ok),
        'total_repair': _count_by_code('REPAIR'),
        'total_rework': _count_by_code('REWORK'),
        'total_disposisi': _count_by_code('DISPOSISI'),
        'total_disposal': _count_by_code('DISPOSAL'),
    }

    recent_open_qcs = base_q.filter(QcHold.status == 'OPEN').order_by(desc(QcHold.created_at)).limit(5).all()

    # Defect category distribution
    defect_dist = db.session.query(
        DefectCategory.name, func.count(QcHold.id)
    ).join(QcHold, QcHold.defect_category_id == DefectCategory.id
    ).filter(~QcHold.qc_code.like('QC-IMP-%')
    ).group_by(DefectCategory.name).all()
    defect_distribution = [{'label': n, 'count': c} for n, c in defect_dist]

    # Decision distribution
    decision_dist = db.session.query(
        DecisionAction.label, func.count(QcHold.id)
    ).join(QcHold, QcHold.decision_action_id == DecisionAction.id
    ).filter(~QcHold.qc_code.like('QC-IMP-%')
    ).group_by(DecisionAction.label).all()
    decision_distribution = [{'label': l, 'count': c} for l, c in decision_dist]

    # Monthly NG trend (6 months)
    six_months_ago = datetime.utcnow() - timedelta(days=180)
    monthly_ng = db.session.query(
        func.date_format(QcHold.inspection_date, '%Y-%m').label('month'),
        func.coalesce(func.sum(QcHold.qty_ng), 0).label('total_ng')
    ).filter(
        ~QcHold.qc_code.like('QC-IMP-%'),
        QcHold.inspection_date >= six_months_ago
    ).group_by('month').order_by('month').all()
    monthly_data = [{'month': r.month, 'count': int(r.total_ng)} for r in monthly_ng]

    return render_template('kepala_qc/dashboard.html',
        stats=stats,
        recent_open_qcs=recent_open_qcs,
        defect_distribution=defect_distribution,
        decision_distribution=decision_distribution,
        monthly_data=monthly_data,
    )
