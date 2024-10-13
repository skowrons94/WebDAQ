import { create } from 'zustand';

type AuthState = {
    token: string | null;
    setToken: (token: string) => void;
    clearToken: () => void;
};

const useAuthStore = create<AuthState>((set) => ({
    token: localStorage.getItem('authToken'),
    setToken: (token: string) => {
        localStorage.setItem('authToken', token);
        set({ token });
    },
    clearToken: () => {
        localStorage.removeItem('authToken');
        set({ token: null });
    },
}));

export default useAuthStore;