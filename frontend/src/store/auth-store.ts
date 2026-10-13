import { create } from 'zustand';

type AuthState = {
    token: string | null;
    /** localStorage has been read (in the browser, after the first render). */
    hydrated: boolean;
    setToken: (token: string) => void;
    clearToken: () => void;
    /** Read the saved token. Called by AuthGate after hydration. */
    hydrate: () => void;
};

// The token starts as null on the server AND in the browser, so the first
// client render matches the static HTML (reading localStorage here, at module
// load, made every signed-in page render differently from its HTML: React
// errors #418/#423 on each full load). AuthGate reads it once mounted.
const readSaved = (): string | null => {
    try {
        return typeof window !== 'undefined' ? localStorage.getItem('authToken') : null;
    } catch {
        return null;
    }
};

const useAuthStore = create<AuthState>((set) => ({
    token: null,
    hydrated: false,
    setToken: (token: string) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('authToken', token);
        }
        set({ token, hydrated: true });
    },
    clearToken: () => {
        if (typeof window !== 'undefined') {
            localStorage.removeItem('authToken');
        }
        set({ token: null, hydrated: true });
    },
    hydrate: () => set({ token: readSaved(), hydrated: true }),
}));

/** The token for a request: the store's, or the saved one before hydration. */
export const currentToken = (): string | null => {
    const { token, hydrated } = useAuthStore.getState();
    return hydrated ? token : readSaved();
};

export default useAuthStore;
