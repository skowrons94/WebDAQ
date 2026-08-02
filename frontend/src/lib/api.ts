import axios from 'axios';
import useAuthStore from '@/store/auth-store';

const api = axios.create({
    baseURL: process.env.NEXT_PUBLIC_API_URL,
});

console.log('API base URL:', process.env.NEXT_PUBLIC_API_URL);

api.interceptors.request.use((config) => {
    const token = useAuthStore.getState().token;
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// A token is good for seven days, so an unusually long session can still expire.
// Every polling component then starts getting 401s, and because most of them
// swallow their errors to survive a brief server hiccup, the page just stops
// updating — it looks like the DAQ has died. Catch it centrally: drop the dead
// token and send the browser to the login page, saying why.
api.interceptors.response.use(
    (response) => response,
    (error) => {
        const status = error?.response?.status;
        const url: string = error?.config?.url ?? '';
        // /login answers 401 for wrong credentials; that is the login form's
        // business, not an expired session.
        const isCredentialsCall = url.includes('/login') || url.includes('/register');
        // flask-jwt-extended: 401 for missing/expired, 422 for a malformed token.
        const isSessionGone = status === 401 || status === 422;

        if (isSessionGone && !isCredentialsCall && typeof window !== 'undefined') {
            const alreadyLeaving = window.location.pathname.startsWith('/auth/login');
            if (!alreadyLeaving) {
                useAuthStore.getState().clearToken();
                const here = window.location.pathname + window.location.search;
                window.location.href =
                    `/auth/login?expired=1&next=${encodeURIComponent(here)}`;
            }
        }
        return Promise.reject(error);
    },
);

export const login = (username: string, password: string) =>
    api.post('/login', { username, password });

export const register = (username: string, email: string, password: string) =>
    api.post('/register', { username, email, password });

export const startRun = () => 
    api.post('/experiment/start_run');

export const stopRun = () => 
    api.post('/experiment/stop_run');

export const addNote = (runNumber: number, note: string) =>
    api.post('/experiment/add_note', { run_number: runNumber, note });

export const addRunMetadata = (runNumber: number, targetName: string, terminalVoltage: string, probeVoltage: string, runType: string) =>
    api.post('/experiment/add_run_metadata', {
        run_number: runNumber,
        target_name: targetName,
        terminal_voltage: Number(terminalVoltage),
        probe_voltage: Number(probeVoltage),
        run_type: runType
    });

export const getRunMetadata = (runNumber: number) =>
    api.get(`/experiment/get_run_metadata/${runNumber}`);

export const getRunMetadataAll = () =>
    api.get('/experiment/get_run_metadata');

export const updateRunFlag = (runNumber: number, flag: string) =>
    api.post('/experiment/update_run_flag', { run_number: runNumber, flag });

export const updateRunNotes = (runNumber: number, notes: string) =>
    api.post('/experiment/update_run_notes', { run_number: runNumber, notes });

// Functions for board management
export const getBoardConfiguration = () =>
    api.get('/experiment/get_board_configuration');

export const addBoard = (boardData: any) =>
    api.post('/experiment/add_board', boardData);

export const removeBoard = (boardId: string) =>
    api.post('/experiment/remove_board', { id: boardId });

// ── Multi-board synchronisation ──────────────────────────────────────────────
// There is no separate sync setting: whether a board joins the chain is decided
// by its own Acquisition Control register (0x8100), edited in the CAEN
// dashboard. This endpoint reads those registers back and reports the resulting
// chain. To CHANGE it, write reg_8100 with setSetting().

/** Acquisition Control (0x8100) bits[1:0] — Start/Stop Mode Selection. */
export const START_MODE_SW = 0
export const START_MODE_SIN_GPI = 1
export const START_MODE_FIRST_TRIGGER = 2
export const START_MODE_LVDS = 3

export interface SyncChainEntry {
    board_id: string | number
    name: string
    /** 0x8100[1:0] as configured. */
    start_mode: number
    start_mode_name: string
    /** True when the board waits for an external start (i.e. is in the chain). */
    synchronised: boolean
    /** 0x8100[6]: 0 = internal 50 MHz oscillator, 1 = external CLK-IN. */
    clock_source: number
    /** The whole 0x8100 register, so edits are read-modify-write. */
    acquisition_control: number
    /** 0x811C[17:16]: 0 = Trigger (per 0x8110), 3 = S-IN propagation, ... */
    trg_out_mode: number
    front_panel_io_control: number
    /** 0x8110[31]: software trigger reaches TRG-OUT (the master needs this). */
    sw_trigger_to_trg_out: number
    /** 0x8110[30]: TRG-IN reaches TRG-OUT (needed to forward down the chain). */
    ext_trigger_to_trg_out: number
    trg_out_mask: number
    role: 'master' | 'slave' | 'independent'
    /** Reasons this board's start signal would not propagate; empty when fine. */
    problems: string[]
}

export interface SyncSettings {
    mode: 'daisy-chain' | 'independent'
    chain: SyncChainEntry[]
    synchronised_count: number
    /** False when there is only one board — nothing to chain. */
    applicable: boolean
    /** The register the dashboard edits to change any of this. */
    register: string
}

export const getSyncSettings = (): Promise<SyncSettings> =>
    api.get('/experiment/get_sync_settings').then(res => res.data);

// ── Board identity / provenance ──────────────────────────────────────────────

export interface CaenBoardInfo {
    board_id: string
    board_index: number
    model_name: string
    model: number
    family_code: number
    form_factor: number
    channels: number
    adc_bits: number
    serial_number: number
    pcb_revision: number
    board_reg_id: number
    dpp_type: string
    dpp_code: number
    ns_per_sample: number
    ns_per_timetag: number
    roc_firmware: string
    amc_firmware: string
    license: string
    channel_enable_mask: number
    acquisition_control: number
    board_configuration: number
    front_panel_io_control: number
    global_trigger_mask: number
    trg_out_enable_mask: number
    run_delay: number
    /** Acquisition Control (0x8100) bits[1:0], as read back from the board. */
    start_mode: number
    start_mode_name: string
    sync_role: 'master' | 'slave' | 'independent'
    conn_type: number
    link_num: number
    node: number
    vme_base: number
    configured_name?: string
    configured_dpp?: string
    link_type?: string
}

export interface SoftwareVersions {
    webdaq: string
    python: string
    platform: string
    caendaq: string | null
    caendaq_has_caen: boolean | null
    acquisition_mode: string
}

export interface BoardInfoResponse {
    boards: CaenBoardInfo[]
    software: SoftwareVersions
    sync_mode: string
    running: boolean
}

/** Live board identity + acquisition registers. `boards` is only populated
 *  while a run is configured (that is when the digitizers are open). */
export const getBoardInfo = (): Promise<BoardInfoResponse> =>
    api.get('/experiment/board_info').then(res => res.data);

// ── Logbook run details ──────────────────────────────────────────────────────
// Read-side access to what a finished run left behind — its record, the beam
// current it was taken with, the boards' configuration, and the ROOT conversion.

export interface RunSummary {
    run_number: number
    start_time: string | null
    end_time: string | null
    duration_s: number | null
    run_type: string | null
    target_name: string | null
    terminal_voltage: number | null
    accumulated_charge: number | null
    flag: string
    notes: string | null
    sync_mode: string | null
    has_data: boolean
    has_current: boolean
    converted: boolean
    n_data_files: number
    total_bytes: number
    /** False while a run is still in progress (no end time yet). */
    complete: boolean
}

export interface RunFileEntry { name: string; bytes: number }

export interface RunFiles {
    data: RunFileEntry[]
    board_config: RunFileEntry[]
    root: RunFileEntry[]
    current: RunFileEntry | null
    metadata: RunFileEntry | null
    total_bytes: number
}

export interface BoardConfigDump {
    file: string
    board: Record<string, string>
    n_registers: number
    registers: Record<string, {
        name: string; channel: number; address: string; value: string
    }>
}

export interface RunDetail extends RunSummary {
    probe_voltage: number | null
    user_id: number | null
    board_info: CaenBoardInfo[]
    software_versions: Partial<SoftwareVersions>
    files: RunFiles
    directory: string
    board_configs: BoardConfigDump[]
}

export interface ChargeChannel {
    name: string
    charge_uC: number
    charge_nC: number
    charge_mC: number
    mean_current_uA: number
}

export interface CurrentData {
    available: boolean
    start_time: string | null
    columns: string[]
    /** [time, ch0, ch1, ...] per row, downsampled for plotting. */
    samples: number[][]
    n_samples: number
    downsampled: boolean
    integration: {
        channels: ChargeChannel[]
        duration_s: number
        method?: string
        note?: string
    } | null
}

export interface ConversionStatus {
    state: 'idle' | 'running' | 'done' | 'failed'
    outputs: string[]
    converted: boolean
    binary: string | null
    capabilities: {
        ts_unit: boolean
        compression: boolean
        ignore_fail: boolean
        header_boards: boolean
        algo: boolean
        buffer: boolean
        wave: boolean
        force_dual_trace: boolean
        ignore_psd_boards: boolean
        verbose: boolean
    }
    returncode?: number | null
    log?: string[]
    message?: string
    started_at?: number
    finished_at?: number
}

export const getRuns = (): Promise<{ runs: RunSummary[]; rureader_available: boolean }> =>
    api.get('/data/runs').then(res => res.data);

export const getRunDetail = (runNumber: number): Promise<RunDetail> =>
    api.get(`/data/runs/${runNumber}`).then(res => res.data);

export const getRunCurrent = (runNumber: number, maxPoints = 2000): Promise<CurrentData> =>
    api.get(`/data/runs/${runNumber}/current`, { params: { max_points: maxPoints } })
        .then(res => res.data);

export const getConversionStatus = (runNumber: number): Promise<ConversionStatus> =>
    api.get(`/data/runs/${runNumber}/convert`).then(res => res.data);

// Mirrors the RUReader command line; the server drops anything the installed
// binary does not advertise, and says so in the conversion log.
export interface ConversionOptions {
    ts_unit?: string                        // -t: ps | ns | us | ms | s | raw
    algo?: string                           // -a: zlib | lzma | lz4 | zstd
    compression?: number                    // -c: 0-9
    buffer_mb?: number                      // -b: 1-1024
    wave_select?: Record<string, number>    // -w: board id -> wave 1 or 2
    force_dual_trace?: boolean              // --force-dual-trace
    ignore_psd_boards?: boolean             // --ignore-psd-boards
    verbose?: boolean                       // -v
}

export const startConversion = (runNumber: number, options: ConversionOptions = {}) =>
    api.post(`/data/runs/${runNumber}/convert`, options).then(res => res.data);

// Acquisition status / control

export const getSaveData = () => 
    api.get('/experiment/get_save_data').then(res => res.data);
export const setSaveData = (value: boolean) => 
    api.post('/experiment/set_save_data', { value: value });

export const getLimitDataSize = () => 
    api.get('/experiment/get_limit_data_size').then(res => res.data);
export const setLimitDataSize = (value: boolean) => 
    api.post('/experiment/set_limit_data_size', { value: value });

export const getDataSizeLimit = () => 
    api.get('/experiment/get_data_size_limit').then(res => res.data);
export const setDataSizeLimit = (value: number) => 
    api.post('/experiment/set_data_size_limit', { value: value });

// DAQ State
export const getCurrentRunNumber = () => 
    api.get('/experiment/get_run_number').then(res => res.data);

export const setRunNumber = (value: number) =>
    api.post('/experiment/set_run_number', { value: value });

export const checkRunDirectoryExists = ( ) => 
    api.get(`/experiment/check_run_directory`).then(res => res.data);

export const getRunStatus = () =>
    api.get('/experiment/get_run_status').then(res => res.data);

export const getStartTime = () => 
    api.get('/experiment/get_start_time').then(res => res.data);

    // Graphite-related functions
export const getTerminalVoltage = (from: string = '-10s', until: string = 'now') =>
    api.get('/stats/terminal_voltage', { params: { from, until } }).then(res => res.data);
  
export const getExtractionVoltage = (from: string = '-10s', until: string = 'now') =>
    api.get('/stats/extraction_voltage', { params: { from, until } }).then(res => res.data);
  
export const getColumnCurrent = (from: string = '-10s', until: string = 'now') =>
    api.get('/stats/column_current', { params: { from, until } }).then(res => res.data);

export const getBoardRates = (boardId: string, boardName: string, channel: string, from: string = '-10s', until: string = 'now') =>
    api.get('/stats/board_rates', { params: { board_id: boardId, board_name: boardName, channel, from, until } }).then(res => res.data);
export const getBoardRatesP = (boardId: string, boardName: string, channel: string, from: string = '-10s', until: string = 'now') =>
    api.get('/stats/board_rates_pu', { params: { board_id: boardId, board_name: boardName, channel, from, until } }).then(res => res.data);
export const getBoardRatesL = (boardId: string, boardName: string, channel: string, from: string = '-10s', until: string = 'now') =>
    api.get('/stats/board_rates_lost', { params: { board_id: boardId, board_name: boardName, channel, from, until } }).then(res => res.data);
export const getBoardRatesS = (boardId: string, boardName: string, channel: string, from: string = '-10s', until: string = 'now') =>
    api.get('/stats/board_rates_satu', { params: { board_id: boardId, board_name: boardName, channel, from, until } }).then(res => res.data);
export const getBoardRatesD = (boardId: string, boardName: string, channel: string, from: string = '-10s', until: string = 'now') =>
    api.get('/stats/board_rates_dt', { params: { board_id: boardId, board_name: boardName, channel, from, until } }).then(res => res.data);

export const getRebinFactor = () =>
    api.get(`/histograms/rebin`).then(res => res.data);
export const setRebinFactor = (factor: number) =>
    api.post(`/histograms/rebin`, { factor }).then(res => res.data);

// Get the histograms for a given board_id and channel
export const getHistogram = (boardId: string, channel: string) =>
    api.get(`/histograms/${boardId}/${channel}`).then(res => res.data);
export const getWaveform1 = (boardId: string, channel: string) =>
    api.get(`/waveforms/1/${boardId}/${channel}`).then(res => res.data);
export const getWaveform2 = (boardId: string, channel: string) =>
    api.get(`/waveforms/2/${boardId}/${channel}`).then(res => res.data);
export const getProbe1 = (boardId: string, channel: string) =>
    api.get(`/waveforms/probe1/${boardId}/${channel}`).then(res => res.data);
export const getProbe2 = (boardId: string, channel: string) =>
    api.get(`/waveforms/probe2/${boardId}/${channel}`).then(res => res.data);
// Get the histograms for a given board_id and channel
export const getQlong = (boardId: string, channel: string) =>
    api.get(`/qlong/${boardId}/${channel}`).then(res => res.data);
// Get the histograms for a given board_id and channel
export const getQshort = (boardId: string, channel: string) =>
    api.get(`/qshort/${boardId}/${channel}`).then(res => res.data);
// Get the histograms for a given board_id and channel
export const getPsd = (boardId: string, channel: string) =>
    api.get(`/psd/${boardId}/${channel}`).then(res => res.data);
// Waveform control
export const activateWaveform = () =>
    api.post('/waveforms/activate').then(res => res.data);
export const deactivateWaveform = () =>
    api.post('/waveforms/deactivate').then(res => res.data);
export const getWaveformStatus = () =>
    api.get('/waveforms/status').then(res => res.data);
// Per-board waveform control
export const activateWaveformBoard = (boardId: string) =>
    api.post(`/waveforms/activate/${boardId}`).then(res => res.data);
export const deactivateWaveformBoard = (boardId: string) =>
    api.post(`/waveforms/deactivate/${boardId}`).then(res => res.data);
export const getWaveformStatusPerBoard = (): Promise<{ [boardId: string]: boolean }> =>
    api.get('/waveforms/status_per_board').then(res => res.data);
// Get ROI histograms
export const getRoiHistogram = (boardId: string, channel: string, roiMin: number, roiMax: number) =>
    api.get(`/histograms/${boardId}/${channel}/${roiMin}/${roiMax}`).then(res => res.data);
// Get ROI histograms
export const getRoiIntegral = (boardId: string, channel: string, roiMin: number, roiMax: number) =>
    api.get(`/roi/${boardId}/${channel}/${roiMin}/${roiMax}`).then(res => res.data);
// Acquisition file write bandwidth (MB/s), from caendaq statistics
export const getFileBandwidth = () =>
    api.get('/experiment/file_bandwidth').then(res => res.data);

// Live per-board / per-channel run statistics (rates) from caendaq
export const getExperimentStats = () =>
    api.get('/experiment/stats').then(res => res.data);

// Reset the acquisition
export const reset = () =>
    api.post('/experiment/reset').then(res => res.data);
// Calibration
export const getCalib = (boardName: string, boardId: string, channel: string) =>
    api.get(`/calib/get/${boardName}/${boardId}/${channel}`);

export const setCalib = (boardName: string, boardId: string, channel: string, a: string, b: string) =>
    api.post(`/calib/set/${boardName}/${boardId}/${channel}`, { board_name: boardName, board_id: boardId, channel, a, b });

// Current reading APIs
export const startAcquisitionCurrent = (runNumber: string) =>
    api.get(`/current/start/${runNumber}`);
export const stopAcquisitionCurrent = () =>
    api.post('/current/stop');
export const setSettingCurrent = (setting: string, value: string) =>
    api.get(`/current/set/${setting}/${value}`);
export const getSettingCurrent = (setting: string) =>
    api.get(`/current/get/${setting}`);
export const resetDeviceCurrent = () =>
    api.post('/current/reset');
export const getDataCurrent = () =>
    api.get('/current/data').then(res => res.data);
export const getDataCollimator1 = () =>
    api.get('/current/collimator/1').then(res => res.data);
export const getDataCollimator2 = () =>
    api.get('/current/collimator/2').then(res => res.data);
export const getArrayDataCurrent = () =>
    api.get('/current/data_array').then(res => res.data);
export interface LiveCurrentHistory {
    /** [Unix timestamp in seconds, current in µA]. */
    samples: [number, number][]
    sampled_at: number
    sample_interval_s: number | null
    channel: number
    source: "controller-buffer" | "run-log"
}
export const getCurrentHistory = (params: {
    seconds?: number
    since?: number
    maxPoints?: number
}): Promise<LiveCurrentHistory> =>
    api.get('/current/history', {
        params: {
            seconds: params.seconds,
            since: params.since,
            max_points: params.maxPoints,
        },
    }).then(res => res.data);
export const getAccumulatedCharge = () =>
    api.get('/current/accumulated').then(res => res.data);
export const getTotalAccumulatedCharge = () =>
    api.get('/current/total_accumulated').then(res => res.data);
export const resetTotalAccumulatedCharge = () =>
    api.post('/current/reset_total_accumulated');
export const setIpPortCurrent = (ip: string, port: string) =>
    api.get(`/current/set_ip_port/${ip}/${port}`);
export const getIpCurrent = () =>
    api.get('/current/get_ip').then(res => res.data);
export const getPortCurrent = () =>
    api.get('/current/get_port').then(res => res.data);
export const connectCurrent = () =>
    api.get('/current/connect');
export const getConnectedCurrent = () =>
    api.get('/current/is_connected').then(res => res.data);

// Current module management APIs
export const getCurrentModuleType = () =>
    api.get('/current/module_type').then(res => res.data);
export const setCurrentModuleType = (moduleType: string) =>
    api.post('/current/module_type', { module_type: moduleType });
export const getCurrentModuleSettings = () =>
    api.get('/current/module_settings').then(res => res.data);
export const updateCurrentModuleSettings = (settings: any) =>
    api.post('/current/module_settings', settings);
export const getCurrentStatus = () =>
    api.get('/current/status').then(res => res.data);

// List serial ports detected on the DAQ host (for the RBD 9103 port picker)
export const getSerialPorts = () =>
    api.get('/current/serial_ports').then(res => res.data);

// Get boards JSON
export const getSetting = (id: string, setting: string) =>
    api.get(`/digitizer/${id}/${setting}`).then(res => res.data);

export const setSetting = (id: string, setting: string, value: string) =>
    api.get(`/digitizer/${id}/${setting}/${value}`);

// ── Online tuning ───────────────────────────────────────────────────────────
// Saves the register to the board's configuration and, with `online`, writes it
// to the board as well so the change takes effect immediately. The save always
// happens; `written` says whether the board itself took it, and `reason`
// explains a refusal (a register that is not safe to move mid-acquisition, a
// disconnected board).
export type ApplySettingResult = {
    saved: boolean;
    written: boolean;
    reason: string;
    via: 'run' | 'probe' | '';
    address: string;
    value: string;
};

export const applySetting = (id: string, setting: string, value: number, online: boolean) =>
    api.post(`/digitizer/${id}/setting/${setting}`, { value, online })
        .then(res => res.data as ApplySettingResult);

// Registers this board allows to be changed while it is acquiring, as
// {"0x106C": "Trigger Threshold"}. Used to mark the fields before anything is sent.
export const getOnlineRegisters = (id: string) =>
    api.get(`/digitizer/${id}/online_registers`)
        .then(res => res.data as { dpp: string; registers: Record<string, string> });

export const updateJSON = () =>
    api.get(`/digitizer/update`);

export const getPolarity = (id: string, channel: string) =>
    api.get(`/digitizer/polarity/${id}/${channel}`).then(res => res.data);

export const setPolarity = (id: string, channel: string, value: string) =>
    api.get(`/digitizer/polarity/${id}/${channel}/${value}`);

export const getChannelEnabled = (id: string, channel: string) =>
    api.get(`/digitizer/channel/${id}/${channel}`).then(res => res.data);

export const setChannelEnabled = (id: string, channel: string, value: string) =>
    api.get(`/digitizer/channel/${id}/${channel}/${value}`);

export const getBoardSettings = (id: string) =>
    api.get(`/digitizer/${id}/registers`).then(res => res.data);

export const getBoardConnectivity = () =>
    api.get('/digitizer/connectivity').then(res => res.data);

// ── Board discovery ─────────────────────────────────────────────────────────
// The server probes the links (as CoMPASS does) and reports what is plugged in.
// Scanning runs in the background because a full sweep is hundreds of probes:
// start it, then poll the status until it is no longer 'running'.
export type ScanOptions = {
    usb: { enabled: boolean; links: number };
    optical: { enabled: boolean; links: number; nodes: number };
    a4818: { enabled: boolean; pids: string[]; nodes: number };
    vme: { enabled: boolean; link_type: string; link_num: string; start: string; end: string; step: string };
};

export type DiscoveredBoard = {
    model: string;
    serial: string;
    channels: number;
    adc_bits: number;
    roc_firmware: string;
    amc_firmware: string;
    dpp: string | null;
    link_type: string;
    link_num: string;
    id: number;
    vme: string;
    already_configured: boolean;
};

export type ScanStatus = {
    status: 'idle' | 'running' | 'done' | 'cancelled' | 'error';
    message: string;
    progress: { done: number; total: number };
    elapsed: number;
    eta: number | null;
    found: DiscoveredBoard[];
    errors: string[];
};

export const startBoardScan = (options: ScanOptions) =>
    api.post('/digitizer/scan', options).then(res => res.data as ScanStatus);

export const getBoardScanStatus = () =>
    api.get('/digitizer/scan').then(res => res.data as ScanStatus);

export const cancelBoardScan = () =>
    api.post('/digitizer/scan/cancel').then(res => res.data as ScanStatus);

export const getA4818Pids = () =>
    api.get('/digitizer/scan/a4818').then(res => res.data as { pids: string[] });

// Generic metric data fetching function
export const getMetricData = (entityName: string, from: string = '-10s', until: string = 'now') =>
    api.get(`/stats/${entityName}`, { params: { from, until } }).then(res => res.data);

// FC control
export const openFaraday = () =>
    api.get('/faraday/open').then(res => res.data);

export const closeFaraday = () =>
    api.get('/faraday/close').then(res => res.data);

// Board status monitoring
export const getBoardStatus = () =>
    api.get('/experiment/get_board_status').then(res => res.data);

// Refresh board connections
export const refreshBoardConnections = () =>
    api.post('/experiment/refresh_board_connections');

// Auto-restart on board failure
export const getAutoRestart = () =>
    api.get('/experiment/get_auto_restart').then(res => res.data);

export const setAutoRestart = (enabled: boolean, delay?: number) =>
    api.post('/experiment/set_auto_restart', { enabled, delay });

export const getRestartStatus = () =>
    api.get('/experiment/get_restart_status').then(res => res.data);

// Telegram notification settings
export const getTelegramSettings = () =>
    api.get('/experiment/get_telegram_settings').then(res => res.data);

export const setTelegramSettings = (settings: { enabled?: boolean; bot_token?: string; chat_id?: string }) =>
    api.post('/experiment/set_telegram_settings', settings);

export const testTelegram = () =>
    api.post('/experiment/test_telegram');

// Stats/Graphite path management APIs
export const getStatsPaths = () =>
    api.get('/stats/paths').then(res => res.data);

export const addStatsPath = (path: string, alias?: string, unit?: string) =>
    api.post('/stats/paths', { path, alias, unit }).then(res => res.data);

// Whether the Graphite server is answering, for the status light on the page.
export const getStatsConnection = () =>
    api.get('/stats/connection').then(res => res.data as {
        reachable: boolean; host: string; port: number; error: string;
    });

export const removeStatsPath = (path: string) =>
    api.delete(`/stats/paths/${path}`).then(res => res.data);

export const updateStatsPath = (path: string, alias?: string, enabled?: boolean, unit?: string) =>
    api.put(`/stats/paths/${path}`, { alias, enabled, unit }).then(res => res.data);

export const getStatsMetricLastValue = (metric: string, from: string = '-10s') =>
    api.get(`/stats/metric/${metric}/last`, { params: { from } }).then(res => res.data);

// Recent history of one metric, as [[timestamp, value], …] — used for the
// trend line on a metric card.
// `from`/`until` are Graphite offsets: seconds are "s", minutes are "min"
// (plain "m" is not a unit and the server answers 400).
export const getStatsMetricSeries = (metric: string, from: string = '-30min', until: string = 'now') =>
    api.get(`/stats/metric/${metric}`, { params: { from, until } })
        .then(res => res.data as [string, number | null][]);

// One level of the Graphite metric tree, so metrics can be picked instead of
// typed. `prefix` opens a branch; `search` matches anywhere in the tree.
export type MetricNode = { path: string; is_leaf: boolean };

export const browseMetrics = (prefix = '', search = '') =>
    api.get('/stats/browse', { params: { prefix, search } })
        .then(res => res.data as { nodes: MetricNode[]; prefix: string });

export const startStatsRun = (runNumber: number) =>
    api.post(`/stats/run/${runNumber}/start`).then(res => res.data);

export const stopStatsRun = () =>
    api.post('/stats/run/stop').then(res => res.data);

export const getStatsRunStatus = () =>
    api.get('/stats/run/status').then(res => res.data);

// Graphite server configuration APIs
export const getCurrentGraphiteConfig = () =>
    api.get('/current/graphite_config').then(res => res.data);

export const setCurrentGraphiteConfig = (graphite_host: string, graphite_port: number) =>
    api.post('/current/graphite_config', { graphite_host, graphite_port }).then(res => res.data);

export const getStatsGraphiteConfig = () =>
    api.get('/stats/graphite_config').then(res => res.data);

// graphite_prefix is the root of the metric tree caendaq publishes rates under
// and names the EXPERIMENT, not a board ('ancillary.rates.12c12c'). It is sent
// with the server so one Save covers both, and the server normalises it — use
// the graphite_prefix in the response rather than what was typed.
export const setStatsGraphiteConfig = (
    graphite_host: string, graphite_port: number, graphite_prefix?: string) =>
    api.post('/stats/graphite_config',
             { graphite_host, graphite_port,
               ...(graphite_prefix !== undefined ? { graphite_prefix } : {}) })
       .then(res => res.data);

// Rate sampling cadence. One caendaq tick samples the counters, differences
// them and pushes to Graphite, so stats_interval_ms is simultaneously the
// refresh rate, the averaging window and the Graphite resolution — it is not
// just a UI poll rate. stats_first_interval_ms paces only the opening tick of a
// run, so a long window still shows numbers a couple of seconds after Start.
export interface StatsSampling {
    stats_interval_ms: number;
    stats_first_interval_ms: number;
    min_ms: number;
    max_ms: number;
    /** What the RUNNING collector uses; null when no run is active. */
    active_interval_ms: number | null;
}

export const getStatsSampling = (): Promise<StatsSampling> =>
    api.get('/stats/sampling').then(res => res.data);

// Persisted for the next run AND applied to a live one. The server clamps, so
// use the values in the response rather than what was requested.
export const setStatsSampling = (
    stats_interval_ms?: number, stats_first_interval_ms?: number): Promise<StatsSampling> =>
    api.post('/stats/sampling',
             { ...(stats_interval_ms !== undefined ? { stats_interval_ms } : {}),
               ...(stats_first_interval_ms !== undefined ? { stats_first_interval_ms } : {}) })
       .then(res => res.data);

// ── PSI ELOG ────────────────────────────────────────────────────────────────
// The server talks to ELOG with a shared service account; entries are signed
// with the WebDAQ user's name through the Author attribute.
export type ElogEntry = {
    id: number;
    text: string;
    attributes: Record<string, string>;
    attachments: string[];
    author: string;
    subject: string;
    type: string;
    date: string;
    when: string;
    encoding: string;
    in_reply_to: string;
    reply_to: string;
};

export type ElogEntryList = {
    entries: ElogEntry[];
    total: number;
    offset: number;
    limit: number;
    has_more: boolean;
};

export type ElogSettings = {
    enabled: boolean;
    url: string;
    user: string;
    password: string;          // masked by the server, never the real one
    default_attributes: Record<string, string>;
    configured: boolean;
    available: boolean;        // whether py_elog is installed on the server
    default_author?: string;
};

export const getElogSettings = () =>
    api.get('/elog/settings').then(res => res.data as ElogSettings);

export const setElogSettings = (settings: {
    enabled?: boolean; url?: string; user?: string; password?: string;
    default_attributes?: Record<string, string>;
}) => api.post('/elog/settings', settings).then(res => res.data);

export const testElogConnection = () =>
    api.post('/elog/test').then(res => res.data as { success: boolean; message: string });

export const getElogEntries = (params: { limit?: number; offset?: number; search?: string } = {}) =>
    api.get('/elog/entries', { params }).then(res => res.data as ElogEntryList);

export const getElogEntry = (id: number) =>
    api.get(`/elog/entries/${id}`).then(res => res.data as ElogEntry);

export const getElogAttributes = () =>
    api.get('/elog/attributes').then(res => res.data as {
        names: string[]; defaults: Record<string, string>; author: string;
    });

export const postElogEntry = (entry: {
    text: string;
    attributes: Record<string, string>;
    reply_to?: number | null;
    encoding?: string;
}, files: File[] = []) => {
    if (files.length === 0) {
        return api.post('/elog/entries', entry).then(res => res.data as { id: number; message: string });
    }
    // With attachments the attributes travel as a JSON field beside the files.
    const form = new FormData();
    form.append('text', entry.text);
    form.append('attributes', JSON.stringify(entry.attributes));
    if (entry.reply_to) form.append('reply_to', String(entry.reply_to));
    if (entry.encoding) form.append('encoding', entry.encoding);
    files.forEach(file => form.append('attachments', file));
    return api.post('/elog/entries', form).then(res => res.data as { id: number; message: string });
};

// Attachments are proxied: the browser holds a WebDAQ token, not an ELOG session.
export const getElogAttachment = (url: string) =>
    api.get('/elog/attachment', { params: { url }, responseType: 'blob' })
        .then(res => res.data as Blob);

export default api;
