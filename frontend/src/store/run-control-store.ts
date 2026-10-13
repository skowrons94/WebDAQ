import { create } from 'zustand';

/**
 * The run state the whole app reads: header, run bar, dashboard, /alerts, the
 * beam panel, the Tuner, the spectra pages. It is filled by ONE poller
 * (hooks/use-run-status.ts), so two screens can no longer disagree about
 * whether a run is going.
 *
 * `known` stays false until the server has answered once: until then nothing
 * may claim "Stopped".
 */
export interface RunControlState {
  known: boolean;
  isRunning: boolean;
  startTime: string | null;
  runNumber: number | null;
  /** A board reported a FAIL aggregate during this run. */
  boardError: boolean;
  /** Sum of every channel's event rate (Hz), while running; null otherwise. */
  totalRate: number | null;
  /** The last poll could not reach the server. */
  unreachable: boolean;
  /** A Stop failed while the run still shows as going: Force reset is offered
   *  (dashboard Run control and the phone run bar). Cleared when it stops. */
  stopFailed: boolean;
  setIsRunning: (isRunning: boolean) => void;
  setStartTime: (startTime: string | null) => void;
  setRunNumber: (runNumber: number | null) => void;
  update: (patch: Partial<Omit<RunControlState, 'setIsRunning' | 'setStartTime' | 'setRunNumber' | 'update'>>) => void;
}

const useRunControlStore = create<RunControlState>((set) => ({
  known: false,
  isRunning: false,
  startTime: null,
  runNumber: null,
  boardError: false,
  totalRate: null,
  unreachable: false,
  stopFailed: false,
  setIsRunning: (isRunning) => set({ isRunning, known: true }),
  setStartTime: (startTime) => set({ startTime }),
  setRunNumber: (runNumber) => set({ runNumber }),
  update: (patch) => set(patch),
}));

export default useRunControlStore;
