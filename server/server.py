# run.py
from app import create_app, db
from app.models.user import User
from app.models.run_metadata import RunMetadata


app = create_app()

@app.cli.command("create-user")
def create_user():
    """Create a new user."""
    username = input("Enter username: ")
    email = input("Enter email: ")
    password = input("Enter password: ")
    
    u = User(username=username, email=email)
    u.set_password(password)
    
    db.session.add(u)
    db.session.commit()
    
    print(f"User {username} created successfully!")

@app.shell_context_processor
def make_shell_context():
    return {'db': db, 'User': User, 'RunMetadata': RunMetadata}

if __name__ == '__main__':
    app.run(debug=True)