"""Entry point — jalankan: python main.py"""
from app.app import create_app
from app.models import db, User, Role

app = create_app()


def seed_admin():
    """Buat roles dan user admin default jika belum ada."""
    with app.app_context():
        db.create_all()

        # Seed roles
        default_roles = [
            ('admin', 'Administrator penuh'),
            ('kepala_qc', 'Kepala Quality Control'),
            ('qc_line', 'Operator QC Line'),
        ]
        for name, desc in default_roles:
            if not Role.query.filter_by(name=name).first():
                db.session.add(Role(name=name, description=desc))
        db.session.commit()

        # Seed admin user
        if not User.query.filter_by(username='admin').first():
            admin_role = Role.query.filter_by(name='admin').first()
            u = User(username='admin', email='admin@qcsystem.local',
                     full_name='System Administrator', role_id=admin_role.id)
            u.set_password('admin123')
            db.session.add(u)
            db.session.commit()
            print('[seed] Admin user created — username: admin, password: admin123')


if __name__ == '__main__':
    seed_admin()
    app.run(debug=True, port=5000)
