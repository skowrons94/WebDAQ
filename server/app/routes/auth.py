# app/routes/auth.py
from flask import Blueprint, request, jsonify
from app import db
from app.models.user import User
from app.utils.jwt_utils import generate_token, jwt_required_custom

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
    print( data )
    if user and user.check_password(data['password']):
        token = generate_token(user.id)
        return jsonify({'token': token}), 200
    return jsonify({'message': 'Invalid username or password'}), 401

@bp.route('/protected', methods=['GET'])
@jwt_required_custom
def protected():
    return jsonify({'message': 'This is a protected route'}), 200