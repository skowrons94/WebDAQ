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

export const startRun = () => api.post('/experiment/start_run');

export const stopRun = () => api.post('/experiment/stop_run');

export const addNote = (runNumber: number, note: string) =>
    api.post('/experiment/add_note', { run_number: runNumber, note });

export const getRunMetadata = (runNumber: number) =>
    api.get(`/experiment/get_run_metadata?run_number=${runNumber}`);

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

    // Start data acquisition
    export const startAcquisitionCurrent = () =>
        api.post('/start_acquisition').then(res => res.data);
  
  // Stop data acquisition
    export const stopAcquisitionCurrent = () =>
        api.post('/stop_acquisition').then(res => res.data);
  
    // Get all buffered data
    export const getAllDataCurrent = () =>
        api.get('/get_data').then(res => res.data);
  
    // Get the latest data point
    export const getLatestDataCurrent = () =>
        api.get('/get_latest_data').then(res => res.data);
    
    // Set a controller setting
    export const setSettingCurrent = (setting: string, value: string) =>
        api.post('/set_setting', { setting, value }).then(res => res.data);
    
    // Get a controller setting
    export const getSettingCurrent = (setting: string) =>
        api.get('/get_setting', { params: { setting } }).then(res => res.data);
    
    // Reset the controller
    export const resetControllerCurrent = () =>
        api.post('/reset').then(res => res.data);
  
  // Set save data option
    export const setSaveDataCurrent = (saveData: boolean, saveFolder: string = '') =>
        api.post('/set_save_data', { save_data: saveData, save_folder: saveFolder }).then(res => res.data);

    export const getSaveDataCurrent = () =>
        api.get('/get_save_data').then(res => res.data);

    // Set number of channels
    export const setChannelsCurrent = (numChannels: number) =>
        api.post('/current/set_channels', { n_channels: numChannels }).then(res => res.data);

    export const getChannelsCurrent = () =>
        api.get('/current/get_channels').then(res => res.data);

    // Set range
    export const setRngCurrent = (rng: string) =>
        api.post('/current/set_rng', { rng }).then(res => res.data);

    export const getRngCurrent = () =>
        api.get('/current/get_rng').then(res => res.data);

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


export default api;