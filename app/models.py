"""SQLAlchemy ORM models — QC System."""
from datetime import datetime
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()


class Role(db.Model):
    __tablename__ = 'roles'
    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    name = db.Column(db.String(100), unique=True, nullable=False)
    description = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    users = db.relationship('User', backref='role', lazy='dynamic')

    def to_dict(self):
        return {'id': self.id, 'name': self.name, 'description': self.description,
                'created_at': str(self.created_at), 'user_count': self.users.count()}


class User(UserMixin, db.Model):
    __tablename__ = 'users'
    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    username = db.Column(db.String(100), unique=True, nullable=False)
    nip = db.Column(db.String(50), unique=True)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    full_name = db.Column(db.String(255))
    role_id = db.Column(db.BigInteger, db.ForeignKey('roles.id', ondelete='SET NULL'))
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def set_password(self, password): self.password_hash = generate_password_hash(password)
    def check_password(self, password): return check_password_hash(self.password_hash, password)

    def to_dict(self):
        return {
            'id': self.id,
            'username': self.username,
            'nip': self.nip,
            'email': self.email,
            'full_name': self.full_name,
            'role_id': self.role_id,
            'role': self.role.name if self.role else None,
            'is_active': self.is_active,
            'created_at': str(self.created_at)
        }


class DefectCategory(db.Model):
    __tablename__ = 'defect_category'
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name = db.Column(db.String(150), nullable=False)
    description = db.Column(db.Text)

    def to_dict(self):
        return {'id': self.id, 'name': self.name, 'description': self.description}


class ProductCategory(db.Model):
    __tablename__ = 'product_category'
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name = db.Column(db.String(100), unique=True, nullable=False)
    description = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'created_at': str(self.created_at)
        }

class DecisionAction(db.Model):
    __tablename__ = 'decision_action'
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    code = db.Column(db.String(50), unique=True, nullable=False)
    label = db.Column(db.String(100), nullable=False)
    description = db.Column(db.Text)

    def to_dict(self):
        return {'id': self.id, 'code': self.code, 'label': self.label, 'description': self.description}


class QcHold(db.Model):
    __tablename__ = 'qc_hold'
    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    qc_code = db.Column(db.String(80), unique=True, nullable=False)
    part_no = db.Column(db.String(100))
    product_category_id = db.Column(db.Integer, db.ForeignKey('product_category.id', ondelete='SET NULL'))
    inspection_date = db.Column(db.DateTime, nullable=False)
    operator_id = db.Column(db.BigInteger, db.ForeignKey('users.id', ondelete='SET NULL'))
    defect_category_id = db.Column(db.Integer, db.ForeignKey('defect_category.id', ondelete='SET NULL'))
    defect_severity = db.Column(db.SmallInteger)
    defect_description = db.Column(db.Text)
    qty_total = db.Column(db.Integer, default=0)
    qty_ng = db.Column(db.Integer, default=0)
    qty_ok = db.Column(db.Integer, default=0)
    image_url = db.Column(db.Text)
    decision_action_id = db.Column(db.Integer, db.ForeignKey('decision_action.id', ondelete='SET NULL'))
    decision_status = db.Column(db.String(10))
    action_taken_by = db.Column(db.BigInteger, db.ForeignKey('users.id', ondelete='SET NULL'))
    action_taken_at = db.Column(db.DateTime)
    c45_record_id = db.Column(db.BigInteger)
    status = db.Column(db.String(10), default='OPEN')
    notes = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    created_by = db.Column(db.BigInteger, db.ForeignKey('users.id', ondelete='SET NULL'))
    updated_by = db.Column(db.BigInteger, db.ForeignKey('users.id', ondelete='SET NULL'))

    operator = db.relationship('User', foreign_keys=[operator_id])
    product_category = db.relationship('ProductCategory', foreign_keys=[product_category_id])
    defect_category = db.relationship('DefectCategory', foreign_keys=[defect_category_id])
    decision_action = db.relationship('DecisionAction', foreign_keys=[decision_action_id])
    creator = db.relationship('User', foreign_keys=[created_by])
    updater = db.relationship('User', foreign_keys=[updated_by])
    action_taker = db.relationship('User', foreign_keys=[action_taken_by])

    def to_dict(self):
        return {
            'id': self.id, 'qc_code': self.qc_code, 'part_no': self.part_no, 'product_category_id': self.product_category_id,
            'product_category': self.product_category.name if self.product_category else None,
            'inspection_date': str(self.inspection_date),
            'qty_total': self.qty_total, 'qty_ng': self.qty_ng, 'qty_ok': self.qty_ok,
            'defect_category': self.defect_category.name if self.defect_category else None,
            'defect_category_id': self.defect_category_id,
            'defect_severity': self.defect_severity,
            'decision_action': self.decision_action.label if self.decision_action else None,
            'decision_action_code': self.decision_action.code if self.decision_action else None,
            'decision_action_id': self.decision_action_id,
            'decision_status': self.decision_status or (
                ('NO' if ('DISPOSAL' in self.decision_action.code.upper() or 'SCRAP' in self.decision_action.code.upper()) else 'YES')
                if self.decision_action else None
            ),
            'c45_record_id': getattr(self, 'c45_record_id', None),
            'status': getattr(self, 'status', None),
            'notes': getattr(self, 'notes', None),
            'defect_description': self.defect_description,
            'created_at': str(self.created_at),
            'created_by_name': self.creator.full_name if self.creator and self.creator.full_name else (self.creator.username if self.creator else None),
            'updated_by_name': self.updater.full_name if self.updater and self.updater.full_name else (self.updater.username if self.updater else None),
            'action_taken_by_name': self.action_taker.full_name if self.action_taker and self.action_taker.full_name else (self.action_taker.username if self.action_taker else None),
        }


