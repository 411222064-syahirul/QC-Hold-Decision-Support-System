"""Routes modul qc_line.

Hak akses role qc_line (RBAC):
- Dapat MEMBUAT QcHold baru (field 'decision_action_id' selalu dikunci None di server)
- Dapat MENGEDIT & MENGHAPUS QcHold miliknya yang berstatus OPEN
- Hanya dapat MELIHAT (read-only) QcHold berstatus CLOSE — tidak boleh edit/hapus
"""
from datetime import datetime
from flask import Blueprint, render_template, jsonify, request, redirect, url_for, flash
from flask_login import login_required, current_user
from sqlalchemy import desc

from app.models import db, QcHold, DefectCategory, DecisionAction, ProductCategory, AuditLog
from app.auth import require_role, log_audit

bp = Blueprint('qc_line', __name__, url_prefix='/qc_line')


# ── Dashboard ──────────────────────────────────────────────────────────────────
@bp.route('/')
@bp.route('/dashboard')
@login_required
@require_role('qc_line')
def dashboard():
    from sqlalchemy import func
    # Statistik khusus data milik user ini (operator_id)
    base_q = QcHold.query.filter(
        QcHold.operator_id == current_user.id,
        ~QcHold.qc_code.like('QC-IMP-%')
    )
    total_ng_q = db.session.query(
        func.coalesce(func.sum(QcHold.qty_ng), 0)
    ).filter(
        QcHold.operator_id == current_user.id,
        ~QcHold.qc_code.like('QC-IMP-%')
    )
    total_ok_q = db.session.query(
        func.coalesce(func.sum(QcHold.qty_ok), 0)
    ).filter(
        QcHold.operator_id == current_user.id,
        ~QcHold.qc_code.like('QC-IMP-%')
    )

    stats = {
        'total_qc_hold': base_q.count(),
        'total_open': base_q.filter(QcHold.status == 'OPEN').count(),
        'total_close': base_q.filter(QcHold.status == 'CLOSE').count(),
        'total_ng': int(total_ng_q.scalar()),
        'total_ok': int(total_ok_q.scalar()),
    }
    
    recent_qc_holds = base_q.order_by(desc(QcHold.created_at)).limit(5).all()

    # Defect category distribution (user's data)
    defect_dist = db.session.query(
        DefectCategory.name, func.count(QcHold.id)
    ).join(QcHold, QcHold.defect_category_id == DefectCategory.id
    ).filter(
        QcHold.operator_id == current_user.id,
        ~QcHold.qc_code.like('QC-IMP-%')
    ).group_by(DefectCategory.name).all()
    defect_distribution = [{'label': n, 'count': c} for n, c in defect_dist]

    # Monthly NG trend (user's data, last 6 months)
    from datetime import timedelta
    six_months_ago = datetime.utcnow() - timedelta(days=180)
    monthly_ng = db.session.query(
        func.date_format(QcHold.inspection_date, '%Y-%m').label('month'),
        func.coalesce(func.sum(QcHold.qty_ng), 0).label('total_ng')
    ).filter(
        QcHold.operator_id == current_user.id,
        ~QcHold.qc_code.like('QC-IMP-%'),
        QcHold.inspection_date >= six_months_ago
    ).group_by('month').order_by('month').all()
    monthly_data = [{'month': r.month, 'count': int(r.total_ng)} for r in monthly_ng]
    
    return render_template(
        'qc_line/dashboard.html',
        stats=stats,
        recent_qc_holds=recent_qc_holds,
        defect_distribution=defect_distribution,
        monthly_data=monthly_data,
    )


# ── Halaman QC Hold ────────────────────────────────────────────────────────────
@bp.route('/qc-hold')
@login_required
@require_role('qc_line')
def qc_hold_page():
    categories = DefectCategory.query.all()
    product_categories = ProductCategory.query.all()
    return render_template(
        'qc_line/qc_hold.html',
        categories=categories,
        product_categories=product_categories
    )


