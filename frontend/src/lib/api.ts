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

export const getRunMetadata = (runNumber: number) =>
    api.get(`/experiment/get_run_metadata/${runNumber}`);

export const getRunMetadataAll = () =>
    api.get('/experiment/get_run_metadata');

// Functions for board management
export const getBoardConfiguration = () =>
    api.get('/experiment/get_board_configuration');

export const addBoard = (boardData: any) =>
    api.post('/experiment/add_board', boardData);

export const removeBoard = (boardId: string) =>
    api.post('/experiment/remove_board', { id: boardId });

// Functions for XDAQ configuration

export const getCoincidenceWindow = () => 
    api.get('/experiment/get_coincidence_window').then(res => res.data);
export const setCoincidenceWindow = (value: number) => 
    api.post('/experiment/set_coincidence_window', { value: value });

export const getMultiplicity = () => 
    api.get('/experiment/get_multiplicity').then(res => res.data);
export const setMultiplicity = (value: number) => 
    api.post('/experiment/set_multiplicity', { value: value });

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

// Functions for logbook management
export const getCSV = () => 
    api.get('/experiment/get_csv').then(res => res.data);
export const saveCSV = (csvData: string[][]) =>
    api.post('/experiment/save_csv', { csvData });

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

export const getOutputBandwidth = () =>
    api.get('/experiment/xdaq/output_bandwidth').then(res => res.data);
// Reset
export const reset = () =>
    api.post('/experiment/xdaq/reset').then(res => res.data);
// Calibration
export const getCalib = (boardName: string, boardId: string, channel: string) =>
    api.get(`/calib/get/${boardName}/${boardId}/${channel}`);

export const setCalib = (boardName: string, boardId: string, channel: string, a: string, b: string) =>
    api.post(`/calib/set/${boardName}/${boardId}/${channel}`, { board_name: boardName, board_id: boardId, channel, a, b });
// Get the histograms for a given board_id and channel
export const getAntiHistogram = (boardId: string, channel: string) =>
    api.get(`/histograms/anti/${boardId}/${channel}`).then(res => res.data);
// Get the histograms for a given board_id and channel
export const getAntiQlong = (boardId: string, channel: string) =>
    api.get(`/qlong/anti/${boardId}/${channel}`).then(res => res.data);
// Get the histograms for a given board_id and channel
export const getAntiQshort = (boardId: string, channel: string) =>
    api.get(`/qshort/anti/${boardId}/${channel}`).then(res => res.data);
// Get the histograms for a given board_id and channel
export const getCoincHistogram = (boardId: string) =>
    api.get(`/histograms/coin/${boardId}`).then(res => res.data);
// Get the histograms for a given board_id and channel
 export const getCoincQlong = (boardId: string) =>
    api.get(`/qlong/coin/${boardId}`).then(res => res.data);
// Get the histograms for a given board_id and channel
export const getCoincQshort = (boardId: string) =>
    api.get(`/qshort/coin/${boardId}`).then(res => res.data);
// Get ROI histograms
export const getRoiIntegralCoinc = (boardId: string, roiMin: number, roiMax: number) =>
    api.get(`/roi/coinc/${boardId}/${roiMin}/${roiMax}`).then(res => res.data);
// Get ROI histograms
export const getRoiIntegralAnti = (boardId: string, channel: string, roiMin: number, roiMax: number) =>
    api.get(`/roi/anti/${boardId}/${channel}/${roiMin}/${roiMax}`).then(res => res.data);
// Get ROI histograms
export const getRoiHistogramSum = (boardId: string, roiMin: number, roiMax: number) =>
    api.get(`/histograms/sum/${boardId}/${roiMin}/${roiMax}`).then(res => res.data);
// Get ROI histograms
export const getRoiHistogramAnti = (boardId: string, channel: string, roiMin: number, roiMax: number) =>
    api.get(`/histograms/anti/${boardId}/${channel}/${roiMin}/${roiMax}`).then(res => res.data);

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
export const getAccumulatedCharge = () =>
    api.get('/current/accumulated').then(res => res.data);

// Get boards JSON
export const getSetting = (id: string, setting: string) =>
    api.get(`/experiment/boards/${id}/${setting}`).then(res => res.data);

export const setSetting = (id: string, setting: string, value: string) =>
    api.get(`/experiment/boards/${id}/${setting}/${value}`);

// Generic metric data fetching function
export const getMetricData = (entityName: string, metricName: string, from: string = '-10s', until: string = 'now') =>
    api.get(`/stats/${entityName}/${metricName}`, { params: { from, until } }).then(res => res.data);

export default api;