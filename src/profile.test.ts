import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freeProfile } from "./profile";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readlink: vi.fn() }));
vi.mock("node:os", () => ({ hostname: () => "box" }));

const DIR = "/srv/.wwebjs_auth/session";
const CHROME = "/opt/chrome/chrome --headless=new";

describe("freeProfile", () => {
  let kill: ReturnType<typeof vi.spyOn>;
  let gone: boolean;

  function heldBy(lock: string, ps: string) {
    vi.mocked(readlink).mockResolvedValue(lock as never);
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      callback: (error: Error | null, stdout: string) => void,
    ) => callback(null, ps)) as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    gone = false;
    kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") gone = true;
      else if (gone) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      return true;
    });
  });

  afterEach(() => kill.mockRestore());

  it("ends a browser left on this host holding the profile once the process that ran it is gone", async () => {
    heldBy("box-4242", `    1 ${CHROME} --user-data-dir=${DIR} --no-first-run\n`);

    await expect(freeProfile(DIR)).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(execFile).toHaveBeenCalledWith(
      "ps",
      ["-ww", "-o", "ppid=,args=", "-p", "4242"],
      expect.any(Function),
    );
  });

  it("never ends a browser another live process runs", async () => {
    heldBy("box-4242", ` 7311 ${CHROME} --user-data-dir=${DIR}\n`);

    await expect(freeProfile(DIR)).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("never ends one on another profile, as when the lock's pid was reused", async () => {
    heldBy("box-4242", `    1 ${CHROME} --user-data-dir=${DIR}-2\n`);

    await expect(freeProfile(DIR)).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("leaves a lock from another host alone, since its browser may still run there", async () => {
    heldBy("other-host-4242", `    1 ${CHROME} --user-data-dir=${DIR}\n`);

    await expect(freeProfile(DIR)).resolves.toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("does nothing without a profile, a lock, or a process to look up", async () => {
    await expect(freeProfile(undefined)).resolves.toBe(false);

    vi.mocked(readlink).mockRejectedValue(new Error("ENOENT"));
    await expect(freeProfile(DIR)).resolves.toBe(false);

    heldBy("box-4242", "");
    await expect(freeProfile(DIR)).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
