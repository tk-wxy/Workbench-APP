export interface HiddenResetClock {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface HiddenResetLifecycle {
  arm: () => void;
  resume: () => void;
  cancel: () => void;
}

const browserClock: HiddenResetClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer),
};

/**
 * Retains a recoverable UI state while the workbench is hidden.
 *
 * The deadline is authoritative: hidden WebViews may deliver timers late, so resume() checks
 * elapsed wall-clock time before cancelling the pending callback. A generation claim prevents
 * a late callback from an earlier hide round from resetting a newly opened round.
 */
export function createHiddenResetLifecycle(
  delayMs: number,
  onReset: () => void,
  clock: HiddenResetClock = browserClock,
): HiddenResetLifecycle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline: number | null = null;
  let generation = 0;

  const cancel = () => {
    generation++;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    deadline = null;
  };

  const arm = () => {
    cancel();
    const token = generation;
    deadline = clock.now() + delayMs;
    timer = clock.setTimeout(() => {
      if (token !== generation) return;
      timer = null;
      deadline = null;
      generation++;
      onReset();
    }, delayMs);
  };

  const resume = () => {
    if (deadline === null) return;
    const expired = clock.now() >= deadline;
    cancel();
    if (expired) onReset();
  };

  return { arm, resume, cancel };
}
