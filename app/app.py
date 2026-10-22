"""Flask app factory — QC System."""
from flask import Flask, Blueprint, render_template, request, redirect, url_for, flash, jsonify
from flask_login import login_user, logout_user, login_required, current_user
from .config import Config
from .models import db, User, Role, QcHold, AuditLog, DefectCategory, DecisionAction, MLModel
from .auth import init_login, require_role, log_audit


def _dashboard_url_for_role(role_name):
    """Kembalikan URL dashboard yang sesuai dengan role user."""
    if role_name == 'qc_line':
        return url_for('qc_line.dashboard')
    elif role_name == 'kepala_qc':
        return url_for('kepala_qc.dashboard')
    else:
        # admin, dan role lain yang belum punya modul tersendiri
        return url_for('admin.dashboard')


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    db.init_app(app)
    init_login(app)

    # ── Auth blueprint ──────────────────────────────────────────────────────
    auth_bp = Blueprint('auth', __name__)

    @auth_bp.route('/login', methods=['GET', 'POST'])
    def login():
        if current_user.is_authenticated:
            role_name = current_user.role.name if current_user.role else None
            return redirect(_dashboard_url_for_role(role_name))
        if request.method == 'POST':
            username = request.form.get('username', '').strip()
            password = request.form.get('password', '')
            user = User.query.filter_by(username=username, is_active=True).first()
            if user and user.check_password(password):
                login_user(user, remember=request.form.get('remember'))
                log_audit('LOGIN', 'users', user.id, {'username': user.username})
                role_name = user.role.name if user.role else None
                return redirect(_dashboard_url_for_role(role_name))
            flash('Username atau password salah.', 'danger')
        return render_template('login.html')

    @auth_bp.route('/logout')
    @login_required
    def logout():
        log_audit('LOGOUT', 'users', current_user.id, {'username': current_user.username})
        logout_user()
        flash('Berhasil logout.', 'success')
        return redirect(url_for('auth.login'))

    # ── Admin dashboard blueprint ───────────────────────────────────────────
    admin_bp = Blueprint('admin', __name__, url_prefix='/admin')

    @admin_bp.route('/')
    @admin_bp.route('/dashboard')
    @login_required
    @require_role('admin', 'kepala_qc')
    def dashboard():
        from sqlalchemy import func
        base_q = QcHold.query.filter(~QcHold.qc_code.like('QC-IMP-%'))
        total_ng_q = db.session.query(func.coalesce(func.sum(QcHold.qty_ng), 0)).filter(~QcHold.qc_code.like('QC-IMP-%'))
        total_ok_q = db.session.query(func.coalesce(func.sum(QcHold.qty_ok), 0)).filter(~QcHold.qc_code.like('QC-IMP-%'))

        total_qc = base_q.count()
        total_ng = total_ng_q.scalar()
        total_ok = total_ok_q.scalar()

        def _count_by_code(code):
            action = DecisionAction.query.filter_by(code=code).first()
            if not action:
                return 0
            return base_q.filter(QcHold.decision_action_id == action.id).count()

        stats = {
            'total_users': User.query.count() if current_user.role.name == 'admin' else 0,
            'total_roles': Role.query.count() if current_user.role.name == 'admin' else 0,
            'total_qc_hold': total_qc,
            'total_ng': int(total_ng),
            'total_ok': int(total_ok),
            'total_open': base_q.filter(QcHold.status == 'OPEN').count(),
            'total_close': base_q.filter(QcHold.status == 'CLOSE').count(),
            'total_repair': _count_by_code('REPAIR'),
            'total_rework': _count_by_code('REWORK'),
            'total_disposisi': _count_by_code('DISPOSISI'),
            'total_disposal': _count_by_code('DISPOSAL'),
            'total_defect_categories': DefectCategory.query.count() if current_user.role.name == 'admin' else 0,
            'total_decision_actions': DecisionAction.query.count() if current_user.role.name == 'admin' else 0,
            'total_models': MLModel.query.count() if current_user.role.name == 'admin' else 0,
        }
        audit_logs = AuditLog.query.order_by(AuditLog.created_at.desc()).limit(20).all() if current_user.role.name == 'admin' else []
        return render_template('admin/dashboard.html', stats=stats, audit_logs=audit_logs)

    @admin_bp.route('/api/stats')
    @login_required
    @require_role('admin', 'kepala_qc')
    def api_stats():
        from sqlalchemy import func
        from datetime import datetime, timedelta

        base_q = QcHold.query.filter(~QcHold.qc_code.like('QC-IMP-%'))
        total_ng_q = db.session.query(func.coalesce(func.sum(QcHold.qty_ng), 0)).filter(~QcHold.qc_code.like('QC-IMP-%'))
        total_ok_q = db.session.query(func.coalesce(func.sum(QcHold.qty_ok), 0)).filter(~QcHold.qc_code.like('QC-IMP-%'))

        q_monthly = db.session.query(
            func.date_format(QcHold.inspection_date, '%Y-%m').label('month'),
            func.coalesce(func.sum(QcHold.qty_ng), 0).label('total_ng')
        ).filter(~QcHold.qc_code.like('QC-IMP-%'))

        q_defect = db.session.query(DefectCategory.name, func.count(QcHold.id)).join(
            QcHold, QcHold.defect_category_id == DefectCategory.id
        ).filter(~QcHold.qc_code.like('QC-IMP-%'))
        q_decision = db.session.query(DecisionAction.label, func.count(QcHold.id)).join(
            QcHold, QcHold.decision_action_id == DecisionAction.id
        ).filter(~QcHold.qc_code.like('QC-IMP-%'))

        total_qc = base_q.count()
        total_ng_val = total_ng_q.scalar()
        total_ok_val = total_ok_q.scalar()

        def _count_code(code):
            action = DecisionAction.query.filter_by(code=code).first()
            return base_q.filter(QcHold.decision_action_id == action.id).count() if action else 0

        summary = {
            'total_qc_hold': total_qc,
            'total_open': base_q.filter(QcHold.status == 'OPEN').count(),
            'total_close': base_q.filter(QcHold.status == 'CLOSE').count(),
            'total_repair': _count_code('REPAIR'),
            'total_rework': _count_code('REWORK'),
            'total_disposisi': _count_code('DISPOSISI'),
            'total_disposal': _count_code('DISPOSAL'),
        }

        six_months_ago = datetime.utcnow() - timedelta(days=180)
        monthly_ng = q_monthly.filter(QcHold.inspection_date >= six_months_ago).group_by('month').order_by('month').all()
        defect_dist = q_defect.group_by(DefectCategory.name).all()
        decision_dist = q_decision.group_by(DecisionAction.label).all()
        recent = base_q.order_by(QcHold.created_at.desc()).limit(10).all()

        return jsonify({
            'summary': summary,
            'monthly_ng': [{'month': r.month, 'count': int(r.total_ng)} for r in monthly_ng],
            'defect_distribution': [{'label': n, 'count': c} for n, c in defect_dist],
            'ok_ng_ratio': {'total_ok': int(total_ok_val), 'total_ng': int(total_ng_val)},
            'decision_distribution': [{'label': l, 'count': c} for l, c in decision_dist],
            'recent_qc': [r.to_dict() for r in recent],
        })

    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_bp)

    # Register admin sub-blueprints
    from .admin.users import bp as users_bp
    from .admin.master_data import bp as master_bp
    from .admin.qc_hold import bp as qc_bp
    from .admin.datasets import bp as datasets_bp
    from .admin.reports import bp as reports_bp
    from .admin.profile import bp as profile_bp
    from .admin.c45 import bp as c45_bp
    from .admin.model_ml import bp as model_ml_bp
    app.register_blueprint(users_bp)
    app.register_blueprint(master_bp)
    app.register_blueprint(qc_bp)
    app.register_blueprint(datasets_bp)
    app.register_blueprint(reports_bp)
    app.register_blueprint(profile_bp)
    app.register_blueprint(c45_bp)
    app.register_blueprint(model_ml_bp)

    # Register qc_line blueprint
    from .qc_line.routes import bp as qc_line_bp
    app.register_blueprint(qc_line_bp)

    # Register kepala_qc blueprint
    from .kepala_qc.routes import bp as kepala_qc_bp
    app.register_blueprint(kepala_qc_bp)

    # Root redirect — arahkan ke dashboard sesuai role
    @app.route('/')
    def index():
        if current_user.is_authenticated:
            role_name = current_user.role.name if current_user.role else None
            return redirect(_dashboard_url_for_role(role_name))
        return redirect(url_for('auth.login'))

    return app
