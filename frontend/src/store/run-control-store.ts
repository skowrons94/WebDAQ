import { create } from 'zustand';
import { tunerOwnsRun } from '@/lib/tuner-save';

/**
 * The run state the whole app reads: header, run bar, dashboard, /alerts, the
 * beam panel, the Tuner, the spectra pages. It is filled by ONE poller
 * (hooks/use-run-status.ts), so two screens can no longer disagree about
 * whether a run is going.
 *
 * `known` stays false until the server has answered once: until then nothing
 * may claim "Stopped".
 */
export interface LeftoverRun {
  run_number: number;
  target_name?: string | null;
  start_time?: string | null;
  /** data/run<N>/ exists: Start would overwrite its files. */
  has_data?: boolean;
}

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
  /** The server's "Save to disk" flag; null until it has answered. */
  saving: boolean | null;
  /** A run that just stopped without saving. Its number was not used up and
   *  the next run gets it again; the overview and the run bar say so. Known to
   *  this browser only (it is seen stopping), cleared by a saving run. */
  unsavedRun: number | null;
  /** Stopped: the server already has a record for the next run's number that
   *  never ended (a run that saved nothing, or one cut short by a server
   *  restart). Read from the server, so every browser knows it; null when
   *  there is none or while a run is going. */
  leftoverRun: LeftoverRun | null;
  setIsRunning: (isRunning: boolean) => void;
  setStartTime: (startTime: string | null) => void;
  setRunNumber: (runNumber: number | null) => void;
  update: (patch: Partial<Omit<RunControlState, 'setIsRunning' | 'setStartTime' | 'setRunNumber' | 'update'>>) => void;
}

type Patch = Partial<Omit<RunControlState, 'setIsRunning' | 'setStartTime' | 'setRunNumber' | 'update'>>;

/** Notice a run ending unsaved, whichever path set the state (a Stop on this
 *  page sets isRunning itself, before the poller sees anything). */
function withUnsavedRun(s: RunControlState, patch: Patch): Patch {
  const running = patch.isRunning ?? s.isRunning;
  const saving = patch.saving ?? s.saving;
  // A Tuner session never had a run number of its own: nothing to explain.
  if (s.isRunning && !running && s.saving === false && s.runNumber !== null
      && !tunerOwnsRun(s.startTime)) {
    return { ...patch, unsavedRun: s.runNumber };
  }
  if (running && saving === true && s.unsavedRun !== null) return { ...patch, unsavedRun: null };
  return patch;
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
  saving: null,
  unsavedRun: null,
  leftoverRun: null,
  setIsRunning: (isRunning) => set((s) => withUnsavedRun(s, { isRunning, known: true })),
  setStartTime: (startTime) => set({ startTime }),
  setRunNumber: (runNumber) => set({ runNumber }),
  update: (patch) => set((s) => withUnsavedRun(s, patch)),
}));

export default useRunControlStore;
