# app/routes/auth.py
from flask import Blueprint, request, jsonify
from app import db
from app.models.user import User
from ..utils.jwt_utils import generate_token, get_current_user, jwt_required_custom

bp = Blueprint('auth', __name__)

@bp.route('/register', methods=['POST'])
def register():
    data = request.get_json()
    user = User(username=data['username'], email=data['email'])
    user.set_password(data['password'])
    db.session.add(user)
    db.session.commit()
    return jsonify({'message': 'User registered successfully'}), 201

@bp.route('/login', methods=['POST'])
def login():
    data = request.get_json()
    user = User.query.filter_by(username=data['username']).first()
    if user and user.check_password(data['password']):
        token = generate_token(user.id)
        return jsonify({'token': token}), 200
    return jsonify({'message': 'Invalid username or password'}), 401

@bp.route('/protected', methods=['GET'])
@jwt_required_custom
def protected():
    return jsonify({'message': 'This is a protected route'}), 200


@bp.route('/me', methods=['GET'])
@jwt_required_custom
def me():
    """The signed-in account's name. Shown, for example, as the placeholder of
    the quick note's "Your name": the account is often shared by the shift."""
    user = db.session.get(User, get_current_user())
    if user is None:
        return jsonify({'message': 'No such user'}), 404
    return jsonify({'username': user.username}), 200
