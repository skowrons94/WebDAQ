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

The LunaDAQ is compatibile only with Linux systems, so ensure to use a PC with any Linux version you prefer. MacOS works as well, but the CAEN drivers are not available on it so the DAQ can be run only in test mode, i.e. without connecting to any board. Apart from the OS, the following packages are required:

| Component       | Version      | Verification Command      |
|-----------------|--------------|----------------------------|
| Docker          | Latest       | `docker --version`         |
| Node.js         | ≥ v14.x      | `node -v`                  |
| Python          | ≥ v3.7       | `python3 --version`        |
| Flask           | ≥ 2.0        | `flask --version`          |
| SQLite          | ≥ 3.35       | `sqlite3 --version`        |
| npm             | ≥ 7.x        | `npm -v`                   |

For an easy installation of all the requirements, an `environment.yml` file is provided to create the `luna` conda environment which will install all the requirements, apart from Docker.

For the Docker installation, please follow the official [Docker guide](https://docs.docker.com/engine/install/) and complete the post installation steps as well. Once completed, the docker status can be checked through `sudo systemctl status docker` command.

In order to communicate succesfully with the CAEN boards, the [CAENVME Library](https://www.caen.it/products/caenvmelib-library/), the [CAENComm Library](https://www.caen.it/products/caencomm-library/) and [CAENDigitizer Library](https://www.caen.it/products/caendigitizer-library/) must be installed in the operating system. Additionally, if the USB communication is used, remember to install the drivers for the CAEN board that is being used.

Finally, to have the support for the online data visualization (so in order to spy on the data acquisition), the [LunaSpy](https://github.com/skowrons94/LunaSpy) software must be installed:

```bash
git clone https://github.com/skowrons94/LunaSpy.git
cd LunaSpy && mkdir build && cd build && cmake .. # Prepare the CMake build
make # Build the software
sudo ln -s LunaSpy /usr/local/bin/LunaSpy # Create a symbolic link
```

## Common Issues

In case you own an already installed ROOT version (outside of ```conda```), some issue might arise. The best solutions seems to be the following:

### 1. Activate the `luna` Environment  
Activate the Conda environment:  

```bash
conda activate luna
```

### 2. Create the Activation Script  
Create the activation file:  

```bash
mkdir -p ~/miniconda3/envs/luna/etc/conda/activate.d
nano ~/miniconda3/envs/luna/etc/conda/activate.d/env_vars.sh
```

### 3. Add to `env_vars.sh`  
Edit the file and add the following lines:  

```bash
#!/bin/bash
# Source a different bashrc or other setup file when 'luna' environment is activated
source ~/miniconda3/envs/luna/.bashrc_luna
```

### 4. Create a Custom `.bashrc_luna`  
Create the custom `.bashrc_luna` file:  

```bash
nano ~/miniconda3/envs/luna/.bashrc_luna
```

### 5. Add to `.bashrc_luna`  
Add the following lines:  

```bash
# Remove all current ROOT paths from LD_LIBRARY_PATH and PYTHONPATH
export LD_LIBRARY_PATH=$(echo $LD_LIBRARY_PATH | sed -e 's|[^:]*ROOT[^:]*:||g')
unset PYTHONPATH

# Point ROOTSYS to the conda environment's root directory
export ROOTSYS=$CONDA_PREFIX

# Add ROOT binary directory to the PATH
export PATH=$ROOTSYS/bin:$PATH

# Add ROOT library directory to LD_LIBRARY_PATH
export LD_LIBRARY_PATH=$ROOTSYS/lib:$LD_LIBRARY_PATH

# Add ROOT path to python path
export PYTHONPATH=$ROOTSYS/lib:$PYTHONPATH
```

Save and exit.

Now, whenever you activate the `luna` environment, it will automatically use the Conda-installed ROOT version without conflicts.

---

## Installation Steps

In the following all the steps for a fresh installation of LunaDAQ will be reported.

### 1. Clone Repository

First, the repository must be cloned:

```bash
git clone https://github.com/skowrons94/WebDAQ.git
cd WebDAQ
```

---

### 2. Docker Setup (Optional)

The DAQ server relies on a pre-built Docker image where all the XDAQ components are located. Run:
```bash
docker pull skowrons/xdaq:latest
```
in order to download the latest XDAQ image. This part is skippaple since when the XDAQ is being launched, Docker will automatically download the image by itself. However, it can take several minutes, so it is advisable to do beforehand.

---

### 3. Conda Environment (Optional)

A Conda environment simplifies dependency management. To create it:
```bash
conda env create -f environment.yml
```

Once created, the environment can be activated:
```bash
conda activate luna
```
Now all the dependencies (apart from the CAEN ones) should be succesfully installed.

---

### 4. Server Configuration

In order to start the DAQ, first the server part must be activated. This is the one that actually handles the data acquistion, stores the variables, and communicates with the other components that are being added.

#### Initialize the Database
LunaDAQ provides a SQL database where all the run information will be stored. In order to create a database we must:
```bash
cd server
flask db init # Creates migration directory
flask db migrate -m "Initial migration" # Generates migration script
flask db upgrade # Applies migrations to the database
```
After these, the SQL should be ready for usage.

#### Create a User
In order to access the DAQ, the username and password are necessary. Due to security reason, these can only be created from command line as:
```bash
flask --app server create-user  # Follow prompts to set username/password
```

#### Start the Server

If you have all the CAEN drivers installed and a board is connected to your PC:
```bash
python3 main.py
```

Alternatively, it is possible to start the server in test mode that is useful when working on the interface without the need of having a physical board attached:
```bash
TEST_FLAG=True python3 main.py
```
In the test mode, LunaDAQ will not check for any board communication and will use dummy board instead. It will be still possible to start and stop the runs, and the information in the SQL database will still be populated. 

Note that the server will be run on a specific IP address and a dedicated port. In order to change the values of the port, open the `server/main.py` file and change the values in the last line. 

---

### 5. Frontend Setup

Now, instead, it is necessary to handle the interface of the DAQ by creating a web page that communicates with the server to get information about the DAQ status, the boards that are connected and the data that will be collected.

#### Install Packages
First we install the packages that are needed for the web page:
```bash
cd frontend
npm install    # Installs Next.js and React dependencies
```

#### Build and Start
Then we can build the web page and start it:
```bash
npm run build  # Compiles production-ready assets
npm run start  # Launches frontend on http://localhost:3000
```

The web page will be looking for the server at the IP and port reported in `frontend/.env` files, thus ensure that matches the values with which the server was run. Beware that every time the values in `frontend/.env` are changed, the build must be redone before starting the new web page. Note that this permits to run the server and the web page on two completely different PCs, if needed.

---

## Post-Installation Checks

1. **Verify Server Access**:  
   ```bash
   curl http://localhost:5001/experiment/get_run_number
   ```
   Expected response: `{"status": "ok"}`

2. **Access the Frontend**:  
   Open `http://localhost:3000` in a browser. Log in with the credentials created earlier.

---

## Troubleshooting

| Issue                          | Solution                                   |
|--------------------------------|--------------------------------------------|
| Port conflicts (5001/3000)     | Stop conflicting services or modify ports in `main.py` (server) and `frontend/.env` (frontend). |
| Database migration errors      | Delete the `migrations/` folder and re-run `flask db init`. |
| npm build failures             | Clear `node_modules/` and run `npm install --force`. |
| Missing environment variables  | Ensure `.env` files exist in both `server/` and `frontend/` directories. |
| CAEN library errors            | Verify CAENVMElib, CAENComm, and CAENDigitizer are properly installed. |
| Docker permission denied       | Add your user to the docker group: `sudo usermod -a -G docker $USER` |
| ROOT conflicts                 | Follow the Common Issues section above to configure Conda environment. |

For more detailed troubleshooting, see the [Troubleshooting Guide](troubleshooting.md).

For further assistance, contact [LunaDAQ Support Team](mailto:jakub.skowronski@pd.infn.it).