# app/utils/jwt_utils.py
from flask_jwt_extended import create_access_token, get_jwt_identity, jwt_required
from datetime import timedelta

def generate_token(user_id):
    return create_access_token(identity=user_id, expires_delta=timedelta(days=1))

def get_current_user():
    return get_jwt_identity()

# Decorator for protected routes
jwt_required_custom = jwt_required()