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

export default api;