class MLModel(db.Model):
    __tablename__ = 'models'
    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    name = db.Column(db.String(200), nullable=False)
    algorithm = db.Column(db.String(100), default='C4.5')
    version = db.Column(db.String(50))
    trained_at = db.Column(db.DateTime)
    dataset_id = db.Column(db.BigInteger)
    model_file_path = db.Column(db.Text)
    parameters = db.Column(db.JSON)
    is_active = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {'id': self.id, 'name': self.name, 'algorithm': self.algorithm,
                'version': self.version, 'trained_at': str(self.trained_at) if self.trained_at else None,
                'is_active': self.is_active, 'created_at': str(self.created_at)}


class Dataset(db.Model):
    __tablename__ = 'dataset'
    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    name = db.Column(db.String(200))
    type = db.Column(db.Enum('TRAIN', 'TEST', 'VALIDATION'), default='TRAIN')
    description = db.Column(db.Text)
    record_count = db.Column(db.Integer, default=0)
    storage_path = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {'id': self.id, 'name': self.name, 'type': self.type,
                'description': self.description, 'record_count': self.record_count,
                'created_at': str(self.created_at)}


class DatasetRecord(db.Model):
    """Record dataset (TRAIN / TEST) yang berdiri sendiri, terpisah dari tabel qc_hold.

    Setiap record menyimpan snapshot fitur + label C4.5 miliknya sendiri, sehingga:
    - Upload Excel/CSV dataset TIDAK lagi membuat baris di tabel qc_hold.
    - Perubahan / penghapusan data QC Hold operasional tidak mengubah dataset.
    - qc_hold_id hanya referensi sumber (opsional) bila record disalin dari QC Hold.
    """
    __tablename__ = 'dataset_record'
    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    dataset_id = db.Column(db.BigInteger, db.ForeignKey('dataset.id', ondelete='CASCADE'), nullable=False)
    # Referensi sumber (opsional). NULL bila record berasal dari upload file.
    qc_hold_id = db.Column(db.BigInteger, db.ForeignKey('qc_hold.id', ondelete='SET NULL'), nullable=True)
    source = db.Column(db.String(20), default='UPLOAD')  # UPLOAD | QC_HOLD | SPLIT | MERGE
    record_code = db.Column(db.String(80))
    part_no = db.Column(db.String(100))
    product_category_id = db.Column(db.Integer, db.ForeignKey('product_category.id', ondelete='SET NULL'))
    defect_category_id = db.Column(db.Integer, db.ForeignKey('defect_category.id', ondelete='SET NULL'))
    defect_severity = db.Column(db.SmallInteger)
    defect_description = db.Column(db.Text)
    decision_action_id = db.Column(db.Integer, db.ForeignKey('decision_action.id', ondelete='SET NULL'))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    dataset = db.relationship('Dataset', backref=db.backref('records', lazy='dynamic', cascade='all, delete-orphan'))
    qc_hold = db.relationship('QcHold', backref=db.backref('dataset_records', lazy='dynamic'))
    product_category = db.relationship('ProductCategory', foreign_keys=[product_category_id])
    defect_category = db.relationship('DefectCategory', foreign_keys=[defect_category_id])
    decision_action = db.relationship('DecisionAction', foreign_keys=[decision_action_id])

    __table_args__ = (db.UniqueConstraint('dataset_id', 'qc_hold_id', name='uq_dataset_qc'),)

    @property
    def sample_key(self):
        """Identitas sampel untuk deteksi overlap (data leakage) antar dataset."""
        if self.qc_hold_id:
            return f'Q{self.qc_hold_id}'
        return f'C{self.record_code}'

    @classmethod
    def from_qc_hold(cls, dataset_id, qc, source='QC_HOLD'):
        """Salin (snapshot) fitur & label dari QC Hold ke record dataset baru."""
        return cls(
            dataset_id=dataset_id,
            qc_hold_id=qc.id,
            source=source,
            record_code=qc.qc_code,
            part_no=qc.part_no,
            product_category_id=qc.product_category_id,
            defect_category_id=qc.defect_category_id,
            defect_severity=qc.defect_severity,
            defect_description=qc.defect_description,
            decision_action_id=qc.decision_action_id,
        )

    def clone_to(self, dataset_id, source=None):
        """Salin record ini ke dataset lain (dipakai untuk split / merge)."""
        return DatasetRecord(
            dataset_id=dataset_id,
            qc_hold_id=self.qc_hold_id,
            source=source or self.source,
            record_code=self.record_code,
            part_no=self.part_no,
            product_category_id=self.product_category_id,
            defect_category_id=self.defect_category_id,
            defect_severity=self.defect_severity,
            defect_description=self.defect_description,
            decision_action_id=self.decision_action_id,
        )

    def to_dict(self):
        return {
            'id': self.id,
            'dataset_record_id': self.id,
            'dataset_id': self.dataset_id,
            'qc_hold_id': self.qc_hold_id,
            'source': self.source,
            'record_code': self.record_code,
            'qc_code': self.record_code,  # kompatibilitas tampilan lama
            'part_no': self.part_no,
            'product_category_id': self.product_category_id,
            'product_category': self.product_category.name if self.product_category else None,
            'defect_category_id': self.defect_category_id,
            'defect_category': self.defect_category.name if self.defect_category else None,
            'defect_severity': self.defect_severity,
            'defect_description': self.defect_description,
            'decision_action_id': self.decision_action_id,
            'decision_action': self.decision_action.label if self.decision_action else None,
            'decision_action_code': self.decision_action.code if self.decision_action else None,
            'created_at': str(self.created_at),
        }


