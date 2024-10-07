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

export const startRun = () => api.post('/start_run');

export const stopRun = () => api.post('/stop_run');

export const addNote = (runNumber: number, note: string) =>
    api.post('/experiment/add_note', { run_number: runNumber, note });

export const getRunMetadata = (runNumber: number) =>
    api.get(`/experiment/get_run_metadata?run_number=${runNumber}`);

export default api;