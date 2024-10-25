#!/bin/bash

APP_DIR=/data/skowrons/Codes/WebDAQ/server

CURRENT_DIR=$(pwd)

# Create config directory
if [ ! -d "${CURRENT_DIR}/conf" ]; then
    mkdir ${CURRENT_DIR}/conf
fi

# Create config directory
if [ ! -d "${CURRENT_DIR}/calib" ]; then
    mkdir ${CURRENT_DIR}/calib
fi

# Check if topology.xml exists
if [ ! -f "${CURRENT_DIR}/conf/topology.xml" ]; then
    # Copy the config file
    cp ${APP_DIR}/conf/topology.xml ${CURRENT_DIR}/conf/topology.xml
fi

# Check if calib directory exists
if [ ! -d "${CURRENT_DIR}/calib" ]; then
    # Copy the calib directory
    cp -r ${APP_DIR}/calib ${CURRENT_DIR}
fi

# Check if jupyter directory exists
if [ ! -d "${CURRENT_DIR}/jupyter" ]; then
    # Copy the jupyter directory
    cp -r ${APP_DIR}/jupyter ${CURRENT_DIR}
fi

# Check if scripts directory exists
if [ ! -d "${CURRENT_DIR}/scripts" ]; then
    # Copy the scripts directory
    cp -r ${APP_DIR}/scripts ${CURRENT_DIR}
fi

# Check if json directory exists
if [ ! -d "${CURRENT_DIR}/json" ]; then
    # Copy the json directory
    cp -r ${APP_DIR}/json ${CURRENT_DIR}
fi

# Check if .env exists
if [ ! -f "${CURRENT_DIR}/.env" ]; then
    # Copy the .env file
    rm -r ${CURRENT_DIR}/.env
fi

# Create environment variable for flask server
echo "export FLASK_APP=${APP_DIR}/server.py" > ${CURRENT_DIR}/.env

# Create environment variable for flask database
echo "export DATABASE_URL=sqlite:///${CURR_DIR}/app.db" >> ${CURRENT_DIR}/.env

source ${CURRENT_DIR}/.env

# Check if app.db exists
if [ ! -f "${CURRENT_DIR}/app.db" ]; then
    # Initialize the database
    flask db init --directory ${CURR_DIR}
    # Migrate the database
    flask db migrate - m "Initial migration."
    # Upgrade the database
    flask db upgrade
    # Create user
    flask create-user
fi

# Start server
flask run -p 5001