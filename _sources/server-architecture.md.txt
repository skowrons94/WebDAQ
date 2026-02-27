# Server Architecture Reference

This document provides a comprehensive technical reference for the LunaDAQ server codebase. It is intended for developers who want to understand the internal workings, extend functionality, or troubleshoot issues.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Entry Points](#entry-points)
3. [Database Models](#database-models)
4. [Service Layer](#service-layer)
5. [Route Handlers](#route-handlers)
6. [Utility Modules](#utility-modules)
7. [Configuration Files](#configuration-files)
8. [Data Flow](#data-flow)
9. [Adding New Features](#adding-new-features)

---

## Architecture Overview

The LunaDAQ server follows a layered architecture pattern:

```
┌─────────────────────────────────────────────────────────────┐
│                    Flask REST API Layer                      │
│   (Routes: auth, experiment, digitizer, histograms, etc.)   │
├─────────────────────────────────────────────────────────────┤
│                      Service Layer                           │
│   (DAQManager, SpyManager, StatsManager, ResolutionTuner)   │
├─────────────────────────────────────────────────────────────┤
│                      Utility Layer                           │
│   (Digitizer, XDAQ, Graphite, TetrAMM, RBD9103)            │
├─────────────────────────────────────────────────────────────┤
│                    Hardware / External                       │
│   (CAEN Boards, Docker/XDAQ, Graphite DB, Current Meters)   │
└─────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
server/
├── main.py                 # Application entry point
├── config.py               # Configuration settings
├── app/
│   ├── __init__.py         # Flask app factory
│   ├── models/             # SQLAlchemy database models
│   │   ├── user.py         # User authentication model
│   │   └── run_metadata.py # Run metadata model
│   ├── routes/             # API endpoint handlers
│   │   ├── auth.py         # Authentication endpoints
│   │   ├── experiment.py   # Run control endpoints
│   │   ├── digitizer.py    # Board configuration endpoints
│   │   ├── histograms.py   # Histogram/waveform endpoints
│   │   ├── current.py      # Current monitoring endpoints
│   │   ├── stats.py        # Graphite metrics endpoints
│   │   ├── calib.py        # Calibration endpoints
│   │   ├── faraday.py      # Faraday cup control
│   │   └── tuning.py       # Resolution tuner endpoints
│   ├── services/           # Business logic managers
│   │   ├── daq_manager.py  # Centralized DAQ state
│   │   ├── spy_manager.py  # Histogram spy server
│   │   ├── stats_manager.py # Graphite data collection
│   │   └── resolution_tuner.py # Parameter optimization
│   └── utils/              # Hardware interfaces
│       ├── dgtz.py         # CAEN digitizer wrapper
│       ├── spy.py          # ReadoutUnit spy client
│       ├── xdaq.py         # XDAQ/Docker management
│       ├── graphite.py     # Graphite HTTP client
│       ├── tetramm.py      # TetrAMM controller
│       ├── rbd9103.py      # RBD 9103 controller
│       └── jwt_utils.py    # JWT authentication
├── conf/                   # Configuration files
├── calib/                  # Calibration files
└── migrations/             # Database migrations
```

---

## Entry Points

### main.py

The application entry point that:
1. Creates the Flask application using the factory pattern
2. Registers signal handlers for graceful shutdown
3. Starts the Waitress WSGI server

**Key Components:**

```python
# Application creation
app = create_app()

# Server startup (10 worker threads, all interfaces)
serve(app, host='0.0.0.0', port=5001, threads=10)
```

**Shutdown Handler:**

The `cleanup_on_shutdown` function handles graceful termination:
- Stops DAQ acquisition if running
- Stops board monitoring thread
- Stops Docker container
- Closes all digitizer connections
- Stops current monitoring devices

**CLI Commands:**

```bash
flask --app server create-user  # Create user account
```

### config.py

Application configuration with environment variable overrides:

| Setting | Default | Environment Variable |
|---------|---------|---------------------|
| `SECRET_KEY` | `'you-will-never-guess'` | `$SECRET_KEY` |
| `SQLALCHEMY_DATABASE_URI` | `'sqlite:///app.db'` | `$DATABASE_URL` |
| `JWT_SECRET_KEY` | `'jwt-secret-string'` | `$JWT_SECRET_KEY` |
| `JWT_ACCESS_TOKEN_EXPIRES` | `timedelta(days=1)` | - |

### app/__init__.py

Flask application factory that:
1. Creates Flask app instance
2. Loads configuration
3. Initializes extensions (SQLAlchemy, Migrate, JWT)
4. Enables CORS for cross-origin requests
5. Registers all blueprint routes

**Global Objects:**
- `db` - SQLAlchemy database instance
- `migrate` - Flask-Migrate for schema versioning
- `jwt` - Flask-JWT-Extended manager

---

## Database Models

### User Model

**Location:** `server/app/models/user.py`

Stores user authentication credentials.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | Integer | Primary Key | Unique identifier |
| `username` | String(64) | Unique, Indexed | Login username |
| `email` | String(120) | Unique, Indexed | User email |
| `password_hash` | String(128) | - | Hashed password |

**Methods:**

| Method | Description |
|--------|-------------|
| `set_password(password)` | Hash password using werkzeug security |
| `check_password(password)` | Verify password against stored hash |

**Relationships:**
- One-to-Many with `RunMetadata` (backref: `runs`)

### RunMetadata Model

**Location:** `server/app/models/run_metadata.py`

Stores metadata for each acquisition run (FAIR-compliant).

| Column | Type | Description |
|--------|------|-------------|
| `id` | Integer | Primary key |
| `run_number` | Integer | Unique run identifier (indexed) |
| `start_time` | DateTime | Run start timestamp |
| `end_time` | DateTime | Run end timestamp |
| `notes` | Text | User notes for the run |
| `accumulated_charge` | Float | Total charge during run |
| `target_name` | String(64) | Target sample name |
| `terminal_voltage` | Float | Accelerator terminal voltage |
| `probe_voltage` | Float | Probe voltage setting |
| `run_type` | String(64) | Run type (physics, calibration, etc.) |
| `flag` | String(32) | Quality flag (good/unknown/bad) |
| `user_id` | Integer | Foreign key to User |

---

## Service Layer

Services are singleton managers that encapsulate business logic and maintain state.

### DAQManager

**Location:** `server/app/services/daq_manager.py`

Central manager for all DAQ operations including board connections, run control, and state management.

**Accessing the Instance:**
```python
from app.services.daq_manager import get_daq_manager
daq_manager = get_daq_manager(test_flag=False)
```

#### State Attributes

The `daq_state` dictionary contains:

| Key | Type | Description |
|-----|------|-------------|
| `running` | bool | DAQ acquisition status |
| `start_time` | str | Run start timestamp |
| `run` | int | Current run number |
| `save` | bool | Data saving enabled |
| `limit_size` | bool | File size limiting enabled |
| `file_size_limit` | int | Maximum file size (bytes) |
| `boards` | List[Dict] | Configured board list |

#### DigitizerContainer (Inner Class)

Manages persistent connections to CAEN boards to avoid frequent reconnections.

**Key Methods:**

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `add_board` | `board_config` | `bool` | Create persistent connection (3 retries) |
| `remove_board` | `board_id` | - | Close and remove connection |
| `get_digitizer` | `board_id` | `Digitizer` | Get digitizer instance |
| `is_connected` | `board_id` | `bool` | Check connection status |
| `read_register` | `board_id, address` | `int` | Thread-safe register read |
| `refresh_board_connection` | `board_id, config` | - | Reconnect board |
| `cleanup` | - | - | Close all connections |

**Thread Safety:** Each board has an associated `threading.Lock` for safe concurrent access.

#### DAQManager Methods

**State Management:**

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `get_state` | - | `dict` | Copy of current DAQ state |
| `is_running` | - | `bool` | Acquisition running status |
| `get_run_number` | - | `int` | Current run number |
| `set_run_number` | `num` | - | Set run number |
| `get_save_data` | - | `bool` | Data saving status |
| `set_save_data` | `save` | - | Enable/disable saving |
| `get_limit_data_size` | - | `bool` | Size limiting status |
| `set_limit_data_size` | `limit` | - | Enable/disable limiting |
| `get_data_size_limit` | - | `int` | File size limit |
| `set_data_size_limit` | `limit` | - | Set size limit |
| `get_start_time` | - | `str` | Run start timestamp |

**Board Management:**

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `get_boards` | - | `List[Dict]` | List of configured boards |
| `add_board` | `board_config` | `dict` | Add board, create connection |
| `remove_board` | `board_id` | - | Remove board and cleanup |
| `get_board_info` | `board_id` | `dict` | Board model/channels/DPP type |
| `check_board_connectivity` | - | `dict` | Verify all connections |
| `refresh_board_connection` | `board_id` | - | Reconnect a board |
| `get_board_status` | - | `dict` | Failure tracking info |

**Run Control:**

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `prepare_run_start` | - | - | Create directories, copy configs |
| `configure_xdaq_for_run` | - | - | Configure XDAQ topology |
| `start_xdaq` | - | - | Start XDAQ acquisition |
| `stop_xdaq` | - | - | Stop XDAQ acquisition |
| `reset_xdaq` | - | - | Reset XDAQ system |
| `start_board_monitoring` | - | - | Start health monitoring thread |
| `stop_board_monitoring` | - | - | Stop monitoring thread |
| `increment_run_number` | - | `int` | Increment and persist run number |

**Add Board Flow:**
1. Create persistent digitizer connection (3 retry attempts)
2. Query board info (model, channels, serial number)
3. Read DPP configuration (PHA or PSD registers)
4. Save configuration to `conf/BoardName_ID.json`
5. Create calibration file `calib/BoardName_ID.cal`
6. Insert board in sorted order by ID
7. Update `conf/settings.json`

---

### SpyManager

**Location:** `server/app/services/spy_manager.py`

Manages the ReadoutUnit spy server for real-time histogram monitoring.

**Accessing the Instance:**
```python
from app.services.spy_manager import get_spy_manager
spy_manager = get_spy_manager(test_flag=False)
```

#### Key Methods

**Spy Server Control:**

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `start_spy` | `daq_state` | - | Initialize spy server |
| `stop_spy` | - | - | Shutdown spy server |
| `get_spy_status` | - | `dict` | Server state info |

**Histogram Access:**

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `get_histogram` | `board_id, channel, boards, histogram_type, rebin` | `TH1F` | Get ROOT histogram |
| `get_histogram_index` | `board_id, channel, boards` | `int` | Calculate spy buffer index |
| `get_roi_histogram` | `board_id, channel, boards, roi_min, roi_max, rebin` | `TH1F` | Histogram with ROI styling |
| `get_roi_integral` | `board_id, channel, boards, roi_min, roi_max, rebin` | `float` | Calculate ROI sum |

**Waveform Access:**

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `get_waveform` | `board_id, channel, boards, waveform_type` | `dict` | Get waveform data |
| `activate_waveforms` | `boards` | - | Enable bit 16 in register 0x8000 |
| `deactivate_waveforms` | `boards` | - | Disable waveform recording |
| `get_waveform_status` | `boards` | `bool` | Check if waveforms enabled |

**Histogram Types:**
- `energy` - Energy spectrum (DPP-PHA boards, default)
- `qlong` - Long gate charge integral (DPP-PSD boards)
- `qshort` - Short gate charge integral (DPP-PSD boards)
- `psd` - Pulse Shape Discrimination 2D histogram
- `wave1`, `wave2` - Waveform data

---

### StatsManager

**Location:** `server/app/services/stats_manager.py`

Manages Graphite time-series data collection and metric path configuration.

**Accessing the Instance:**
```python
from app.services.stats_manager import get_stats_manager
stats_manager = get_stats_manager()
```

#### Key Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `get_paths` | - | `List[Dict]` | Configured metric paths |
| `add_path` | `path, alias` | - | Add new metric path |
| `remove_path` | `path` | - | Remove metric path |
| `update_path` | `path, alias, enabled` | - | Modify path configuration |
| `start_run` | `run_number` | - | Begin collection thread |
| `stop_run` | - | - | Stop collection thread |
| `get_config_info` | - | `dict` | Graphite address and status |
| `get_last_value` | `metric, from_time` | `float` | Most recent non-null value |

---

### ResolutionTuner

**Location:** `server/app/services/resolution_tuner.py`

Automates parameter optimization for DPP-PHA boards by varying register values and measuring energy resolution.

**Accessing the Instance:**
```python
from app.services.resolution_tuner import get_resolution_tuner
tuner = get_resolution_tuner(daq_manager, spy_manager)
```

#### TuningSession Class

Represents one tuning session (parameter sweep).

| Attribute | Type | Description |
|-----------|------|-------------|
| `session_id` | str | Unique session identifier |
| `board_id` | str | Target board |
| `channel` | int | Target channel |
| `parameter_name` | str | Parameter being tuned |
| `param_min`, `param_max` | int | Search range |
| `num_steps` | int | Number of steps |
| `run_duration` | int | Seconds per step |
| `fit_range_min`, `fit_range_max` | int | Gaussian fitting window |
| `points` | List[Dict] | Data points from each step |
| `best_point` | Dict | Optimal parameter value |
| `status` | str | running/completed/stopped/error |

#### Tunable Parameters

| Parameter Name | Register Address | Description |
|----------------|------------------|-------------|
| Trapezoid Rise Time | 0x105C | Rising edge time |
| Trapezoid Flat Top | 0x1060 | Flat top duration |
| Peaking Time | 0x1064 | Peak detection time |
| Decay Time | 0x1068 | Decay constant |
| Input Rise Time | 0x1058 | Input signal rise time |
| Trigger Hold-Off | 0x1074 | Trigger holdoff period |
| Peak Hold-Off | 0x1078 | Peak holdoff period |

#### Key Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `start_tuning` | `config` | - | Initiate new session |
| `stop_tuning` | - | - | Halt current session |
| `get_status` | - | `dict` | Current session status |
| `get_current_data` | - | `dict` | Points and best result |
| `get_history` | `board_id, limit` | `List` | Past sessions |
| `reset_history` | - | - | Clear history file |
| `get_tunable_parameters` | - | `List[str]` | Parameter options |
| `get_parameter_value` | `board_id, param_name, channel` | `int` | Read from config |
| `set_parameter_value` | `board_id, param_name, channel, value` | - | Write to config |
| `get_histogram_with_fit` | `board_id, channel, fit_params` | `dict` | Histogram with Gaussian overlay |

**Algorithm:**
1. Run short DAQ cycles (no file save)
2. Vary one parameter systematically across range
3. Fit histogram peaks with Gaussian: `y = A * exp(-(x-μ)²/(2σ²)) + B`
4. Record sigma (resolution) vs parameter value
5. Find optimal value with minimum sigma

---

## Route Handlers

Routes are organized by functionality using Flask Blueprints.

### Authentication Routes

**Location:** `server/app/routes/auth.py`
**Blueprint:** `auth`

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/register` | POST | No | Create user account |
| `/login` | POST | No | Authenticate, receive JWT |
| `/protected` | GET | Yes | Test protected route |

**Login Response:**
```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLC..."
}
```

---

### Experiment Control Routes

**Location:** `server/app/routes/experiment.py`
**Blueprint:** `experiment`

#### Run Control

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/experiment/start_run` | POST | Start DAQ acquisition |
| `/experiment/stop_run` | POST | Stop acquisition, save metadata |
| `/experiment/get_run_status` | GET | Check if DAQ running |

#### Run Metadata

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/experiment/get_run_metadata` | GET | All runs (sorted by number) |
| `/experiment/get_run_metadata/<run_number>` | GET | Specific run details |
| `/experiment/add_note` | POST | Add notes to run |
| `/experiment/add_run_metadata` | POST | Set voltages, target, type |
| `/experiment/update_run_flag` | POST | Mark as good/bad/unknown |
| `/experiment/update_run_notes` | POST | Update run notes |

#### Board Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/experiment/add_board` | POST | Connect and add board |
| `/experiment/remove_board` | POST | Remove board |
| `/experiment/get_board_configuration` | GET | List all boards |
| `/experiment/get_board_status` | GET | Connection status |
| `/experiment/refresh_board_connections` | POST | Reconnect all boards |

#### Data Settings

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/experiment/set_save_data` | POST | Enable/disable saving |
| `/experiment/get_save_data` | GET | Get save status |
| `/experiment/set_limit_data_size` | POST | Enable size limiting |
| `/experiment/get_limit_data_size` | GET | Get limit status |
| `/experiment/set_data_size_limit` | POST | Set max file size |
| `/experiment/get_data_size_limit` | GET | Get size limit |

#### XDAQ Status

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/experiment/xdaq/file_bandwidth` | GET | File writing speed |
| `/experiment/xdaq/output_bandwidth` | GET | Network output speed |
| `/experiment/xdaq/reset` | POST | Reset XDAQ system |

---

### Digitizer Configuration Routes

**Location:** `server/app/routes/digitizer.py`
**Blueprint:** `digitizer`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/digitizer/boards` | GET | List all boards |
| `/digitizer/connectivity` | GET | Connection status |
| `/digitizer/<id>/info` | GET | Board model/channels/serial |
| `/digitizer/<id>/config` | GET | Complete board config |
| `/digitizer/<id>/config` | POST | Set board config |
| `/digitizer/<id>/registers` | GET | All registers (hex/dec) |
| `/digitizer/<id>/<setting>` | GET | Get register value |
| `/digitizer/<id>/<setting>/<value>` | GET | Set register value |
| `/digitizer/polarity/<id>/<channel>` | GET | Get input polarity |
| `/digitizer/polarity/<id>/<channel>/<value>` | GET | Set input polarity |
| `/digitizer/channel/<id>/<channel>` | GET | Get channel enable |
| `/digitizer/channel/<id>/<channel>/<value>` | GET | Set channel enable |

**Register Map (partial):**

| Setting Name | Address | Description |
|--------------|---------|-------------|
| Invert Input | 0x1080 | Input polarity |
| Pre Trigger | 0x1038 | Pre-trigger samples |
| Trigger Threshold | 0x106C | Trigger level |
| DC Offset | 0x1098 | DC offset |
| Record Length | 0x1020 | Samples per event |

---

### Histogram Routes

**Location:** `server/app/routes/histograms.py`
**Blueprint:** `histograms`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/histograms/<board_id>/<channel>` | GET | Energy histogram |
| `/histograms/<board_id>/<channel>/<type>` | GET | Specific histogram type |
| `/histograms/<board_id>/<channel>/rebin/<factor>` | GET | Rebinned histogram |
| `/histograms/<board_id>/<channel>/<roi_min>/<roi_max>` | GET | Histogram with ROI |
| `/psd/<board_id>/<channel>` | GET | PSD histogram |
| `/roi/<board_id>/<channel>/<roi_min>/<roi_max>` | GET | ROI integral |
| `/waveforms/1/<board_id>/<channel>` | GET | Wave1 data |
| `/waveforms/2/<board_id>/<channel>` | GET | Wave2 data |
| `/waveforms/activate` | POST | Enable waveforms |
| `/waveforms/deactivate` | POST | Disable waveforms |
| `/waveforms/status` | GET | Waveform status |
| `/spy/status` | GET | Spy server status |

---

### Current Monitoring Routes

**Location:** `server/app/routes/current.py`
**Blueprint:** `current`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/current/module_type` | GET/POST | Get/set active module |
| `/current/connect` | GET | Initialize connection |
| `/current/is_connected` | GET | Connection status |
| `/current/data` | GET | Current measurement |
| `/current/data_array` | GET | 100-sample array |
| `/current/accumulated` | GET | Run accumulated charge |
| `/current/total_accumulated` | GET | Total accumulated |
| `/current/reset_total_accumulated` | POST | Reset total |
| `/current/start/<run_number>` | GET | Begin acquisition |
| `/current/stop` | POST | Stop acquisition |
| `/current/collimator/1` | GET | Collimator 1 current |
| `/current/collimator/2` | GET | Collimator 2 current |

**Supported Modules:**
- `tetramm` - TetrAMM multi-channel picoammeter
- `rbd9103` - RBD 9103 serial current meter

---

### Statistics Routes

**Location:** `server/app/routes/stats.py`
**Blueprint:** `stats`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/stats/graphite_config` | GET/POST | Graphite server config |
| `/stats/paths` | GET/POST | Metric paths |
| `/stats/paths/<path>` | DELETE/PUT | Manage single path |
| `/stats/run/<run_number>/start` | POST | Start collection |
| `/stats/run/stop` | POST | Stop collection |
| `/stats/metric/<metric>` | GET | Get metric data |
| `/stats/metric/<metric>/last` | GET | Last non-null value |

**Legacy Endpoints (no JWT):**
- `/stats/terminal_voltage` - Accelerator terminal voltage
- `/stats/board_rates` - Board event rates
- `/stats/board_rates_dt` - Dead time percentage

---

### Calibration Routes

**Location:** `server/app/routes/calib.py`
**Blueprint:** `calib`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/calib/get/<board>/<id>/<channel>` | GET | Get calibration (a, b) |
| `/calib/set/<board>/<id>/<channel>` | POST | Set calibration |

**Calibration Format:**
```
E = a * bin + b
```
Stored in `calib/BoardName_ID.cal` (one line per channel: `a b`)

---

### Resolution Tuning Routes

**Location:** `server/app/routes/tuning.py`
**Blueprint:** `tuning`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/tuning/start` | POST | Begin tuning session |
| `/tuning/stop` | POST | Stop tuning |
| `/tuning/status` | GET | Session status |
| `/tuning/data` | GET | Current data and best |
| `/tuning/history` | GET | Past sessions |
| `/tuning/boards` | GET | DPP-PHA boards only |
| `/tuning/parameters` | GET | Tunable parameters |
| `/tuning/parameter_value/<board>/<channel>/<param>` | GET | Current value |
| `/tuning/parameter_value` | POST | Set value |

---

## Utility Modules

### Digitizer Interface

**Location:** `server/app/utils/dgtz.py`

Python wrapper for the CAEN Digitizer C library.

**Class: Digitizer**

| Method | Description |
|--------|-------------|
| `open()` | Establish board connection |
| `close()` | Terminate connection |
| `get_connected()` | Check connection status |
| `get_info()` | Return BoardInfo structure |
| `read_pha(filename)` | Query DPP-PHA config, save to JSON |
| `read_psd(filename)` | Query DPP-PSD config, save to JSON |
| `write_register(addr, value)` | Write register to board |
| `read_register(addr)` | Read register from board |

**Link Types:**
- 0: USB direct connection
- 1: Optical link (CONET)
- 5: A4818 VME bridge

---

### XDAQ Interface

**Location:** `server/app/utils/xdaq.py`

Manages XDAQ Docker container and SOAP messaging.

**Class: xdaq_messenger**

Sends SOAP messages to XDAQ applications.

| Method | Description |
|--------|-------------|
| `create_action_message(action)` | Build SOAP action request |
| `create_parameter_message(name, type, value)` | Build parameter set message |
| `send_message(message)` | Execute HTTP request |

**Class: topology**

Manages XDAQ topology configuration.

| Method | Description |
|--------|-------------|
| `load_topology()` | Parse `topology.xml` |
| `configure_pt()` | Configure Persistent Topology |
| `enable_pt()` | Start PT background threads |
| `write_ruconf(daq_state)` | Update RU configuration |
| `get_daq_status()` | Query DAQ state |

**Class: container**

Docker container manager.

| Method | Description |
|--------|-------------|
| `initialize()` | Start XDAQ Docker container |
| `start_container()` | Create and run container |
| `stop()` | Stop Docker container |

---

### Spy Server Interface

**Location:** `server/app/utils/spy.py`

Connects to XDAQ ReadoutUnit spy server (port 6060).

**Class: ReadoutUnitSpy**

| Method | Description |
|--------|-------------|
| `start(daq_state)` | Initialize spy connection |
| `stop()` | Shutdown and cleanup |
| `get_object(hist_type, idx)` | Retrieve histogram/waveform |

---

### Graphite Client

**Location:** `server/app/utils/graphite.py`

HTTP client for Graphite time-series database.

**Class: GraphiteClient**

| Method | Description |
|--------|-------------|
| `get_data(target, from, until, format)` | Query metrics |
| `is_connected()` | Test connectivity |

---

### Current Monitor Interfaces

**Location:** `server/app/utils/tetramm.py`

**Class: TetrAMMController**

Controls TetrAMM via socket connection.

| Method | Description |
|--------|-------------|
| `initialize()` | Connect to device |
| `disconnect()` | Close socket |
| `get_data()` | Read current |
| `get_accumulated_charge()` | Total charge during run |
| `start_acquisition()` | Begin collection thread |
| `stop_acquisition()` | Halt collection |

**Location:** `server/app/utils/rbd9103.py`

**Class: RBD9103Controller**

Controls RBD 9103 via serial port.

---

## Configuration Files

### conf/settings.json

Main DAQ state persistence.

```json
{
  "running": false,
  "start_time": 0,
  "run": 0,
  "save": false,
  "limit_size": false,
  "file_size_limit": 0,
  "boards": [
    {
      "id": "0",
      "name": "V1725",
      "chan": 16,
      "dpp": "PHA",
      "link_type": 0,
      "link_num": 0,
      "vme": "0x0000"
    }
  ]
}
```

### conf/BoardName_ID.json

Per-board register configuration.

```json
{
  "registers": {
    "reg_105C": {
      "value": "0x00000064",
      "name": "Trapezoid Rise Time",
      "channel": 0,
      "address": "0x105C"
    }
  }
}
```

### conf/topology.xml

XDAQ topology definition (ReadoutUnit, BuilderUnit configuration).

### conf/current.json

Current monitor settings.

```json
{
  "module_type": "tetramm",
  "tetramm_ip": "169.254.145.10",
  "tetramm_port": 10001,
  "total_accumulated": 0,
  "graphite_host": "172.18.9.54",
  "graphite_port": 2003
}
```

### conf/stats.json

Graphite metric path configuration.

```json
{
  "graphite_host": "lunaserver",
  "graphite_port": 80,
  "paths": [
    {"path": "accelerator.terminal_voltage", "alias": "Terminal V", "enabled": true}
  ]
}
```

### calib/BoardName_ID.cal

Calibration coefficients (one line per channel).

```
0.5 10.0
0.5 12.0
```

---

## Data Flow

### Run Start Sequence

```
1. POST /experiment/start_run
   │
2. ├─ Verify DAQ not running
   ├─ Verify boards configured
   │
3. ├─ prepare_run_start()
   │   ├─ Create data/runN directory (if saving)
   │   ├─ Copy board configs to run directory
   │   └─ Copy calibration files to run directory
   │
4. ├─ configure_xdaq_for_run()
   │   ├─ Write RUCaen.conf
   │   └─ Configure topology
   │
5. ├─ start_xdaq()
   │   ├─ Configure state machine
   │   └─ Enable acquisition
   │
6. ├─ start_board_monitoring()
   │   └─ Start health check thread
   │
7. ├─ spy_manager.start_spy()
   │   └─ Connect to spy socket (port 6060)
   │
8. └─ Create RunMetadata in database
```

### Histogram Data Flow

```
CAEN Digitizer Board
       │
       ▼
XDAQ ReadoutUnit (Docker)
       │
       ├──► Data Files (if saving enabled)
       │
       ▼
Spy Socket (port 6060)
       │
       ▼
ReadoutUnitSpy (spy.py)
       │
       ▼
SpyManager (spy_manager.py)
       │
       ├─ Apply rebin factor
       └─ Convert to JSON (TBufferJSON)
       │
       ▼
GET /histograms/<board>/<channel>
       │
       ▼
Frontend Visualization
```

---

## Adding New Features

### Adding a New API Endpoint

1. **Create or modify route file** in `server/app/routes/`

```python
from flask import Blueprint, jsonify, request
from app.utils.jwt_utils import jwt_required_custom

# If new file, create blueprint
my_bp = Blueprint('my_feature', __name__)

@my_bp.route('/my_feature/action', methods=['POST'])
@jwt_required_custom
def my_action():
    data = request.get_json()
    # Implementation
    return jsonify({'status': 'ok', 'result': result})
```

2. **Register blueprint** in `server/app/__init__.py`

```python
from app.routes.my_feature import my_bp
app.register_blueprint(my_bp)
```

3. **Add frontend API call** in `frontend/src/lib/api.ts`

```typescript
export const myAction = async (params: MyParams): Promise<MyResponse> => {
  const response = await api.post('/my_feature/action', params);
  return response.data;
};
```

### Adding a New Service Manager

1. **Create service file** in `server/app/services/`

```python
class MyManager:
    def __init__(self):
        self._config = self._load_config()

    def _load_config(self):
        config_path = os.path.join('conf', 'my_config.json')
        if os.path.exists(config_path):
            with open(config_path, 'r') as f:
                return json.load(f)
        return {}

_my_manager = None

def get_my_manager():
    global _my_manager
    if _my_manager is None:
        _my_manager = MyManager()
    return _my_manager
```

2. **Use in routes**

```python
from app.services.my_manager import get_my_manager

@my_bp.route('/my_feature/data')
def get_data():
    manager = get_my_manager()
    return jsonify(manager.get_data())
```

### Adding a New Database Model

1. **Create model** in `server/app/models/`

```python
from app import db

class MyModel(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(64), index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
```

2. **Import in models/__init__.py**

3. **Generate migration**

```bash
cd server
flask db migrate -m "Add MyModel"
flask db upgrade
```

### Adding a New Hardware Interface

1. **Create utility class** in `server/app/utils/`

```python
class MyDeviceController:
    def __init__(self):
        self.connected = False
        self._settings = self._load_settings()

    def connect(self, address):
        # Connection logic
        self.connected = True

    def disconnect(self):
        self.connected = False

    def read_data(self):
        if not self.connected:
            raise RuntimeError("Not connected")
        # Read logic
        return data
```

2. **Create routes** for the device
3. **Add cleanup** to `main.py` shutdown handler

---

## Design Patterns

### Singleton Pattern
Services (DAQManager, SpyManager, etc.) use singletons to ensure single resource connections.

### Persistent Connection Pattern
DigitizerContainer maintains open board connections to reduce latency.

### State Machine Pattern
DAQ uses running/stopped states; XDAQ uses Configure/Enable/Disable transitions.

### Observer Pattern
Board monitoring thread watches connection health; tuning thread updates session progress.

---

## Error Handling

### Connection Retry Logic
- Digitizer: 3 attempts with 1-second delays
- TetrAMM: Socket timeout protection
- Graphite: HTTP error handling

### Resource Cleanup
- Shutdown handler closes all resources
- Thread-safe stop events
- Database transactions properly committed/rolled back

### Test Mode
Use `TEST_FLAG=True` environment variable to run without hardware:
- Creates dummy boards
- Returns mock histogram data
- All database operations remain functional
