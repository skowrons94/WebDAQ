# app/__init__.py
import gzip

from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_jwt_extended import JWTManager
from flask_cors import CORS
from config import Config

db = SQLAlchemy()
migrate = Migrate()
jwt = JWTManager()

# Histograms dominate the traffic: one energy spectrum is 32768 bins of JSON
# (~100 kB) and a PSD map is the same again, fetched every couple of seconds for
# every channel on display. The payload is mostly zeros and short repeated
# numbers, so it compresses 30–130x — worth doing on any link, and the
# difference between usable and not over the VPN.
_COMPRESS_MIN_BYTES = 4096
_COMPRESSIBLE = ('application/json', 'text/')


def _compress_response(response):
    """gzip large JSON/text responses when the client accepts it."""
    from flask import request

    if 'gzip' not in (request.headers.get('Accept-Encoding') or '').lower():
        return response
    if response.direct_passthrough or response.status_code >= 300:
        return response
    if 'Content-Encoding' in response.headers:
        return response

    content_type = (response.content_type or '')
    if not any(content_type.startswith(kind) for kind in _COMPRESSIBLE):
        return response
    if response.content_length is not None and response.content_length < _COMPRESS_MIN_BYTES:
        return response

    data = response.get_data()
    if len(data) < _COMPRESS_MIN_BYTES:
        return response

    # Level 5: the remaining levels buy a few percent for noticeably more CPU,
    # and this runs on the machine that is also taking the data.
    response.set_data(gzip.compress(data, 5))
    response.headers['Content-Encoding'] = 'gzip'
    response.headers['Content-Length'] = response.content_length
    response.headers.add('Vary', 'Accept-Encoding')
    return response

def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    db.init_app(app)
    migrate.init_app(app, db)
    jwt.init_app(app)
    CORS(app)

    from app.routes import auth, experiment, stats, calib, current, digitizer, histograms, data, elog
    app.register_blueprint(auth.bp)
    app.register_blueprint(experiment.bp)
    app.register_blueprint(stats.bp)
    app.register_blueprint(calib.bp)
    app.register_blueprint(current.bp)
    app.register_blueprint(digitizer.bp)
    app.register_blueprint(histograms.bp)
    # Read-side access to completed runs (the Data dashboard).
    app.register_blueprint(data.bp)
    # PSI ELOG logbook (reading and posting entries).
    app.register_blueprint(elog.bp)

    app.after_request(_compress_response)

    # Pass Flask app reference to experiment module for background threads (auto-restart)
    experiment.set_flask_app(app)

    return app