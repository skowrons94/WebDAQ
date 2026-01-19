# app/__init__.py
from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_jwt_extended import JWTManager
from flask_cors import CORS
from config import Config

db = SQLAlchemy()
migrate = Migrate()
jwt = JWTManager()

def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    db.init_app(app)
    migrate.init_app(app, db)
    jwt.init_app(app)
    CORS(app)

    from app.routes import auth, experiment, stats, calib, current, digitizer, histograms, tuning
    app.register_blueprint(auth.bp)
    app.register_blueprint(experiment.bp)
    app.register_blueprint(stats.bp)
    app.register_blueprint(calib.bp)
    app.register_blueprint(current.bp)
    app.register_blueprint(digitizer.bp)
    app.register_blueprint(histograms.bp)
    app.register_blueprint(tuning.bp)

    return app