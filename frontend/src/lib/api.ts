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

// Functions for XDAQ configuration

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
// Get ROI histograms
export const getRoiHistogram = (boardId: string, channel: string, roiMin: number, roiMax: number) =>
    api.get(`/histograms/${boardId}/${channel}/${roiMin}/${roiMax}`).then(res => res.data);
// Get ROI histograms
export const getRoiIntegral = (boardId: string, channel: string, roiMin: number, roiMax: number) =>
    api.get(`/roi/${boardId}/${channel}/${roiMin}/${roiMax}`).then(res => res.data);
// XDAQ functions
export const getFileBandwidth = () =>
    api.get('/experiment/xdaq/file_bandwidth').then(res => res.data);

// Reset
export const reset = () =>
    api.post('/experiment/xdaq/reset').then(res => res.data);
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

// Get boards JSON
export const getSetting = (id: string, setting: string) =>
    api.get(`/digitizer/${id}/${setting}`).then(res => res.data);

export const setSetting = (id: string, setting: string, value: string) =>
    api.get(`/digitizer/${id}/${setting}/${value}`);

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

// Stats/Graphite path management APIs
export const getStatsPaths = () =>
    api.get('/stats/paths').then(res => res.data);

export const addStatsPath = (path: string, alias?: string) =>
    api.post('/stats/paths', { path, alias }).then(res => res.data);

export const removeStatsPath = (path: string) =>
    api.delete(`/stats/paths/${path}`).then(res => res.data);

export const updateStatsPath = (path: string, alias?: string, enabled?: boolean) =>
    api.put(`/stats/paths/${path}`, { alias, enabled }).then(res => res.data);

export const getStatsMetricLastValue = (metric: string, from: string = '-10s') =>
    api.get(`/stats/metric/${metric}/last`, { params: { from } }).then(res => res.data);

export const startStatsRun = (runNumber: number) =>
    api.post(`/stats/run/${runNumber}/start`).then(res => res.data);

export const stopStatsRun = () =>
    api.post('/stats/run/stop').then(res => res.data);

export const getStatsRunStatus = () =>
    api.get('/stats/run/status').then(res => res.data);

export default api;