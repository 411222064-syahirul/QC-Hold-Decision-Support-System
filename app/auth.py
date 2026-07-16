"""Auth helpers — session login + RBAC decorator + audit logger."""
from functools import wraps
from flask import redirect, url_for, flash, request, jsonify
from flask_login import LoginManager, current_user
from .models import db, AuditLog

login_manager = LoginManager()
login_manager.login_view = 'auth.login'
login_manager.login_message = 'Silakan login terlebih dahulu.'
login_manager.login_message_category = 'warning'


def init_login(app):
    login_manager.init_app(app)

    @login_manager.user_loader
    def load_user(user_id):
        from .models import User
        return User.query.get(int(user_id))


def _is_api_request():
    """Cek apakah request adalah panggilan API (JSON), bukan navigasi halaman."""
    return (request.path.startswith('/api/')
            or '/api/' in request.path
            or request.headers.get('X-Requested-With') == 'XMLHttpRequest'
            or request.accept_mimetypes.accept_json)


def _dashboard_for_role(role_name):
    """Kembalikan endpoint dashboard sesuai role user."""
    if role_name == 'qc_line':
        return 'qc_line.dashboard'
    elif role_name == 'kepala_qc':
        return 'kepala_qc.dashboard'
    return 'admin.dashboard'


def require_role(*roles):
    """Decorator: pastikan current_user memiliki salah satu role yang diizinkan."""
    def decorator(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            if not current_user.is_authenticated:
                if _is_api_request():
                    return jsonify({'error': 'Unauthorized'}), 401
                return redirect(url_for('auth.login'))
            user_role = current_user.role.name if current_user.role else None
            if user_role not in roles:
                if _is_api_request():
                    return jsonify({'error': 'Anda tidak memiliki akses ke fungsi ini'}), 403
                flash('Anda tidak memiliki akses ke halaman ini.', 'danger')
                return redirect(url_for(_dashboard_for_role(user_role)))
            return f(*args, **kwargs)
        return wrapped
    return decorator


def log_audit(action, table, target_id=None, details=None):
    """Catat aktivitas ke audit_log."""
    try:
        uid = current_user.id if current_user.is_authenticated else None
        entry = AuditLog(user_id=uid, action=action, target_table=table,
                         target_id=str(target_id) if target_id else None, details=details)
        db.session.add(entry)
        db.session.commit()
    except Exception:
        db.session.rollback()
