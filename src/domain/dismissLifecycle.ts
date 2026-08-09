export interface DismissTimers {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timerId: number): void;
}

/**
 * The CSS fade itself owns the normal completion signal (`transitionend`). This watchdog is
 * deliberately much longer than the 200ms visual transition: it exists only for exceptional
 * paths where that event is suppressed (for example, a style change cancels the transition).
 */
export const DISMISS_WATCHDOG_MS = 1_000;

export interface DismissLifecycle {
  begin(onComplete: () => void): void;
  complete(): boolean;
  cancel(): void;
}

export function createDismissLifecycle(
  timers: DismissTimers,
  watchdogMs = DISMISS_WATCHDOG_MS,
): DismissLifecycle {
  let onComplete: (() => void) | null = null;
  let watchdogId: number | null = null;
  let generation = 0;

  const clearWatchdog = () => {
    if (watchdogId === null) return;
    timers.clearTimeout(watchdogId);
    watchdogId = null;
  };

  const complete = (): boolean => {
    const action = onComplete;
    if (!action) return false;
    onComplete = null;
    clearWatchdog();
    action();
    return true;
  };

  const cancel = () => {
    generation++;
    onComplete = null;
    clearWatchdog();
  };

  return {
    begin(action) {
      cancel();
      onComplete = action;
      const currentGeneration = ++generation;
      watchdogId = timers.setTimeout(() => {
        if (generation !== currentGeneration) return;
        complete();
      }, watchdogMs);
    },
    complete,
    cancel,
  };
}
