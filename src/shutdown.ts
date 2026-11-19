const SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
/** Inside the 10 seconds Docker and Kubernetes allow before they kill the process outright. */
const CLOSE_TIMEOUT_MS = 8_000;
/** Each session's close, and what ends at once whatever it still runs. */
const sessions = new Map<() => Promise<void>, () => void>();

async function onSignal(signal: NodeJS.Signals): Promise<void> {
  for (const name of SIGNALS) process.off(name, onSignal);
  const closing = [...sessions];
  await Promise.race([
    Promise.allSettled(closing.map(([close]) => close())),
    new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref()),
  ]);
  // A browser still closing when time is up would outlive the process, its profile locked.
  for (const [, kill] of closing) kill();
  // Raised again with nothing left listening, so it ends the process as it would have; an app's own handler keeps that call.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

/** One listener for every session in the process, so all close before the signal ends it. */
export function closeOnSignal(close: () => Promise<void>, kill: () => void): () => void {
  if (sessions.size === 0) for (const name of SIGNALS) process.on(name, onSignal);
  sessions.set(close, kill);
  return () => {
    sessions.delete(close);
    if (sessions.size === 0) for (const name of SIGNALS) process.off(name, onSignal);
  };
}