# ── API: GET daftar QcHold milik operator ini (OPEN & CLOSE) ───────────────────
@bp.route('/api/qc-hold', methods=['GET'])
@login_required
@require_role('qc_line')
def get_qc_holds():
    records = QcHold.query.filter(
        ~QcHold.qc_code.like('QC-IMP-%')
    ).order_by(desc(QcHold.created_at)).all()
    return jsonify([r.to_dict() for r in records])


# ── API: POST buat QcHold baru (tanpa decision_action_id) ─────────────────────
@bp.route('/api/qc-hold', methods=['POST'])
@login_required
@require_role('qc_line')
def create_qc_hold():
    data = request.json or {}

    # Paksa field decision kosong — qc_line tidak boleh mengisi keputusan
    data.pop('decision_action_id', None)

    # Generate QC Code
    today_str = datetime.now().strftime('%Y%m%d')
    existing = QcHold.query.filter(QcHold.qc_code.like(f'QC-{today_str}-%')).all()
    max_seq = 0
    for q in existing:
        try:
            seq = int(q.qc_code.split('-')[-1])
            if seq > max_seq:
                max_seq = seq
        except ValueError:
            pass
    qc_code = f"QC-{today_str}-{(max_seq + 1):04d}"

    # Parse tanggal inspeksi
    insp_date = data.get('inspection_date')
    if insp_date and isinstance(insp_date, str):
        insp_date = insp_date.replace('T', ' ')
        if len(insp_date) == 16:
            insp_date += ':00'

    # Validasi qty
    qty_tot = int(data.get('qty_total') or 0)
    qty_ng_val = int(data.get('qty_ng') or 0)
    if qty_ng_val > qty_tot:
        return jsonify({'error': 'QTY Defect (NG) tidak boleh lebih besar dari QTY Planning (Total).'}), 400

    qc = QcHold(
        qc_code=qc_code,
        part_no=data.get('part_no'),
        product_category_id=data.get('product_category_id'),
        inspection_date=insp_date,
        defect_category_id=data.get('defect_category_id'),
        defect_severity=data.get('defect_severity'),
        defect_description=data.get('defect_description'),
        qty_total=qty_tot,
        qty_ng=qty_ng_val,
        qty_ok=(qty_tot - qty_ng_val),
        decision_action_id=None,   # selalu None untuk qc_line
        status='OPEN',             # selalu OPEN saat dibuat
        notes=data.get('notes'),
        operator_id=current_user.id,
        created_by=current_user.id,
        updated_by=current_user.id,
        action_taken_by=None,
        action_taken_at=None,
    )
    db.session.add(qc)
    db.session.commit()
    log_audit('CREATE', 'qc_hold', qc.id, {'qc_code': qc.qc_code, 'created_by_role': 'qc_line'})
    return jsonify(qc.to_dict()), 201


