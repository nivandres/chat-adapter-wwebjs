import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("closeOnSignal", () => {
  let others: Function[];
  let kill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    others = process.rawListeners("SIGTERM");
    process.removeAllListeners("SIGTERM");
    kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    kill.mockRestore();
    process.removeAllListeners("SIGTERM");
    for (const listener of others) process.on("SIGTERM", listener as () => void);
  });

  it("closes every session before the signal ends the process", async () => {
    const { closeOnSignal } = await import("./shutdown");
    const closed: string[] = [];
    closeOnSignal(async () => void closed.push("one"));
    closeOnSignal(async () => void closed.push("two"));
    expect(process.listenerCount("SIGTERM")).toBe(1);

    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM"));

    expect(closed).toEqual(["one", "two"]);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  it("leaves ending the process to an app that listens for the signal itself", async () => {
    const { closeOnSignal } = await import("./shutdown");
    const close = vi.fn(async () => undefined);
    const own = vi.fn();
    closeOnSignal(close);
    process.on("SIGTERM", own);

    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    await new Promise((resolve) => setImmediate(resolve));

    expect(own).toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("still ends the process when a session fails to close", async () => {
    const { closeOnSignal } = await import("./shutdown");
    closeOnSignal(async () => {
      throw new Error("browser stuck");
    });

    process.emit("SIGTERM", "SIGTERM");

    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM"));
  });

  it("ends the process in time even when a session never finishes closing", async () => {
    vi.useFakeTimers();
    try {
      const { closeOnSignal } = await import("./shutdown");
      closeOnSignal(() => new Promise(() => {}));

      process.emit("SIGTERM", "SIGTERM");
      await vi.advanceTimersByTimeAsync(8_000);

      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops listening once the last session is gone", async () => {
    const { closeOnSignal } = await import("./shutdown");
    const first = closeOnSignal(async () => undefined);
    const second = closeOnSignal(async () => undefined);

    first();
    expect(process.listenerCount("SIGTERM")).toBe(1);
    second();
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });
});
