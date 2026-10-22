"""Admin master data management — defect categories, types, decision actions."""
from flask import Blueprint, render_template, request, jsonify
from flask_login import login_required
from app.models import db, DefectCategory, DecisionAction, ProductCategory, QcHold
from app.auth import require_role, log_audit

bp = Blueprint('admin_master', __name__, url_prefix='/admin')


# ── Pages ──────────────────────────────────────────────────────────────────

@bp.route('/defect-categories')
@login_required
@require_role('admin')
def defect_categories_page():
    return render_template('admin/defect_categories.html')

@bp.route('/product-categories')
@login_required
@require_role('admin')
def product_categories_page():
    return render_template('admin/product_categories.html')




@bp.route('/decision-actions')
@login_required
@require_role('admin')
def decision_actions_page():
    return render_template('admin/decision_actions.html')


# ── API: Defect Category ───────────────────────────────────────────────────

@bp.route('/api/defect-categories', methods=['GET'])
@login_required
def list_defect_categories():
    return jsonify([c.to_dict() for c in DefectCategory.query.all()])


@bp.route('/api/defect-categories', methods=['POST'])
@login_required
@require_role('admin')
def create_defect_category():
    d = request.json
    c = DefectCategory(name=d['name'], description=d.get('description'))
    db.session.add(c)
    db.session.commit()
    log_audit('CREATE', 'defect_category', c.id, {'name': c.name})
    return jsonify(c.to_dict()), 201


@bp.route('/api/defect-categories/<int:cid>', methods=['PUT'])
@login_required
@require_role('admin')
def update_defect_category(cid):
    c = DefectCategory.query.get_or_404(cid)
    d = request.json
    c.name = d.get('name', c.name)
    c.description = d.get('description', c.description)
    db.session.commit()
    log_audit('UPDATE', 'defect_category', cid, {'name': c.name})
    return jsonify(c.to_dict())


@bp.route('/api/defect-categories/<int:cid>', methods=['DELETE'])
@login_required
@require_role('admin')
def delete_defect_category(cid):
    c = DefectCategory.query.get_or_404(cid)
    # Cek relasi QC Hold
    count = QcHold.query.filter_by(defect_category_id=cid).count()
    if count > 0:
        return jsonify({'error': f'Kategori masih digunakan di {count} data QC Hold'}), 400
    db.session.delete(c)
    db.session.commit()
    log_audit('DELETE', 'defect_category', cid, {'name': c.name})
    return jsonify({'ok': True})


# ── API: Decision Action ───────────────────────────────────────────────────

LOCKED_DECISION_CODES = ('REWORK', 'DISPOSISI', 'DISPOSAL')


@bp.route('/api/decision-actions', methods=['GET'])
@login_required
def list_decision_actions():
    actions = DecisionAction.query.filter(DecisionAction.code.in_(LOCKED_DECISION_CODES)).all()
    order_map = {'REWORK': 1, 'DISPOSISI': 2, 'DISPOSAL': 3}
    actions.sort(key=lambda a: order_map.get(a.code.upper(), 99))
    return jsonify([a.to_dict() for a in actions])


@bp.route('/api/decision-actions', methods=['POST'])
@login_required
def create_decision_action():
    return jsonify({'error': 'Decision Action dikunci (hanya REWORK, DISPOSISI, DISPOSAL). Tidak dapat menambah data.'}), 403


@bp.route('/api/decision-actions/<int:aid>', methods=['PUT'])
@login_required
def update_decision_action(aid):
    return jsonify({'error': 'Decision Action dikunci (hanya REWORK, DISPOSISI, DISPOSAL). Tidak dapat mengubah data.'}), 403


@bp.route('/api/decision-actions/<int:aid>', methods=['DELETE'])
@login_required
def delete_decision_action(aid):
    return jsonify({'error': 'Decision Action dikunci (hanya REWORK, DISPOSISI, DISPOSAL). Tidak dapat menghapus data.'}), 403


# ?? API: Product Categories ???????????????????????????????????????????????????
@bp.route('/api/product-categories', methods=['GET'])
@login_required
def get_product_categories():
    cats = ProductCategory.query.order_by(ProductCategory.name.asc()).all()
    return jsonify([c.to_dict() for c in cats])

@bp.route('/api/product-categories', methods=['POST'])
@login_required
@require_role('admin')
def create_product_category():
    data = request.json
    if not data or not data.get('name'):
        return jsonify({'error': 'Nama kategori produk wajib diisi'}), 400
        
    exist = ProductCategory.query.filter_by(name=data['name'].strip()).first()
    if exist:
        return jsonify({'error': 'Kategori produk sudah ada'}), 400
        
    cat = ProductCategory(
        name=data['name'].strip(),
        description=data.get('description', '').strip()
    )
    db.session.add(cat)
    db.session.commit()
    
    log_audit('CREATE_PRODUCT_CAT', f'Kategori Produk: {cat.name}')
    return jsonify({'message': 'Kategori produk berhasil ditambahkan', 'category': cat.to_dict()}), 201

@bp.route('/api/product-categories/<int:id>', methods=['PUT'])
@login_required
@require_role('admin')
def update_product_category(id):
    cat = ProductCategory.query.get_or_404(id)
    data = request.json
    
    if 'name' in data and data['name'].strip():
        new_name = data['name'].strip()
        if new_name != cat.name:
            exist = ProductCategory.query.filter_by(name=new_name).first()
            if exist:
                return jsonify({'error': 'Kategori produk sudah ada'}), 400
            cat.name = new_name
            
    if 'description' in data:
        cat.description = data['description'].strip()
        
    db.session.commit()
    log_audit('UPDATE_PRODUCT_CAT', f'Kategori Produk ID: {cat.id}')
    return jsonify({'message': 'Kategori produk berhasil diupdate', 'category': cat.to_dict()})

@bp.route('/api/product-categories/<int:id>', methods=['DELETE'])
@login_required
@require_role('admin')
def delete_product_category(id):
    cat = ProductCategory.query.get_or_404(id)
    name = cat.name
    db.session.delete(cat)
    db.session.commit()
    log_audit('DELETE_PRODUCT_CAT', f'Kategori Produk: {name}')
    return jsonify({'message': 'Kategori produk berhasil dihapus'})
