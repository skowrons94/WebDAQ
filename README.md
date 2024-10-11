## To inizialize and run the example
### Server

### Server
- go to server dir
`cd server`
- Initialize database
`flask db init`
`flask db migrate -m "Initial migration."`
`flask db upgrade`
- Create new user
`flask --app server create-user`
- Start flask server
`flask --app server run -p 5001`

### Frontend Next.js

`cd frontend`
`npm run dev`