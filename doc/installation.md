# Installation

Getting WebDAQ onto a machine, and starting it the way the control room expects.
If the machine is already set up and you only need to start the application, skip
to [section 4](#4-starting-it).

---

## 1. What the machine needs

| | |
|---|---|
| **Operating system** | Linux for a DAQ machine; macOS works for development. |
| **CAEN libraries** | CAENVMElib, CAENComm and CAENDigitizer, for real hardware. Without them WebDAQ still runs in test mode with simulated boards. |
| **Build tools** | `git`, `cmake`, `make`, a C++ compiler, `curl`. The installer puts them in place on a fresh machine. |
| **conda** | Miniforge, installed by the installer if no conda is present. Everything lives in an environment called `luna`. |
| **ROOT** | Comes from the `luna` environment. It is needed for the spectra and for the offline converter. |

Nothing runs in Docker, and there is no container to start. Acquisition happens
inside the server process through CaenDAQ.

```{note}
Versions before 4.0 ran acquisition as XDAQ inside a Docker container, with a
separate spy server on port 6060. If a procedure tells you to start a container
or to check port 6060, it predates 4.0 and does not apply.
```

---

## 2. Installing

```bash
git clone https://github.com/skowrons94/WebDAQ.git
cd WebDAQ
./install.sh
```

The installer is idempotent — every step checks whether the work is already done,
so running it again after an update is safe. It:

1. installs the system build tools;
2. checks out the two C++ submodules, **CaenDAQ** (the acquisition backend) and
   **RUReader** (the offline `.caendat` → ROOT converter);
3. installs Miniforge if conda is missing;
4. creates the `luna` environment from `environment.yml`;
5. builds RUReader and installs the `caendaq` Python module into the environment;
6. writes `frontend/.env` and builds the web interface;
7. adds a `LunaDAQ` launcher to your `~/.bashrc`.

Open a new terminal afterwards, or `source ~/.bashrc`, so the launcher is on your
PATH.

**The API address is baked into the frontend at build time.** `frontend/.env`
holds `NEXT_PUBLIC_API_URL`, and Next.js compiles it into the bundle. If the DAQ
server will be reached from other machines, set it to an address those machines
can resolve — not `127.0.0.1` — and rebuild:

```bash
cd frontend
npm run build
```

Forgetting the rebuild is the most common deployment mistake: the interface loads
and then fails every request, because the old address is still inside it.

---

## 3. The working directory

**The working directory is the experiment.** Everything the server reads and
writes is relative to the directory it was started in: `conf/` (board
configurations, the histogram dashboard, credentials), `calib/`, `data/` and the
`app.db` database. Two working directories are two independent experiments that
share one installation.

You do not have to create any of it by hand. The first launch creates the
directories, brings the database schema up and creates a default user, so an
empty directory is a valid starting point for a new campaign.

---

## 4. Starting it

### 4.1 With the launcher

```bash
LunaDAQ            # start the web interface (freeing its port first)
LunaDAQ status     # what is holding each port
LunaDAQ stop       # stop both parts, politely then firmly
LunaDAQ restart    # stop, then start the interface
LunaDAQ backend    # run the DAQ server in this terminal, for debugging
```

Then open <http://localhost:3000> and log in. The **DAQ Server** badge at the top
right starts the server itself: pick the working directory for the campaign and
press **Start**. The badge is also on the login page, so the server can be
started before anyone logs in.

`LunaDAQ stop` only ever stops processes that look like ours — an unrelated
program on port 3000 is reported and left alone, which is why it is a better
answer to a busy port than killing whatever holds it.

### 4.2 Running it inside tmux

The web interface is a long-lived process. Started from a plain SSH session it
dies when the connection drops, so start it inside **tmux**: a session that keeps
running on the machine whether or not anyone is attached to it.

```bash
tmux new -s daq        # create a session called "daq" and attach to it
LunaDAQ                # start the interface inside it
```

Now detach and leave it running: press **Ctrl-b**, release both keys, then press
**d**. You are back at your own shell; the session is still running.

| What you want | How |
|---|---|
| List the sessions on the machine | `tmux ls` |
| Attach to the session again | `tmux attach -t daq` |
| Detach and leave it running | **Ctrl-b** then **d** |
| Scroll back through the output | **Ctrl-b** then **[**, then the arrow keys or PageUp; **q** leaves scroll mode |
| Open a second window in the session | **Ctrl-b** then **c**; switch with **Ctrl-b** then **0**, **1**, … |
| Close the current window | type `exit` in it |
| Stop the whole session | attach, stop the application with `LunaDAQ stop`, then `exit` |

Every tmux command is the prefix **Ctrl-b** followed by one key; that is the only
thing worth memorising. If a session is already attached somewhere else —
somebody left it open — `tmux attach -d -t daq` takes it over.

A detached session survives a dropped SSH connection, but not a reboot of the DAQ
machine. After a reboot, attach to a new session and start it again.

---

## 5. Without hardware

```bash
TEST_FLAG=True LunaDAQ backend
```

or tick **Test Mode** in the DAQ Server panel before starting the server. Test
mode fabricates CAEN-style data for simulated boards and simulates the
picoammeter, so the whole chain — readout, data file, spectra, rates, run
metadata — works on a laptop with no digitizers attached.

Set the variable or leave it unset; **never set it to `False`**. Most of the code
reads it as "any value at all means test mode", so `TEST_FLAG=False` puts the
server into test mode while one part of it believes the hardware is real.

---

## 6. Checking the installation

With the server running and a login in hand:

| Check | Where |
|---|---|
| The server answers | The **DAQ Server** badge reads *DAQ Server Online*. |
| The boards answer | **Settings → Boards**: each board shows *Connected*. Use **Scan for boards** to find them rather than typing their settings from memory. |
| The acquisition module is installed | **DAQ → Hardware Info** names the CaenDAQ version, and says `hardware` rather than `mock / test mode`. |
| A run works | Take a short run with saving on, then open it in the Logbook: there should be a `.caendat` file and, with a current module configured, a `current.txt`. |
| The converter is installed | **Logbook → the run → Convert** offers options instead of *RUReader is not installed*. |

The server's own log is `server.log` **in the working directory it was started
in**, and the interface can show it: **DAQ Server → Show logs**.

---

## 7. Updating an installation

```bash
cd WebDAQ
git pull
git submodule update --init --recursive
conda activate luna
pip install server/native/caendaq     # only if the submodule moved
cd frontend && npm run build
LunaDAQ restart
```

The database schema is brought up to date every time the server starts, so there
is nothing to migrate by hand. `migrations/` is part of the repository — do not
delete it, and do not run `flask db init`; that is how a schema history gets
thrown away.

---

## 8. If the installation itself fails

| Symptom | Usual cause |
|---|---|
| `caendaq` cannot be imported | The module was built into a different environment. `conda activate luna`, then `pip install server/native/caendaq`. |
| `No module named flask` when running the tests | The same thing, from the other direction: the shell is not in the `luna` environment. |
| Port 5001 or 3000 is in use | `LunaDAQ status` names what holds it; `LunaDAQ stop` clears our own leftovers. A port held by an unrelated program is reported, not killed. |
| The interface loads but every request fails | `NEXT_PUBLIC_API_URL` points somewhere the browser cannot reach, or the frontend was not rebuilt after it changed. |
| The boards are listed but never connect | The CAEN libraries are missing, or another process still holds the links — including a WebDAQ backend that did not exit. |

[Troubleshooting](troubleshooting.md) covers what to do once it is installed and
something stops working during a shift.
