# Usage

This page provide a description of LUNADAQ functionality and user guide.

---

## Dashboard panel
Under the dashboard panel you will find all the main components to control and monitor the acquisition
### Overview tab
The main tab offering a summary a summary of the acquisition status, main monitored metrics, a control panel for the acquisition and a configuration panel.
- The **Card View** display several key informations including:
    - The run status.
    - Tetramm status and current readings.
    - Accumulated charge for the run and total accumulated charge since last reset.
    - Data bandwith and writing speed.
    - Counts in some predefined regions of interest.
    - The value for some predefined metrics of the slow-control system logged in the time-series database. The shown information can be configured in the settings.
- **Experiment Controls** panel offers functionality to start and stop the acquisition, input metadata for the run and control the current acquisition.
- **Aquisition Parameters** let you adjust some settings.

---
### Stats tab

The stats tab

### Histogram tab

The histogram tab offers a view of all the spectra acquired for each channel. Key functionality: 
- **Change layout** from grid view to list view using the switch on the top right.
- **Change scale** between linear or logarithmic for all the histogram.
- **Set a monitored Region of Interest** for each channel using the gear icon right of each histogram channel header.
---
### Waveform tab

Similarly to the Histogram tab, here you can monitor the waveform spectra for each acquisition channel.

---
## Logbook panel

The logbook panel shows a table display the informations for saved in the database for all runs.
- **Filter by target name** using the input field on the top right.
- **Change the column displayed** using the button on the right.
- If you wish to **edit informations for a run** open the contextual menu on the right.
- It is possible to export a complete record of the database using the **Download CSV** button.
## Grafana

This link opens the Grafana interface in another tab of the browser.

## DAQ configuration panel

This panel offers an interface to change the settings of the CAEN boards and set energy calibration for each channel.

---

## Settings

### Appearance

- Switch between light and **Dark mode**.
- Selected metric to hide/show from the card view in the overview tab
- Hide/show tabs from the dashboard

### Boards

Here you can add and remove a new CAEN board to the system.

### Metrics

Each slow control metric that is logged into the Graphite time-series database can be displayed in the card view of the overview tab.

Use this form to **add metrics to be displayed in the main tab**. You can set the refresh time and multiplier if you wish to display the value in different units.