class DecisionRecord(db.Model):
    __tablename__ = 'c45_decision'
    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    model_id = db.Column(db.BigInteger, db.ForeignKey('models.id', ondelete='SET NULL'))
    qc_hold_id = db.Column(db.BigInteger, db.ForeignKey('qc_hold.id', ondelete='SET NULL'))
    action_id = db.Column(db.Integer, db.ForeignKey('decision_action.id', ondelete='SET NULL'))
    probability = db.Column(db.Numeric(5, 4))
    processed_by = db.Column(db.BigInteger, db.ForeignKey('users.id', ondelete='SET NULL'))
    processed_at = db.Column(db.DateTime, default=datetime.utcnow)
    details = db.Column(db.JSON)

    ml_model = db.relationship('MLModel', foreign_keys=[model_id])
    qc_hold = db.relationship('QcHold', foreign_keys=[qc_hold_id])
    action = db.relationship('DecisionAction', foreign_keys=[action_id])
    user = db.relationship('User', foreign_keys=[processed_by])

    def to_dict(self):
        return {
            'id': self.id, 'model_id': self.model_id,
            'qc_hold_id': self.qc_hold_id,
            'action': self.action.label if self.action else None,
            'action_code': self.action.code if self.action else None,
            'probability': float(self.probability) if self.probability else None,
            'processed_at': str(self.processed_at),
            'details': self.details,
        }


class DecisionRule(db.Model):
    __tablename__ = 'decision_rule'
    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    model_id = db.Column(db.BigInteger, db.ForeignKey('models.id', ondelete='CASCADE'), nullable=False)
    rule_text = db.Column(db.Text, nullable=False)
    action_id = db.Column(db.Integer, db.ForeignKey('decision_action.id', ondelete='SET NULL'))
    support = db.Column(db.Integer, default=0)
    confidence = db.Column(db.Numeric(5, 4))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    ml_model = db.relationship('MLModel', foreign_keys=[model_id])
    action = db.relationship('DecisionAction', foreign_keys=[action_id])

    def to_dict(self):
        return {
            'id': self.id, 'model_id': self.model_id,
            'rule_text': self.rule_text,
            'action': self.action.label if self.action else None,
            'support': self.support,
            'confidence': float(self.confidence) if self.confidence else None,
        }


class ModelMetrics(db.Model):
    __tablename__ = 'model_metrics'
    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    model_id = db.Column(db.BigInteger, db.ForeignKey('models.id', ondelete='CASCADE'), nullable=False)
    metric_name = db.Column(db.String(100), nullable=False)
    metric_value = db.Column(db.Numeric(10, 6))
    dataset_type = db.Column(db.String(50))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    ml_model = db.relationship('MLModel', foreign_keys=[model_id])

    def to_dict(self):
        return {
            'id': self.id, 'model_id': self.model_id,
            'metric_name': self.metric_name,
            'metric_value': float(self.metric_value) if self.metric_value else None,
            'dataset_type': self.dataset_type,
        }


class AuditLog(db.Model):
    __tablename__ = 'audit_log'
    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    user_id = db.Column(db.BigInteger, db.ForeignKey('users.id', ondelete='SET NULL'))
    action = db.Column(db.String(150))
    target_table = db.Column(db.String(150))
    target_id = db.Column(db.String(100))
    details = db.Column(db.JSON)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    user = db.relationship('User', foreign_keys=[user_id])

    def to_dict(self):
        return {
            'id': self.id, 'action': self.action, 'target_table': self.target_table,
            'target_id': self.target_id, 'details': self.details,
            'user': self.user.username if self.user else 'system',
            'created_at': str(self.created_at),
        }
