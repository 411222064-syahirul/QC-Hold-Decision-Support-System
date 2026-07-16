"""Routes modul kepala_qc — Kepala Quality Control.

Skeleton awal: Dashboard dan QC Hold view tersedia.
Hak akses akan diperluas di iterasi berikutnya.
"""
from flask import Blueprint, render_template
from flask_login import login_required

from app.models import db, QcHold, User
from app.auth import require_role

bp = Blueprint('kepala_qc', __name__, url_prefix='/kepala_qc')


@bp.route('/')
@bp.route('/dashboard')
@login_required
@require_role('kepala_qc')
def dashboard():
    from sqlalchemy import func
    base_q = QcHold.query.filter(~QcHold.qc_code.like('QC-IMP-%'))
    total_ng = db.session.query(
        func.coalesce(func.sum(QcHold.qty_ng), 0)
    ).filter(~QcHold.qc_code.like('QC-IMP-%')).scalar()
    total_ok = db.session.query(
        func.coalesce(func.sum(QcHold.qty_ok), 0)
    ).filter(~QcHold.qc_code.like('QC-IMP-%')).scalar()

    stats = {
        'total_qc_hold': base_q.count(),
        'total_open': base_q.filter(QcHold.status == 'OPEN').count(),
        'total_close': base_q.filter(QcHold.status == 'CLOSE').count(),
        'total_ng': int(total_ng),
        'total_ok': int(total_ok),
    }
    
    from sqlalchemy import desc
    recent_open_qcs = base_q.filter(QcHold.status == 'OPEN').order_by(desc(QcHold.created_at)).limit(5).all()
    
    return render_template('kepala_qc/dashboard.html', stats=stats, recent_open_qcs=recent_open_qcs)
