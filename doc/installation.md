# LunaDAQ Installation Guide

This page provides a detailed step-by-step guide to install and configure the LunaDAQ system for the LUNA experiment.

---

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Installation Steps](#installation-steps)  
   - [Clone Repository](#1-clone-repository)  
   - [Docker Setup](#2-docker-setup)  
   - [Conda Environment (Optional)](#3-conda-environment-optional)  
   - [Server Configuration](#4-server-configuration)  
   - [Frontend Setup](#5-frontend-setup)  
3. [Post-Installation Checks](#post-installation-checks)
4. [Troubleshooting](#troubleshooting)

---

## Prerequisites

The LunaDAQ is compatibile only with Linux systems, so ensure to use a PC with any Linux version you prefer.

Ensure the following are installed on your system:

| Component       | Version      | Verification Command      |
|-----------------|--------------|----------------------------|
| Docker          | Latest       | `docker --version`         |
| Node.js         | ≥ v14.x      | `node -v`                  |
| Python          | ≥ v3.7       | `python3 --version`        |
| Flask           | ≥ 2.0        | `flask --version`          |
| SQLite          | ≥ 3.35       | `sqlite3 --version`        |
| npm             | ≥ 7.x        | `npm -v`                   |

**Notes**:  
- For Docker, ensure the service is running (`systemctl status docker` on Linux).  
- If using Conda, install [Miniconda](https://docs.conda.io/en/latest/miniconda.html) or Anaconda.

---

## Installation Steps

### 1. Clone Repository

```bash
git clone https://github.com/skowrons94/WebDAQ.git
cd WebDAQ
```

---

### 2. Docker Setup

#### Pull the XDAQ Image
The DAQ server relies on a pre-built Docker image where all the XDAQ components are located. Run:
```bash
docker pull skowrons/xdaq:latest
```

**Troubleshooting Tips**:  
- If you encounter network errors, ensure Docker has internet access.  
- Verify the image exists: `docker images | grep skowrons/xdaq`.

---

### 3. Conda Environment (Optional)

A Conda environment simplifies dependency management. To create it:
```bash
conda env create -f environment.yml
conda activate luna
```

**Alternative (Manual Setup)**:  
Install the following packages globally:  
- Python: `flask`, `sqlalchemy`, `python-dotenv`  
- Node.js: `react`, `next`, `axios`  

---

### 4. Server Configuration

In order to start the DAQ, first the server part must be activated. This is the one that actually handles the data acquistion, stores the variables, and communicates with the other components that are being added.

#### Initialize the Database
```bash
cd server
flask db init                  # Creates migration directory
flask db migrate -m "Initial migration"  # Generates migration script
flask db upgrade               # Applies migrations to the database
```

#### Create a User
```bash
flask --app server create-user  # Follow prompts to set username/password
```

#### Start the Server

If you have all the CAEN drivers installed and a board is connected to your PC:
```bash
python3 main.py
```

Alternatively, it is possible to start the server in TEST mode that is useful when working on the interface without the need of having a physical board attached:
```bash
TEST_FLAG=True python3 main.py
```

---

### 5. Frontend Setup

This part, instead, handles the interface of the DAQ by creating a web page that can be accessed and that communicates with the server to get information about the DAQ status, the boards that are connected and the data that will be collected

#### Install Dependencies
```bash
cd frontend
npm install    # Installs Next.js and React dependencies
```

#### Build and Start
```bash
npm run build  # Compiles production-ready assets
npm run start  # Launches frontend on http://localhost:3000
```

**Configuration**:  
- If the server is hosted remotely, update `frontend/.env`:
  ```env
  NEXT_PUBLIC_API_URL=http://<SERVER_IP>:5001
  ```
  Beware: this feature permits to run the server and the web page (so the client) on two different PCs. Usually, there is no need of doing that and both can run on the same PC.

---

## Post-Installation Checks

1. **Verify Server Access**:  
   ```bash
   curl http://localhost:5001/api/status
   ```
   Expected response: `{"status": "ok"}`

2. **Access the Frontend**:  
   Open `http://localhost:3000` in a browser. Log in with the credentials created earlier.

3. **Check Docker Container**:  
   Ensure the XDAQ container is running:
   ```bash
   docker ps | grep skowrons/xdaq
   ```

---

## Troubleshooting

| Issue                          | Solution                                   |
|--------------------------------|--------------------------------------------|
| Port conflicts (5001/3000)     | Stop conflicting services or modify ports in `main.py` (server) and `frontend/.env` (frontend). |
| Database migration errors      | Delete the `migrations/` folder and re-run `flask db init`. |
| npm build failures             | Clear `node_modules/` and run `npm install --force`. |
| Missing environment variables  | Ensure `.env` files exist in both `server/` and `frontend/` directories. |

For further assistance, contact [LunaDAQ Support Team](mailto:jakub.skowronski@pd.infn.it).