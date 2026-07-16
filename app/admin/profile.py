from flask import Blueprint, jsonify, request, render_template
from flask_login import login_required, current_user

from app.models import db, User
from .qc_hold import log_audit

bp = Blueprint('admin_profile', __name__, url_prefix='/admin')

@bp.route('/profile')
@login_required
def profile_page():
    return render_template('admin/profile.html')

@bp.route('/api/profile', methods=['PUT'])
@login_required
def update_profile():
    data = request.json
    current_user.full_name = data.get('full_name', current_user.full_name)
    current_user.email = data.get('email', current_user.email)
    
    db.session.commit()
    log_audit('UPDATE_PROFILE', 'users', current_user.id)
    return jsonify(current_user.to_dict())

@bp.route('/api/profile/password', methods=['PUT'])
@login_required
def change_password():
    data = request.json
    current_password = data.get('current_password')
    new_password = data.get('new_password')
    
    if not current_password or not new_password:
        return jsonify({'error': 'Password saat ini dan password baru wajib diisi'}), 400
        
    if not current_user.check_password(current_password):
        return jsonify({'error': 'Password saat ini salah'}), 400
        
    if len(new_password) < 6:
        return jsonify({'error': 'Password baru minimal 6 karakter'}), 400
        
    current_user.set_password(new_password)
    db.session.commit()
    log_audit('CHANGE_PASSWORD', 'users', current_user.id)
    return jsonify({'success': True})
