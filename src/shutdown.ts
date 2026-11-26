const SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
/** Inside the 10 seconds Docker and Kubernetes allow before they kill the process outright. */
const CLOSE_TIMEOUT_MS = 8_000;
/** Each session's close, and what ends at once whatever it still runs. */
const sessions = new Map<() => Promise<void>, () => void>();
/** Kept listening until every session is closed, so a repeated signal, as Ctrl+C under npx sends, cannot end the process half-closed. */
let shuttingDown = false;

function onSignal(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdown(signal);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  const closing = [...sessions];
  await Promise.race([
    Promise.allSettled(closing.map(([close]) => close())),
    new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref()),
  ]);
  // A browser still closing when time is up would outlive the process, its profile locked.
  for (const [, kill] of closing) kill();
  for (const name of SIGNALS) process.off(name, onSignal);
  // Raised again with nothing left listening, so it ends the process as it would have; an app's own handler keeps that call.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

/** One listener for every session in the process, so all close before the signal ends it. */
export function closeOnSignal(close: () => Promise<void>, kill: () => void): () => void {
  if (sessions.size === 0) for (const name of SIGNALS) process.on(name, onSignal);
  sessions.set(close, kill);
  return () => {
    sessions.delete(close);
    if (sessions.size === 0 && !shuttingDown) {
      for (const name of SIGNALS) process.off(name, onSignal);
    }
  };
}