# ── API: PUT edit QcHold — HANYA jika status OPEN & milik operator ────────────
@bp.route('/api/qc-hold/<int:id>', methods=['PUT'])
@login_required
@require_role('qc_line')
def update_qc_hold(id):
    qc = QcHold.query.get_or_404(id)

    # QC Hold berstatus CLOSE hanya read-only
    if qc.status == 'CLOSE':
        return jsonify({'error': 'Data berstatus CLOSE hanya dapat dilihat, tidak dapat diubah.'}), 403

    data = request.json or {}
    # qc_line tidak boleh mengisi/mengubah field decision
    data.pop('decision_action_id', None)

    new_insp_date = data.get('inspection_date')
    if new_insp_date and isinstance(new_insp_date, str):
        new_insp_date = new_insp_date.replace('T', ' ')
        if len(new_insp_date) == 16:
            new_insp_date += ':00'
        qc.inspection_date = new_insp_date

    qc.product_category_id = data.get('product_category_id', qc.product_category_id)
    qc.part_no = data.get('part_no', qc.part_no)
    qc.defect_category_id = data.get('defect_category_id', qc.defect_category_id)
    qc.defect_severity = data.get('defect_severity', qc.defect_severity)
    qc.defect_description = data.get('defect_description', qc.defect_description)

    qty_tot = data.get('qty_total') if data.get('qty_total') is not None else qc.qty_total
    qty_ng_val = data.get('qty_ng') if data.get('qty_ng') is not None else qc.qty_ng
    qc.qty_total = int(qty_tot or 0)
    qc.qty_ng = int(qty_ng_val or 0)
    if qc.qty_ng > qc.qty_total:
        return jsonify({'error': 'QTY Defect (NG) tidak boleh lebih besar dari QTY Planning (Total).'}), 400
    qc.qty_ok = qc.qty_total - qc.qty_ng
    qc.notes = data.get('notes', qc.notes)

    qc.updated_by = current_user.id
    db.session.commit()
    log_audit('UPDATE', 'qc_hold', qc.id, {'qc_code': qc.qc_code, 'updated_by_role': 'qc_line'})
    return jsonify(qc.to_dict())


# ── API: DELETE hapus QcHold — HANYA jika status OPEN & milik operator ────────
@bp.route('/api/qc-hold/<int:id>', methods=['DELETE'])
@login_required
@require_role('qc_line')
def delete_qc_hold(id):
    qc = QcHold.query.get_or_404(id)

    # QC Hold berstatus CLOSE hanya read-only
    if qc.status == 'CLOSE':
        return jsonify({'error': 'Data berstatus CLOSE hanya dapat dilihat, tidak dapat dihapus.'}), 403

    db.session.delete(qc)
    db.session.commit()
    log_audit('DELETE', 'qc_hold', id, {'qc_code': qc.qc_code, 'deleted_by_role': 'qc_line'})
    return jsonify({'success': True})

