# LunaDAQ Details

LunaDAQ is a data acquisition (DAQ) system designed to collect and process data from connected boards using XDAQ within a Docker container. The system is managed by a Flask-based server that controls the data flow, stores configurations, and provides a web-based interface for monitoring and interaction.

## Overview
LunaDAQ is designed to provide a scalable and flexible DAQ system capable of handling multiple hardware boards efficiently. It leverages Docker to encapsulate the complex XDAQ dependencies, ensuring portability across different Linux environments. The system is structured into several key components:
- **XDAQ in Docker** (Data acquisition and processing)
- **Flask Server** (System management and control)
- **Board Communication** (Device interfacing)
- **Data Storage and Monitoring** (Graphite and SQL database integration)
- **Web Interface** (User-friendly interaction)

## System Architecture
### XDAQ in Docker
At the heart of WebDAQ is the **XDAQ-based Docker image** [`skowrons/xdaq:latest`](https://hub.docker.com/r/skowrons/xdaq). The use of Docker ensures compatibility with any Linux-based system by packaging all necessary dependencies within a self-contained environment.

#### XDAQ Components
XDAQ comprises three core units that interact via **TCP/IP sockets**:

1. **ReadoutUnit**
   - Acquires raw data buffers directly from the connected hardware.
   - Manages data flow from multiple boards simultaneously.
   - Provides a "spy" port for parallel real-time monitoring.

2. **LocalFilter**
   - Processes the raw data to extract only relevant information.
   - Compresses and optimizes buffer sizes to enhance storage efficiency.
   - Filters noise and unwanted data for better signal clarity.

3. **BuilderUnit**
   - Analyzes and correlates data across multiple channels.
   - Identifies coincidences between data streams to enhance event detection.
   - Provides a structured and refined dataset for further analysis.

Each of these units can be configured and activated based on the **topology file** (`server/conf/topology.xml`). Currently, only the **ReadoutUnit** is enabled for simplicity.

## Flask Server
The LunaDAQ system is managed by a **Flask-based web server**, which acts as the central control unit. Flask is a lightweight Python web framework that provides an easy-to-use API for managing the DAQ system.

### Flask Responsibilities
- **Instantiates and manages the XDAQ Docker container.**
- **Controls acquisition settings** based on the topology configuration.
- **Handles system status monitoring**, including:
  - Number of connected boards
  - Current run number
  - Accumulated charge statistics
  - Acquired spectra for each DAQ channel
- **Allows dynamic reconfiguration** of DAQ settings, such as:
  - Maximum file size for data collection
  - Current run number and session tracking
  - CAEN board settings through modifying the JSON configuration file
- **Generates unit-specific configuration files**, including:
  - `RUCaen.conf` (Readout Unit settings)
  - `LocalFilter.conf` (Local Filter settings)
  - `Builder.conf` (Builder Unit settings)
  - JSON file configuration of the connected boards

### Configuration and Topology
- The **topology file** (`server/conf/topology.xml`) governs which units are activated and what ports are used. The present topology activates only the ReadoutUnit for simplicity and stability.
- Configuration files are automatically generated based on the detected boards to ensure a seamless setup process.

```{note}
For a detailed technical reference of all server classes, services, and routes, see the [Server Architecture Guide](server-architecture.md).
```

## Board Communication
LunaDAQ includes direct communication with hardware boards to ensure smooth operation.

### Initial Board Communication
- Managed by `server/app/services/dgtz.py`
- Uses the **CAENDigitizer Library** to:
  - Verify if a board is properly connected.
  - Extract and store the board's configuration as a JSON file in (`server/conf/`).

### TetrAMM Module Integration
- Managed by `server/app/services/tetramm.py`
- Acquires TetrAMM values and calculates **mean values over 0.1-second intervals**.
- Ensures real-time data streaming to Graphite for monitoring and processing.
- The module is always acquiring. In order to save the data, when the run is started, the flag to save the data is simply enabled.

## Data Storage and Monitoring
### Graphite Database Integration
- LunaDAQ interfaces with **Graphite**, a time-series database designed for storing and visualizing system metrics.
- Graphite is hosted on the `lunaserver` machine and is used to store DAQ statistics such as:
  - DAQ rates
  - Current values
  - MV accelerator values
- The server communicates with Graphite via `server/app/services/graphite.py`, retrieving system metrics for visualization.

### Spy Functionality
- Handled by `server/app/services/spy.py`
- Enables **real-time data acquisition monitoring**.
- Extracts histograms from active acquisitions for live analysis.
- Requires **LunaSpy** ([LunaSpy GitHub](https://github.com/skowrons94/LunaSpy)), which must be installed and accessible in the system path.

## API and Web Interface
### REST API
LunaDAQ exposes a **REST API** that allows external applications to interact with the system. API endpoints are defined in `server/app/routes/` and include:
- Starting and stopping acquisition runs.
- Retrieving real-time system metrics.
- Modifying DAQ configurations dynamically.

**What is an API?**
An **API (Application Programming Interface)** is a way for different software components to communicate. LunaDAQ’s API enables seamless interaction between the frontend and backend.

### SQL Database
- LunaDAQ maintains a structured SQL database to store run metadata, including:
  - Start and stop times
  - Accumulated charge per session
  - Target type and run type
  - Terminal Voltages and Probe Voltages (manually inserted for the 400kV compatibility)
  
### Web Frontend
- The **web interface** provides a **JavaScript-based** control panel for LunaDAQ.
- It uses **Node.js** for backend processing and communicates with the Flask server through API calls.
- **Frontend independence:** Unlike CoMPASS, WebDAQ’s frontend operates separately from the backend, preventing any possible crash of the DAQ.
