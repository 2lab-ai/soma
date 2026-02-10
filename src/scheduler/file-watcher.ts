interface FileWatcherTimers {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  setTimeout: typeof setTimeout;
}

export interface SchedulerFileWatcherState {
  fileWatcher: Timer | null;
  lastModifiedTime: number | null;
}

export interface StopFileWatcherOptions {
  state: SchedulerFileWatcherState;
  timers?: FileWatcherTimers;
  onStop?: () => void;
}

export function stopFileWatcher(options: StopFileWatcherOptions): void {
  if (!options.state.fileWatcher) {
    return;
  }

  const timers = options.timers ?? {
    setInterval,
    clearInterval,
    setTimeout,
  };
  timers.clearInterval(options.state.fileWatcher);
  options.state.fileWatcher = null;
  options.onStop?.();
}

export interface StartFileWatcherOptions {
  state: SchedulerFileWatcherState;
  configPath: string;
  pollIntervalMs: number;
  debounceMs: number;
  existsSync: (path: string) => boolean;
  statSync: (path: string) => { mtimeMs: number };
  onChange: () => void;
  onError: (error: unknown) => void;
  onDetectedChange?: () => void;
  onStart?: () => void;
  onStop?: () => void;
  timers?: FileWatcherTimers;
}

export function startFileWatcher(options: StartFileWatcherOptions): void {
  const timers = options.timers ?? {
    setInterval,
    clearInterval,
    setTimeout,
  };

  stopFileWatcher({
    state: options.state,
    timers,
    onStop: options.onStop,
  });

  options.state.fileWatcher = timers.setInterval(() => {
    if (!options.existsSync(options.configPath)) {
      return;
    }

    try {
      const modTime = options.statSync(options.configPath).mtimeMs;

      if (options.state.lastModifiedTime === null) {
        options.state.lastModifiedTime = modTime;
        return;
      }

      if (modTime <= options.state.lastModifiedTime) {
        return;
      }

      options.state.lastModifiedTime = modTime;
      options.onDetectedChange?.();
      timers.setTimeout(() => {
        options.onChange();
      }, options.debounceMs);
    } catch (error) {
      options.onError(error);
      stopFileWatcher({
        state: options.state,
        timers,
        onStop: options.onStop,
      });
    }
  }, options.pollIntervalMs);

  options.onStart?.();
}
