"""Upgrade, and if needed repair, the database at DATABASE_URL (see app/utils/db_repair.py).

Usage: python scripts/ensure_db.py <migrations dir>

Builds a bare Flask app with only the database, so checking a project's
app.db does not open the digitizers or the picoammeter as create_app() does.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask

from app import db, migrate
from app.models import run_metadata, user  # noqa: F401  (register the tables)
from app.utils.db_repair import repair_database
from config import Config

app = Flask(__name__)
app.config.from_object(Config)
db.init_app(app)
migrate.init_app(app, db)

try:
    for action in repair_database(app, sys.argv[1]):
        print(f"  ! Repaired: {action}")
except Exception as e:
    print(f"✗ Database could not be brought up to date: {e}", file=sys.stderr)
    sys.exit(1)
print(f"  ✓ Database up to date ({app.config['SQLALCHEMY_DATABASE_URI']})")
