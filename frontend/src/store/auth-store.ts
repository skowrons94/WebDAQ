import { create } from 'zustand';

type AuthState = {
    token: string | null;
    setToken: (token: string) => void;
    clearToken: () => void;
};

const useAuthStore = create<AuthState>((set) => ({
    token: typeof window !== 'undefined' ? localStorage.getItem('authToken') || null : null,
    setToken: (token: string) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('authToken', token);
        }
        set({ token });
    },
    clearToken: () => {
        if (typeof window !== 'undefined') {
            localStorage.removeItem('authToken');
        }
        set({ token: null });
    },
}));

export default useAuthStore;