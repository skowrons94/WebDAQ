import create from 'zustand';

interface RunControlState {
  isRunning: boolean;
  startTime: string | null;
  setIsRunning: (isRunning: boolean) => void;
  setStartTime: (startTime: string | null) => void;
}

const useRunControlStore = create<RunControlState>((set) => ({
  isRunning: false,
  startTime: null,
  setIsRunning: (isRunning) => set({ isRunning }),
  setStartTime: (startTime) => set({ startTime }),
}));

export default useRunControlStore;