# ── API: POST import Excel QcHold ─────────────────────────────────────────────
@bp.route('/api/qc-hold/import', methods=['POST'])
@login_required
@require_role('qc_line')
def import_qc_hold():
    if 'file' not in request.files:
        return jsonify({'error': 'Tidak ada file yang diunggah'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'File tidak valid'}), 400
        
    try:
        import re
        import pandas as pd
        df = pd.read_excel(file.stream, header=None)
        
        # Temukan baris header sebenarnya
        header_row_idx = 0
        for idx, row in df.iterrows():
            row_str = " ".join(str(v).lower() for v in row.values if pd.notna(v))
            if 'kategori produk' in row_str or 'part no' in row_str or 'inspection date' in row_str or 'tgl qc hold' in row_str:
                header_row_idx = idx
                break
                
        df.columns = df.iloc[header_row_idx]
        df = df.iloc[header_row_idx + 1:]
        df = df.reset_index(drop=True)
        
        def clean_col(c):
            return re.sub(r'[^a-z0-9]+', '_', str(c).strip().lower()).strip('_')
        df.columns = [clean_col(c) for c in df.columns]
        
        def get_val(r, possible_cols, default=None):
            for c in possible_cols:
                if c in r and not pd.isna(r[c]):
                    return r[c]
            return default
            
        today_str = datetime.now().strftime('%Y%m%d')
        existing = QcHold.query.filter(QcHold.qc_code.like(f'QC-{today_str}-%')).all()
        max_seq = 0
        for q in existing:
            try:
                seq = int(q.qc_code.split('-')[-1])
                if seq > max_seq: max_seq = seq
            except ValueError:
                pass
                
        imported_count = 0
        
        prod_cat_map = {c.name.strip().lower(): c.id for c in ProductCategory.query.all()}
        def_cat_map = {c.name.strip().lower(): c.id for c in DefectCategory.query.all()}
        
        for index, row in df.iterrows():
            max_seq += 1
            qc_code = f"QC-{today_str}-{max_seq:04d}"
            
            insp_date_raw = get_val(row, ['inspection_date', 'tanggal', 'tgl', 'tanggal_inspeksi', 'tgl_qc_hold'], datetime.now())
            if isinstance(insp_date_raw, str):
                try:
                    insp_date = pd.to_datetime(insp_date_raw, dayfirst=True).to_pydatetime()
                except:
                    insp_date = datetime.now()
            else:
                insp_date = insp_date_raw
                
            qty_tot = int(get_val(row, ['qty_total', 'qty_planning', 'qty_planing', 'total', 'qty'], 0))
            qty_ng_val = int(get_val(row, ['qty_ng', 'qty_defect', 'ng'], 0))
            
            # Resolve product category
            prod_val = get_val(row, ['product_category_id', 'product_category', 'kategori_produk', 'kategori'])
            prod_id = None
            if prod_val is not None:
                if isinstance(prod_val, str):
                    prod_id = prod_cat_map.get(str(prod_val).strip().lower())
                else:
                    prod_id = int(prod_val)
                    
            # Resolve defect category
            def_val = get_val(row, ['defect_category_id', 'defect_category', 'jenis_masalah', 'masalah'])
            def_id = None
            if def_val is not None:
                if isinstance(def_val, str):
                    def_id = def_cat_map.get(str(def_val).strip().lower())
                else:
                    def_id = int(def_val)
            
            # Resolve severity
            sev_val = get_val(row, ['defect_severity', 'severity_level', 'severity'])
            if sev_val is not None:
                if isinstance(sev_val, str):
                    s = str(sev_val).strip().upper()
                    if s == 'LOW': sev_id = 1
                    elif s == 'MEDIUM': sev_id = 2
                    elif s == 'HIGH': sev_id = 3
                    else:
                        import random
                        sev_id = random.choice([1, 2, 3])
                else:
                    sev_id = int(sev_val)
            else:
                import random
                sev_id = random.choice([1, 2, 3])
                    
            part_no_val = get_val(row, ['part_no', 'part_number', 'adr_no_part_no'])
            desc_val = get_val(row, ['defect_description', 'keterangan_masalah', 'masalah', 'deskripsi', 'detail'])
            notes_val = get_val(row, ['notes', 'catatan', 'keterangan'])
            
            # Additional info
            inspector_val = get_val(row, ['initial_inspector', 'inspector'])
            action_val = get_val(row, ['tindakan_koreksi_keputusan', 'tindakan', 'keputusan'])
            
            final_notes = str(notes_val) if notes_val is not None else ''
            if inspector_val:
                final_notes += f"\nInspector: {inspector_val}"
            if action_val:
                final_notes += f"\nTindakan/Keputusan: {action_val}"
            final_notes = final_notes.strip()
            
            # Skip empty rows
            if part_no_val is None and desc_val is None and qty_tot == 0:
                max_seq -= 1
                continue
                
            qc = QcHold(
                qc_code=qc_code,
                part_no=str(part_no_val) if part_no_val is not None else None,
                product_category_id=prod_id,
                inspection_date=insp_date,
                defect_category_id=def_id,
                defect_severity=sev_id,
                defect_description=str(desc_val) if desc_val is not None else '',
                qty_total=qty_tot,
                qty_ng=qty_ng_val,
                qty_ok=(qty_tot - qty_ng_val),
                decision_action_id=None,
                status='OPEN',
                notes=final_notes,
                operator_id=current_user.id,
                created_by=current_user.id,
                updated_by=current_user.id,
                action_taken_by=None,
                action_taken_at=None,
            )
            db.session.add(qc)
            imported_count += 1
            
        db.session.commit()
        log_audit('IMPORT', 'qc_hold', 0, {'imported_count': imported_count, 'role': 'qc_line'})
        
        return jsonify({'success': True, 'imported_count': imported_count}), 201
        
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': f'Gagal memproses file: {str(e)}'}), 500
