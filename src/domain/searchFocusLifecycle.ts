export interface SearchFocusHost {
  focusInput: () => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frame: number) => void;
  addWindowFocusListener: (listener: () => void) => void;
  removeWindowFocusListener: (listener: () => void) => void;
}

/**
 * Focuses the header search on the first rendered frame and confirms it again when the native
 * window becomes active. stop() claims the round before cleanup so a queued old frame is inert.
 */
export function startSearchFocusLifecycle(host: SearchFocusHost): () => void {
  let active = true;
  const focus = () => {
    if (active) host.focusInput();
  };
  const frame = host.requestFrame(focus);
  host.addWindowFocusListener(focus);

  return () => {
    active = false;
    host.cancelFrame(frame);
    host.removeWindowFocusListener(focus);
  };
}
