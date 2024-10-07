import { create } from 'zustand';

type AuthState = {
    token: string | null;
    setToken: (token: string) => void;
    clearToken: () => void;
};

const useAuthStore = create<AuthState>((set) => ({
    token: null,
    setToken: (token) => set({ token }),
    clearToken: () => set({ token: null }),
}));

export default useAuthStore;