# config.py
import os
from datetime import timedelta

class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'you-will-never-guess-this-very-long-flask-secret-key'
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URL') or \
        'sqlite:///' + os.path.join(os.path.abspath(os.path.dirname(__file__)), 'app.db')
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    JWT_SECRET_KEY = os.environ.get('JWT_SECRET_KEY') or 'jwt-secret-string-that-is-at-least-32-bytes-long'
    # Non-expiring sessions. A control-room browser is logged in once and left
    # open for the length of a campaign; an expiry mid-run logged the operator
    # out with no warning and, worse, only showed up as pages quietly going
    # stale. Sessions now end when someone logs out or the JWT secret changes.
    #
    # The trade-off is deliberate and worth stating: a token that leaks stays
    # valid until JWT_SECRET_KEY is rotated, which is the only revocation there
    # is (there is no token blocklist). Acceptable for an instrument on a
    # controlled network; set JWT_ACCESS_TOKEN_EXPIRES to a timedelta again if
    # this server is ever exposed more widely.
    JWT_ACCESS_TOKEN_EXPIRES = False
