# Troubleshooting Guide

This guide helps diagnose and resolve common issues with the LunaDAQ system. Issues are organized by category for quick reference.

---

## Table of Contents

1. [Server Issues](#server-issues)
2. [Frontend Issues](#frontend-issues)
3. [Board Connection Issues](#board-connection-issues)
4. [Data Acquisition Issues](#data-acquisition-issues)
5. [Histogram and Visualization Issues](#histogram-and-visualization-issues)
6. [Current Monitor Issues](#current-monitor-issues)
7. [Database Issues](#database-issues)
8. [Docker and XDAQ Issues](#docker-and-xdaq-issues)
9. [Network and Connectivity Issues](#network-and-connectivity-issues)
10. [Performance Issues](#performance-issues)
11. [Diagnostic Commands](#diagnostic-commands)

---

## Server Issues

### Server Won't Start

**Symptoms:**
- `python3 main.py` exits immediately with an error
- Server crashes on startup

**Solutions:**

| Cause | Solution |
|-------|----------|
| Port 5001 already in use | Kill the existing process: `lsof -ti:5001 \| xargs kill` |
| Missing dependencies | Reinstall: `pip install -r requirements.txt` |
| Database not initialized | Run: `flask db init && flask db migrate && flask db upgrade` |
| CAEN libraries missing | Install CAENVMElib, CAENComm, CAENDigitizer (see Installation Guide) |
| Python version mismatch | Ensure Python 3.7+ is installed |

**Run in test mode without hardware:**
```bash
TEST_FLAG=True python3 main.py
```

### Server Crashes During Operation

**Check the logs for error messages:**
```bash
# View recent output
tail -100 server.log

# Monitor live output
python3 main.py 2>&1 | tee server.log
```

**Common causes:**
- Board disconnection during acquisition
- Out of memory (check with `free -h`)
- Disk full (check with `df -h`)

### API Requests Return 401 Unauthorized

**Symptoms:**
- Frontend shows "Unauthorized" errors
- API calls fail with 401 status

**Solutions:**

1. **Token expired**: Log out and log back in
2. **Invalid token**: Clear browser cookies and local storage, then log in again
3. **Clock synchronization**: Ensure server and client clocks are synchronized

---

## Frontend Issues

### Frontend Won't Build

**Symptoms:**
- `npm run build` fails with errors
- TypeScript compilation errors

**Solutions:**

```bash
# Clear cache and reinstall
cd frontend
rm -rf node_modules .next
npm cache clean --force
npm install
npm run build
```

### Frontend Won't Connect to Server

**Symptoms:**
- "Network Error" messages
- Data not loading
- Spinners never stop

**Solutions:**

1. **Check .env configuration:**
   ```bash
   cat frontend/.env
   # Should contain:
   # NEXT_PUBLIC_API_URL=http://127.0.0.1:5001
   ```

2. **Verify server is running:**
   ```bash
   curl http://localhost:5001/experiment/get_run_number
   ```

3. **Rebuild after .env changes:**
   ```bash
   npm run build
   npm run start
   ```

4. **Check CORS settings** if server and frontend are on different domains

### Page Shows Blank or Errors

**Solutions:**

1. **Clear browser cache**: `Ctrl+Shift+R` or `Cmd+Shift+R`
2. **Check browser console** for JavaScript errors (F12 → Console)
3. **Try a different browser** to rule out browser-specific issues
4. **Check for ad blockers** that might interfere with API calls

### Login Fails

**Symptoms:**
- Correct credentials rejected
- Login button doesn't respond

**Solutions:**

1. **Verify credentials** by checking directly:
   ```bash
   curl -X POST http://localhost:5001/login \
     -H "Content-Type: application/json" \
     -d '{"username":"your_user","password":"your_pass"}'
   ```

2. **Reset password** by creating a new user:
   ```bash
   cd server
   flask --app server create-user
   ```

---

## Board Connection Issues

### Board Not Detected

**Symptoms:**
- "Failed to connect" error when adding board
- Board appears disconnected in status

**Diagnostic steps:**

1. **Check physical connection:**
   - USB cable properly connected
   - Board powered on
   - Optical fiber (if applicable) properly connected

2. **Verify CAEN libraries:**
   ```bash
   # Check if libraries are installed
   ldconfig -p | grep -i caen
   ```

3. **Check USB permissions (Linux):**
   ```bash
   # Add user to dialout group
   sudo usermod -a -G dialout $USER
   # Log out and back in for changes to take effect
   ```

4. **Test with CAEN tools:**
   ```bash
   # If available, use CAEN's diagnostic tools
   CAENDigitizerDemo
   ```

### Board Connection Unstable

**Symptoms:**
- Board connects then disconnects
- Intermittent communication errors
- "Board not responding" during acquisition

**Solutions:**

| Cause | Solution |
|-------|----------|
| Loose cable | Reseat USB/optical cable |
| Power issues | Check board power supply |
| USB hub problems | Connect directly to computer |
| Driver issues | Reinstall CAEN drivers |
| Firmware issues | Update board firmware |

**Refresh board connections:**
```bash
curl -X POST http://localhost:5001/experiment/refresh_board_connections
```

### Wrong Board Parameters

**Symptoms:**
- Board connects but wrong model shown
- Wrong number of channels displayed

**Solutions:**

1. **Check link type** (0=USB, 1=Optical, 5=A4818)
2. **Verify VME address** for VME-based systems
3. **Remove and re-add the board** with correct parameters

---

## Data Acquisition Issues

### Acquisition Won't Start

**Symptoms:**
- Start button does nothing
- Error when clicking Start

**Check list:**

| Check | Command/Action |
|-------|----------------|
| Boards connected | `curl http://localhost:5001/digitizer/connectivity` |
| Docker running | `docker ps` |
| XDAQ container exists | `docker ps -a \| grep xdaq` |
| Run directory writable | `touch data/test && rm data/test` |

**Common solutions:**

1. **Reset XDAQ:**
   ```bash
   curl -X POST http://localhost:5001/experiment/xdaq/reset
   ```

2. **Restart Docker container:**
   ```bash
   docker restart xdaq_container
   ```

3. **Check server logs** for specific error messages

### Acquisition Starts but No Data

**Symptoms:**
- Run shows as "Running" but no counts
- Histograms stay at zero
- No data files created

**Solutions:**

1. **Check spy server status:**
   ```bash
   curl http://localhost:5001/spy/status
   ```

2. **Verify trigger settings:**
   - Trigger threshold may be too high
   - Channel may be disabled
   - Input polarity may be wrong

3. **Check signal source:**
   - Verify detector is providing signals
   - Check signal amplitude on oscilloscope

4. **Verify channel enabled:**
   ```bash
   curl http://localhost:5001/digitizer/channel/0/0
   ```

### Acquisition Stops Unexpectedly

**Symptoms:**
- Run stops without user action
- Error message about XDAQ

**Solutions:**

1. **Check disk space:**
   ```bash
   df -h /path/to/data
   ```

2. **Check file size limits:**
   - If limits are enabled, acquisition may stop when limit is reached

3. **Check board connectivity:**
   - Board may have disconnected
   - Check server logs for error messages

4. **Monitor XDAQ status:**
   ```bash
   curl http://localhost:5001/experiment/xdaq/file_bandwidth
   ```

### Low Count Rates

**Symptoms:**
- Fewer counts than expected
- High dead time

**Solutions:**

1. **Check trigger threshold:** May be set too high
2. **Check pile-up rejection:** May be rejecting good events
3. **Check dead time:**
   ```bash
   curl http://localhost:5001/stats/board_rates_dt
   ```
4. **Reduce input rate** if pile-up is excessive
5. **Adjust trapezoid settings** for faster processing

---

## Histogram and Visualization Issues

### Histograms Not Updating

**Symptoms:**
- Histograms frozen during acquisition
- Old data displayed

**Solutions:**

1. **Check spy server:**
   ```bash
   curl http://localhost:5001/spy/status
   ```

2. **Verify acquisition is running:**
   ```bash
   curl http://localhost:5001/experiment/get_run_status
   ```

3. **Restart spy server** by stopping and starting acquisition

4. **Clear browser cache** and refresh page

### Histogram Shows Wrong Data

**Symptoms:**
- Wrong channel displayed
- Data from previous run

**Solutions:**

1. **Clear histogram buffers** by restarting acquisition
2. **Verify board/channel selection** in the interface
3. **Check histogram type** (energy vs. charge)

### Waveforms Not Visible

**Symptoms:**
- Waveform tab shows no data
- Waveforms all zero

**Solutions:**

1. **Enable waveform recording:**
   ```bash
   curl -X POST http://localhost:5001/waveforms/activate
   ```

2. **Check waveform status:**
   ```bash
   curl http://localhost:5001/waveforms/status
   ```

3. **Verify register 0x8000 bit 16 is set:**
   ```bash
   curl http://localhost:5001/digitizer/0/registers
   ```

---

## Current Monitor Issues

### TetrAMM Not Connecting

**Symptoms:**
- "Connection failed" error
- Current reads as zero

**Solutions:**

1. **Check network connectivity:**
   ```bash
   ping 169.254.145.10  # Default TetrAMM IP
   ```

2. **Verify IP and port settings:**
   ```bash
   curl http://localhost:5001/current/get_ip
   curl http://localhost:5001/current/get_port
   ```

3. **Try reconnecting:**
   ```bash
   curl http://localhost:5001/current/connect
   ```

4. **Check firewall rules** for port 10001

### RBD9103 Not Connecting

**Symptoms:**
- Serial port errors
- Device not found

**Solutions:**

1. **Check serial port:**
   ```bash
   ls -la /dev/ttyUSB*
   ls -la /dev/ttyACM*
   ```

2. **Verify permissions:**
   ```bash
   sudo usermod -a -G dialout $USER
   # Log out and back in
   ```

3. **Check cable connection** and device power

### Current Readings Incorrect

**Symptoms:**
- Unexpected current values
- Noisy readings

**Solutions:**

1. **Check range setting** (may be set too high/low)
2. **Verify channel selection**
3. **Check for grounding issues** in the measurement setup
4. **Reset device:**
   ```bash
   curl -X POST http://localhost:5001/current/reset
   ```

---

## Database Issues

### Migration Errors

**Symptoms:**
- `flask db migrate` fails
- "Table already exists" errors

**Solutions:**

```bash
cd server

# Option 1: Reset migrations (loses history)
rm -rf migrations
flask db init
flask db migrate -m "Fresh start"
flask db upgrade

# Option 2: Fix specific migration
flask db stamp head  # Mark current state
flask db migrate -m "Fix"
flask db upgrade
```

### Database Corruption

**Symptoms:**
- "Database is locked" errors
- Queries fail with unexpected errors

**Solutions:**

1. **Check for stale locks:**
   ```bash
   fuser server/app.db  # Shows processes using the file
   ```

2. **Backup and repair:**
   ```bash
   cp server/app.db server/app.db.backup
   sqlite3 server/app.db "PRAGMA integrity_check;"
   sqlite3 server/app.db ".recover" | sqlite3 server/app_recovered.db
   ```

### Run Metadata Not Saving

**Symptoms:**
- Runs not appearing in logbook
- Metadata lost after stop

**Solutions:**

1. **Check server logs** for database errors
2. **Verify database file is writable:**
   ```bash
   ls -la server/app.db
   touch server/app.db
   ```
3. **Check disk space**

---

## Docker and XDAQ Issues

### Docker Container Won't Start

**Symptoms:**
- XDAQ initialization fails
- Docker errors in logs

**Solutions:**

1. **Check Docker status:**
   ```bash
   sudo systemctl status docker
   docker ps -a
   ```

2. **Pull latest image:**
   ```bash
   docker pull skowrons/xdaq:latest
   ```

3. **Remove old container:**
   ```bash
   docker stop xdaq_container
   docker rm xdaq_container
   ```

4. **Check available resources:**
   ```bash
   docker system df
   docker system prune  # Careful: removes unused data
   ```

### XDAQ State Machine Errors

**Symptoms:**
- "Configure failed" errors
- "Enable failed" errors

**Solutions:**

1. **Reset XDAQ:**
   ```bash
   curl -X POST http://localhost:5001/experiment/xdaq/reset
   ```

2. **Restart container:**
   ```bash
   docker restart xdaq_container
   ```

3. **Check container logs:**
   ```bash
   docker logs xdaq_container
   ```

### Spy Server Not Responding

**Symptoms:**
- Port 6060 connection refused
- Histograms not available

**Solutions:**

1. **Check if spy server is running:**
   ```bash
   netstat -an | grep 6060
   ```

2. **Verify XDAQ is in correct state:**
   ```bash
   curl http://localhost:5001/experiment/get_run_status
   ```

3. **Check LunaSpy installation:**
   ```bash
   which LunaSpy
   ```

---

## Network and Connectivity Issues

### API Timeout Errors

**Symptoms:**
- Requests hang then fail
- "Timeout" error messages

**Solutions:**

1. **Check server responsiveness:**
   ```bash
   curl -w "@curl-format.txt" http://localhost:5001/experiment/get_run_number
   ```

2. **Reduce request frequency** if overloading server
3. **Check network connectivity** between frontend and server
4. **Increase timeout** in frontend configuration

### Graphite Connection Failed

**Symptoms:**
- Metrics not loading
- "Cannot connect to Graphite" errors

**Solutions:**

1. **Verify Graphite address:**
   ```bash
   curl http://localhost:5001/stats/graphite_config
   ```

2. **Test Graphite directly:**
   ```bash
   curl "http://graphite_host/render?target=*&format=json"
   ```

3. **Update configuration:**
   ```bash
   curl -X POST http://localhost:5001/stats/graphite_config \
     -H "Content-Type: application/json" \
     -d '{"host":"correct_host","port":80}'
   ```

---

## Performance Issues

### Slow Histogram Updates

**Symptoms:**
- Long delay between data and display
- UI feels sluggish

**Solutions:**

1. **Reduce rebin factor** for faster processing
2. **Close unused browser tabs**
3. **Check server CPU usage:**
   ```bash
   top -p $(pgrep -f main.py)
   ```
4. **Reduce polling frequency** in frontend settings

### High Memory Usage

**Symptoms:**
- Server consumes excessive memory
- System becomes slow

**Solutions:**

1. **Monitor memory:**
   ```bash
   ps aux | grep main.py
   free -h
   ```

2. **Reduce histogram buffer sizes**
3. **Restart server** to clear accumulated buffers
4. **Check for memory leaks** in logs

### Disk Space Running Low

**Symptoms:**
- Data not saving
- "No space left" errors

**Solutions:**

1. **Check disk usage:**
   ```bash
   df -h
   du -sh data/*
   ```

2. **Archive old runs** to external storage
3. **Enable file size limits** to prevent runaway data collection
4. **Delete test/bad runs** if no longer needed

---

## Diagnostic Commands

### Server Health Check

```bash
# Check if server is responding
curl http://localhost:5001/experiment/get_run_number

# Check run status
curl http://localhost:5001/experiment/get_run_status

# Check board connectivity
curl http://localhost:5001/digitizer/connectivity

# Check XDAQ bandwidth
curl http://localhost:5001/experiment/xdaq/file_bandwidth
```

### System Status

```bash
# Check all services
ps aux | grep -E "main.py|docker|node"

# Check ports in use
netstat -tlnp | grep -E "5001|3000|6060"

# Check disk space
df -h

# Check memory
free -h

# Check Docker
docker ps -a
docker system df
```

### Log Analysis

```bash
# View server output
tail -f /path/to/server.log

# View Docker logs
docker logs -f xdaq_container

# Search for errors
grep -i error /path/to/server.log | tail -50
```

### Database Queries

```bash
# Open database
sqlite3 server/app.db

# Check tables
.tables

# View recent runs
SELECT run_number, start_time, end_time, target_name FROM run_metadata ORDER BY run_number DESC LIMIT 10;

# Exit
.quit
```

---

## Getting Help

If you cannot resolve an issue:

1. **Collect diagnostic information:**
   - Server logs
   - Browser console output
   - Docker logs
   - System information (`uname -a`, `python --version`)

2. **Check documentation:**
   - [Installation Guide](installation.md)
   - [User Guide](usage.md)
   - [Server Architecture](server-architecture.md)

3. **Contact support:**
   - Jakub Skowronski: jakub.skowronski@pd.infn.it
   - Alessandro Compagnucci: alessandro.compagnucci@gssi.it

4. **Report bugs:**
   - GitHub Issues: https://github.com/skowrons94/WebDAQ/issues
   - Include logs, steps to reproduce, and system information
