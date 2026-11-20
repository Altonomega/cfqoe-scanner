// Abort plumbing for the calibration path, shared by the concurrency
// ladder and the websocket control hunt. Signals here are
// AbortSignal-shaped (the web layer's cancel token; see scan.js): the
// helpers rely only on `.aborted`, `.reason`, and — when present —
// `addEventListener`. A signal without listener support degrades to
// the between-steps checks in throwIfAborted, which still bound the
// stop latency to one in-flight probe.

// The rejection an aborted operation fails with: the signal's own
// reason when it carries one (a real AbortSignal always does), else
// an equivalent AbortError.
export function abortReason(signal) {
  if (signal?.reason) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error) {
  return Boolean(error) && error.name === 'AbortError';
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

// Settles like `promise`, except that an abort rejects immediately
// with the abort reason instead of waiting for the underlying work.
// The abandoned work keeps its own timeout and settles on its own;
// its outcome is always handled here, so a late rejection from an
// abandoned probe can never surface as unhandled.
export function raceWithAbort(promise, signal) {
  if (!signal) return promise;
  const tracked = Promise.resolve(promise);
  if (signal.aborted || typeof signal.addEventListener !== 'function') {
    if (signal.aborted) {
      tracked.catch(() => {});
      return Promise.reject(abortReason(signal));
    }
    return tracked;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    tracked.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
