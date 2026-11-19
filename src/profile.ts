import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve as resolvePath } from "node:path";

/** A browser ended outright exits at once, though its new parent may take a moment to reap it. */
const EXIT_WAIT_MS = 2_000;
const POLL_MS = 100;

/**
 * A process killed outright leaves its browser running, holding the profile so
 * no other can open it. Chromium's lock names that browser as `<host>-<pid>`;
 * it is ended only when it runs on this host, on this very profile, and the
 * process that launched it is gone, leaving init its parent.
 */
export async function freeProfile(dir: string | undefined): Promise<boolean> {
  if (!dir) return false;
  // Puppeteer hands Chromium the profile as an absolute path.
  const profile = resolvePath(dir);
  const lock = await readlink(join(profile, "SingletonLock")).catch(() => "");
  const [, host, pid] = /^(.+)-(\d+)$/.exec(lock) ?? [];
  if (!pid || host !== hostname()) return false;
  const [, parent, args] = /^(\d+)\s+(.*)$/.exec(await commandOf(pid)) ?? [];
  if (parent !== "1" || !`${args} `.includes(` --user-data-dir=${profile} `)) return false;
  try {
    process.kill(-Number(pid), "SIGKILL");
  } catch {
    return false;
  }
  for (let waited = 0; alive(Number(pid)) && waited < EXIT_WAIT_MS; waited += POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return true;
}

/** Its parent and command line, as `ps` prints them; nothing where `ps` is missing. */
function commandOf(pid: string): Promise<string> {
  return new Promise((resolve) =>
    execFile("ps", ["-ww", "-o", "ppid=,args=", "-p", pid], (error, stdout) =>
      resolve(error ? "" : stdout.trim()),
    ),
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
