# app/utils/jwt_utils.py
from flask_jwt_extended import create_access_token, get_jwt_identity, jwt_required
from datetime import timedelta

def generate_token(user_id):
    # PyJWT >= 2.10 requires the "sub" claim to be a string, so cast the id.
    return create_access_token(identity=str(user_id), expires_delta=timedelta(days=1))

def get_current_user():
    # Identity is stored as a string in the token; cast back to int for callers.
    identity = get_jwt_identity()
    return int(identity) if identity is not None else None

# Decorator for protected routes
jwt_required_custom = jwt_required()