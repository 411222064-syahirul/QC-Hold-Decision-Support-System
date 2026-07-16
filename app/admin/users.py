"""Admin user & role management blueprint."""
from flask import Blueprint, render_template, request, jsonify, flash, redirect, url_for
from flask_login import login_required, current_user
from app.models import db, User, Role
from app.auth import require_role, log_audit

bp = Blueprint('admin_users', __name__, url_prefix='/admin')


# ── Pages ──────────────────────────────────────────────────────────────────

@bp.route('/users')
@login_required
@require_role('admin')
def users_page():
    roles = Role.query.all()
    return render_template('admin/users.html', roles=roles)


@bp.route('/roles')
@login_required
@require_role('admin')
def roles_page():
    return render_template('admin/roles.html')


# ── API: Users ─────────────────────────────────────────────────────────────

@bp.route('/api/users', methods=['GET'])
@login_required
@require_role('admin')
def list_users():
    users = User.query.order_by(User.created_at.desc()).all()
    return jsonify([u.to_dict() for u in users])


@bp.route('/api/users', methods=['POST'])
@login_required
@require_role('admin')
def create_user():
    d = request.json
    if User.query.filter((User.username == d['username']) | (User.email == d['email'])).first():
        return jsonify({'error': 'Username atau email sudah digunakan'}), 409
    
    if d.get('nip') and User.query.filter_by(nip=d.get('nip')).first():
        return jsonify({'error': f"NIP {d.get('nip')} sudah digunakan oleh user lain"}), 409
    u = User(username=d['username'], email=d['email'],
             full_name=d.get('full_name'), nip=d.get('nip'), role_id=d.get('role_id') or None,
             is_active=d.get('is_active', True))
    u.set_password(d['password'])
    db.session.add(u)
    db.session.commit()
    log_audit('CREATE', 'users', u.id, {'username': u.username})
    return jsonify(u.to_dict()), 201


@bp.route('/api/users/<int:uid>', methods=['PUT'])
@login_required
@require_role('admin')
def update_user(uid):
    u = User.query.get_or_404(uid)
    d = request.json
    
    if d.get('nip') and d.get('nip') != u.nip:
        if User.query.filter_by(nip=d.get('nip')).first():
            return jsonify({'error': f"NIP {d.get('nip')} sudah digunakan oleh user lain"}), 409

    u.full_name = d.get('full_name', u.full_name)
    u.nip = d.get('nip', u.nip)
    u.email = d.get('email', u.email)
    u.role_id = d.get('role_id') or None
    u.is_active = d.get('is_active', u.is_active)
    if d.get('password'):
        u.set_password(d['password'])
    db.session.commit()
    log_audit('UPDATE', 'users', uid, {'username': u.username})
    return jsonify(u.to_dict())


@bp.route('/api/users/<int:uid>', methods=['DELETE'])
@login_required
@require_role('admin')
def delete_user(uid):
    if uid == current_user.id:
        return jsonify({'error': 'Tidak dapat menghapus akun sendiri'}), 400
    u = User.query.get_or_404(uid)
    username = u.username
    db.session.delete(u)
    db.session.commit()
    log_audit('DELETE', 'users', uid, {'username': username})
    return jsonify({'ok': True})


# ── API: Roles ─────────────────────────────────────────────────────────────

@bp.route('/api/roles', methods=['GET'])
@login_required
def list_roles():
    return jsonify([r.to_dict() for r in Role.query.all()])


@bp.route('/api/roles', methods=['POST'])
@login_required
@require_role('admin')
def create_role():
    d = request.json
    if Role.query.filter_by(name=d['name']).first():
        return jsonify({'error': 'Nama role sudah ada'}), 409
    r = Role(name=d['name'], description=d.get('description'))
    db.session.add(r)
    db.session.commit()
    log_audit('CREATE', 'roles', r.id, {'name': r.name})
    return jsonify(r.to_dict()), 201


@bp.route('/api/roles/<int:rid>', methods=['PUT'])
@login_required
@require_role('admin')
def update_role(rid):
    r = Role.query.get_or_404(rid)
    d = request.json
    r.name = d.get('name', r.name)
    r.description = d.get('description', r.description)
    db.session.commit()
    log_audit('UPDATE', 'roles', rid, {'name': r.name})
    return jsonify(r.to_dict())


@bp.route('/api/roles/<int:rid>', methods=['DELETE'])
@login_required
@require_role('admin')
def delete_role(rid):
    r = Role.query.get_or_404(rid)
    if r.users.count() > 0:
        return jsonify({'error': f'Role masih digunakan oleh {r.users.count()} user'}), 400
    db.session.delete(r)
    db.session.commit()
    log_audit('DELETE', 'roles', rid, {'name': r.name})
    return jsonify({'ok': True})
