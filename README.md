# WebDAQ - LUNA Experiment Data Acquisition System
![GitHub commit activity](https://img.shields.io/github/commit-activity/m/skowrons94/WebDAQ) ![GitHub Release](https://img.shields.io/github/v/release/skowrons94/WebDAQ?include_prereleases) <img alt="Static Badge" src="https://img.shields.io/badge/Documentation-up-green?logo=Github&link=https%3A%2F%2Fskowrons94.github.io%2FWebDAQ%2Findex.html">


![Dashboard](imgs/dashboard.png)

This repository contains a server and a React Next.js frontend designed for data acquisition at the LUNA experiment. The system utilizes XDAQ libraries within Docker to efficiently handle data acquisition processes. Additionally, it manages run metadata to facilitate easy conversion to a FAIR (Findable, Accessible, Interoperable, Reusable) format.

## Features

- **Data Acquisition**: Communicates with Graphite interfaces in the laboratory to gather real-time data.
- **Tetramm Current Acquisition**: Initiates and manages tetramm current acquisition.
- **Data Visualization**: Visualizes spectra and waveforms from each channel using spy sockets of XDAQ.
- **Metadata Handling**: Efficiently processes and stores run metadata for FAIR compliance.

## Technology Stack

- **Backend**: Flask, SQLAlchemy
- **Frontend**: React, Next.js
- **Data Handling**: XDAQ Libraries
- **Containerization**: Docker

## Getting Started

### Prerequisites

- Docker
- Node.js (v14 or higher)
- Python (v3.7 or higher)
- Flask
- SQLite (or other supported database)

### Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/skowrons94/WebDAQ.git
   cd WebDAQ
   ```

2. **Set up docker**
    
    Ensure Docker is running, and pull the Docker images if needed.
    ```bash
    docker pull skowrons/xdaq:v3.0
    ```

### Example Usage

#### Server

1. **Navigate to server directory:**
    ```bash
    cd server
    ```

2. **Initialize the database:**
    ```bash
    flask db init
    flask db migrate -m "Initial migration."
    flask db upgrade
    ```

3. **Create a new user:**
    ```bash
    flask --app server create-user
    ```

4. **Start the Flask server:**
    ```bash
    flask --app server run -p 5001
    ```

#### Frontend

1. **Navigate to frontend directory:**
    ```bash
    cd frontend
    ```

2. **Install dependencies and run the development server:**
    ```bash
    npm install
    npm run dev
    ```

### Usage

Once both the server and frontend are running, you can access the application via your web browser at ```http://localhost:3000```. The server will be available at ```http://localhost:5001```.

### License

This project is licensed under the MIT License - see the LICENSE file for details.

### Contributing

Contributions are welcome! Please submit a pull request or open an issue for any enhancements or bug fixes.

### Contact

For any inquiries or support, please contact:

* jakub.skowronski@pd.infn.it
* alessandro.compagnucci@gssi.it
* gesue.riccardo@gssi.it 
