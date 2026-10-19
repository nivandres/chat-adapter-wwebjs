const SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
const sessions = new Set<() => Promise<void>>();

async function onSignal(signal: NodeJS.Signals): Promise<void> {
  for (const name of SIGNALS) process.off(name, onSignal);
  await Promise.allSettled([...sessions].map((close) => close()));
  // Raised again with nothing left listening, so it ends the process as it would have; an app's own handler keeps that call.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

/** One listener for every session in the process, so all close before the signal ends it. */
export function closeOnSignal(close: () => Promise<void>): () => void {
  if (sessions.size === 0) for (const name of SIGNALS) process.on(name, onSignal);
  sessions.add(close);
  return () => {
    sessions.delete(close);
    if (sessions.size === 0) for (const name of SIGNALS) process.off(name, onSignal);
  };
}
