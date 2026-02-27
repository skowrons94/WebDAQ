# User Guide

This guide provides comprehensive instructions for operating the LunaDAQ system. It covers all major features from starting acquisitions to analyzing data.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Dashboard Overview](#dashboard-overview)
3. [Starting and Stopping Runs](#starting-and-stopping-runs)
4. [Monitoring Data](#monitoring-data)
5. [Managing Run Metadata](#managing-run-metadata)
6. [Board Configuration](#board-configuration)
7. [Settings and Customization](#settings-and-customization)

---

## Getting Started

### Logging In

1. Open your web browser and navigate to the LunaDAQ frontend URL (typically `http://localhost:3000` or the configured server address).
2. Enter your username and password on the login screen.
3. Click **Login** to access the dashboard.

```{note}
User accounts must be created by an administrator using the command line:
`flask --app server create-user`
```

### First-Time Setup

Before your first acquisition, ensure:

1. **Boards are configured**: Go to **Settings > Boards** to add your CAEN digitizer boards
2. **Current monitor is connected**: If using TetrAMM or RBD9103, configure in **Settings**
3. **Graphite metrics are set up**: If monitoring slow-control data, add metric paths in **Settings > Metrics**

---

## Dashboard Overview

The Dashboard is your central control center with multiple tabs for different functions.

### Overview Tab

The main tab displays a comprehensive summary of your acquisition status.

#### Card View

The card view shows key information at a glance:

| Card | Description |
|------|-------------|
| **Run Status** | Current run number and acquisition state (Running/Stopped) |
| **Current Readings** | Real-time current from TetrAMM/RBD9103 (if configured) |
| **Accumulated Charge** | Charge accumulated in current run and total since last reset |
| **Data Bandwidth** | File writing speed and output bandwidth |
| **ROI Counts** | Counts in user-defined Regions of Interest |
| **Metrics** | Slow-control values from Graphite (configurable) |

#### Experiment Controls Panel

The control panel provides:

- **Start/Stop buttons**: Begin or end data acquisition
- **Metadata input fields**: Enter run information before starting
- **Current control**: Monitor and control current acquisition settings

#### Acquisition Parameters Panel

Configure acquisition settings:

| Setting | Description |
|---------|-------------|
| **Run Number** | Current run number (auto-increments by default) |
| **Auto-increment** | Automatically increase run number after each run |
| **Save Data** | Enable/disable writing data to disk |
| **Save Waveforms** | Include waveform data in saved files |
| **Limit File Size** | Enable maximum file size limits |
| **File Size Limit** | Maximum file size in MB |

### Stats Tab

Displays time-series charts for slow-control metrics from the Graphite database.

```{note}
This feature requires a configured Graphite server connection.
```

### Histogram Tab

View all energy spectra from each acquisition channel in real-time.

**Key Features:**

- **Layout Toggle**: Switch between grid view and list view using the toggle in the top right
- **Scale Selection**: Choose linear or logarithmic scale for all histograms
- **ROI Configuration**: Click the gear icon next to each channel to set up Regions of Interest

**Interacting with Histograms:**

1. **Zoom**: Click and drag to zoom into a region
2. **Pan**: Right-click and drag to pan across the spectrum
3. **Reset**: Double-click to reset the view
4. **ROI Highlight**: Configured ROIs are highlighted on the histogram

### Waveform Tab

Monitor waveform data for each acquisition channel. This tab functions similarly to the Histogram tab but displays pulse waveforms instead of energy spectra.

```{important}
Waveform acquisition must be enabled in the Acquisition Parameters panel for this tab to show data.
```

---

## Starting and Stopping Runs

### Before Starting a Run

1. **Verify board connections**: Check that all boards show "Connected" status in the card view
2. **Enter run metadata**:
   - **Target Name**: Sample or target being measured
   - **Run Type**: Type of measurement (e.g., "long run", "background", "calibration")
   - **Terminal Voltage (TV)**: Accelerator terminal voltage (for LUNA-400)
   - **Probe Voltage (PV)**: Probe voltage setting (for LUNA-400)

```{warning}
If metadata values haven't changed since the last run, a warning will appear. Review the values to ensure they are correct for the new run.
```

3. **Configure acquisition settings**:
   - Verify run number is correct
   - Check that "Save Data" is enabled if you want to record data
   - Enable "Save Waveforms" if waveform data is needed

### Starting Acquisition

1. Click the **Start** button in the Experiment Controls panel
2. The system will:
   - Create a new run directory (if saving)
   - Configure the XDAQ system
   - Begin data acquisition
   - Start the spy server for monitoring
3. The run status indicator will change to "Running"

### During Acquisition

While the run is active:

- Monitor histograms in the **Histogram** tab
- Watch waveforms in the **Waveform** tab (if enabled)
- Check current readings and accumulated charge in the card view
- View real-time metrics from Graphite

### Stopping Acquisition

1. Click the **Stop** button in the Experiment Controls panel
2. The system will:
   - Stop the XDAQ acquisition
   - Save run metadata to the database
   - Write a metadata.json file to the run directory
   - Update the accumulated charge from current readings
3. The run status indicator will change to "Stopped"

### Run Directory Structure

When data saving is enabled, each run creates a directory:

```
data/
└── runN/
    ├── BoardName_ID.dat      # Raw data files
    ├── BoardName_ID.json     # Board configuration snapshot
    ├── BoardName_ID.cal      # Calibration snapshot
    └── metadata.json         # Run metadata
```

---

## Monitoring Data

### Real-Time Histograms

The Histogram tab provides live visualization of acquired spectra.

#### Setting Up a Region of Interest (ROI)

1. Navigate to the **Histogram** tab
2. Click the **gear icon** next to the channel header you want to configure
3. Enter the ROI boundaries:
   - **ROI Min**: Lower bin number
   - **ROI Max**: Upper bin number
4. Click **Save**

The ROI will be highlighted on the histogram, and counts within the ROI will appear in the Overview tab.

#### Understanding Histogram Types

| Type | Description | Board Type |
|------|-------------|------------|
| **Energy** | Energy spectrum from trapezoidal filter | DPP-PHA |
| **QLong** | Long gate charge integral | DPP-PSD |
| **QShort** | Short gate charge integral | DPP-PSD |
| **PSD** | Pulse Shape Discrimination 2D plot | DPP-PSD |

### Waveform Monitoring

Enable waveform recording to view individual pulses:

1. Go to the **Overview** tab
2. In Acquisition Parameters, enable **Save Waveforms**
3. Switch to the **Waveform** tab
4. Waveforms will update in real-time during acquisition

```{note}
Waveform recording increases data volume and file sizes significantly.
```

### Current Monitoring

If a current monitor (TetrAMM or RBD9103) is configured:

- **Real-time current**: Displayed in the card view
- **Accumulated charge**: Updated continuously during acquisition
- **Total accumulated**: Cumulative charge across multiple runs

To reset the total accumulated charge:
1. Use the API endpoint `/current/reset_total_accumulated`
2. Or configure through the settings panel

---

## Managing Run Metadata

### Logbook Panel

The Logbook panel provides a table view of all recorded runs.

**Features:**

| Feature | Description |
|---------|-------------|
| **Filter by Target** | Use the input field to filter runs by target name |
| **Column Selection** | Click the columns button to show/hide columns |
| **Edit Run Info** | Click the menu icon (three dots) to edit run metadata |
| **Export Data** | Click **Download CSV** to export the database |

### Editing Run Information

To modify a run's metadata after acquisition:

1. Go to the **Logbook** panel
2. Find the run you want to edit
3. Click the **menu icon** (three dots) on the right
4. Select the field to edit:
   - Target Name
   - Run Type
   - Terminal Voltage
   - Probe Voltage
   - Notes
   - Quality Flag (good/unknown/bad)
5. Make your changes and save

### Quality Flags

Mark runs with quality flags to indicate data quality:

| Flag | Description |
|------|-------------|
| **Good** | Run data is valid and suitable for analysis |
| **Unknown** | Data quality has not been evaluated |
| **Bad** | Run has issues and should be excluded from analysis |

### Adding Notes

Add notes to document run conditions or observations:

1. In the Logbook, find the run
2. Click the edit menu
3. Select "Edit Notes"
4. Enter your notes (supports multiple lines)
5. Save changes

---

## Board Configuration

### Adding a New Board

1. Go to **Settings > Boards**
2. Click **Add Board**
3. Enter the connection parameters:
   - **Link Type**: USB (0), Optical (1), or A4818 (5)
   - **Link Number**: Physical port number
   - **VME Address**: VME base address (for VME boards)
4. Click **Connect**

The system will:
- Attempt to connect to the board
- Read board information (model, serial, channels)
- Query current register configuration
- Create configuration files

### Removing a Board

1. Go to **Settings > Boards**
2. Find the board to remove
3. Click the **Remove** button
4. Confirm the removal

```{warning}
Removing a board deletes its configuration files. Back up configurations before removing.
```

### Modifying Board Configuration

To change board registers:

1. Go to the **DAQ Configuration** panel (Board icon in navigation)
2. Select the board from the dropdown
3. Modify register values:
   - **Trigger Threshold**: Trigger level in ADC counts
   - **DC Offset**: Baseline offset
   - **Trapezoid Settings**: Rise time, flat top, decay time
   - **Pre-trigger**: Samples before trigger
4. Changes are applied immediately to the board

### Energy Calibration

Set energy calibration coefficients for each channel:

1. Go to the **DAQ Configuration** panel
2. Select the board and channel
3. Enter calibration coefficients:
   - **a (slope)**: Energy per bin
   - **b (offset)**: Energy offset

The calibration converts bin numbers to energy:
```
Energy = a × bin + b
```

---

## Settings and Customization

### Appearance Settings

| Setting | Description |
|---------|-------------|
| **Dark Mode** | Toggle between light and dark themes |
| **Visible Metrics** | Select which metrics appear in the card view |
| **Visible Tabs** | Show/hide dashboard tabs |

### Boards Settings

Manage digitizer board connections (see Board Configuration section).

### Metrics Settings

Configure Graphite metrics to display in the Overview tab:

1. Go to **Settings > Metrics**
2. Click **Add Metric**
3. Enter:
   - **Path**: Graphite metric path (e.g., `accelerator.terminal_voltage`)
   - **Alias**: Display name (e.g., "Terminal V")
   - **Refresh Rate**: Update interval in seconds
   - **Multiplier**: Scale factor for display (e.g., 0.001 to convert mV to V)
4. Click **Save**

To remove a metric, click the **Delete** button next to it.

---

## Quick Reference

### Keyboard Shortcuts (Frontend)

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` / `Cmd+S` | Start/Stop acquisition (when focused on control panel) |
| `Esc` | Close modal dialogs |

### Common Tasks

| Task | Steps |
|------|-------|
| **Start a run** | Enter metadata → Click Start |
| **Stop a run** | Click Stop → Verify metadata saved |
| **Check connectivity** | Settings → Boards → Refresh |
| **View spectrum** | Histogram tab → Select channel |
| **Set ROI** | Histogram tab → Gear icon → Enter range |
| **Export data** | Logbook → Download CSV |
| **Add metric** | Settings → Metrics → Add |

### Status Indicators

| Indicator | Meaning |
|-----------|---------|
| **Green** | System operational / Connected |
| **Yellow** | Warning / Partial connectivity |
| **Red** | Error / Disconnected |
| **Blue** | Acquisition running |
| **Gray** | Inactive / Idle |

---

## Best Practices

### Before Long Runs

1. **Verify all boards** are connected and responding
2. **Check disk space** on the data storage volume
3. **Enable file size limits** if disk space is limited
4. **Document target** and experimental conditions in metadata
5. **Test with a short run** before starting long acquisitions

### Data Management

1. **Back up data regularly** to external storage
2. **Use quality flags** to mark problematic runs
3. **Add notes** about unusual conditions or observations
4. **Export logbook** periodically for offline records

### Troubleshooting During Runs

If issues occur during acquisition:

1. **Check the card view** for error indicators
2. **Verify board connectivity** in Settings
3. **Monitor bandwidth** - low bandwidth may indicate disk issues
4. **Check XDAQ status** via the API if needed
5. **Review server logs** for detailed error messages

See the [Troubleshooting Guide](troubleshooting.md) for common issues and solutions.
