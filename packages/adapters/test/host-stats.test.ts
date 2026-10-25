import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoadWindow, machineSize, memAvailable, sampleLoad, vmStatAvailable } from "../src/host-stats";
import { LOAD_SAMPLE_MS, parseRunnerFrame } from "../src/machine-protocol";

const HOUR = 3600_000;

describe("the load sampler", () => {
  test("averages and peaks the last day of samples; older ones drop out", () => {
    const w = new LoadWindow();
    expect(w.summary()).toBeNull();
    const t0 = Date.UTC(2026, 9, 25, 12);
    w.add({ load: 2, memory: 0.9 }, t0);
    w.add({ load: 0.5, memory: 0.4 }, t0 + LOAD_SAMPLE_MS);
    w.add({ load: 0.3, memory: 0.5 }, t0 + 2 * LOAD_SAMPLE_MS);
    expect(w.summary()).toEqual({ loadAvg: 0.93, loadPeak: 2, memoryAvg: 0.6, memoryPeak: 0.9, hours: 0.3 });
    // A day later the first sample (the peak) is gone.
    w.add({ load: 0.1, memory: 0.2 }, t0 + 24 * HOUR);
    expect(w.summary()).toEqual({ loadAvg: 0.3, loadPeak: 0.5, memoryAvg: 0.37, memoryPeak: 0.5, hours: 0.3 });
  });

  test("the summary is the same object until the next sample; a missing sample changes nothing", () => {
    const w = new LoadWindow();
    w.add({ load: 1, memory: 0.5 }, 1);
    const first = w.summary();
    expect(w.summary()).toBe(first);
    w.add(null, 2);
    expect(w.summary()).toBe(first);
    w.add({ load: 1, memory: 0.5 }, 3);
    expect(w.summary()).not.toBe(first);
    expect(w.summary()?.hours).toBe(0.2);
  });

  test("a full day is 24 hours, never more", () => {
    const w = new LoadWindow();
    for (let i = 0; i < 400; i++) w.add({ load: 0.5, memory: 0.5 }, i * LOAD_SAMPLE_MS);
    expect(w.summary()?.hours).toBe(24);
  });

  test("memory in use reads what the system can hand out, not just free pages", () => {
    expect(
      memAvailable("MemTotal:       16314404 kB\nMemFree:          412012 kB\nMemAvailable:    9311148 kB\n"),
    ).toBe(9311148 * 1024);
    expect(memAvailable("MemTotal: 1 kB\n")).toBeNull();
    const vmStat = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                   125104.",
      "Pages active:                                 784048.",
      "Pages inactive:                               776509.",
      "Pages speculative:                             23421.",
      "Pages wired down:                             253987.",
    ].join("\n");
    expect(vmStatAvailable(vmStat)).toBe((125104 + 776509 + 23421) * 16384);
    expect(vmStatAvailable("nothing here")).toBeNull();
  });

  test("this computer: a sample and a size", () => {
    const s = sampleLoad();
    if (process.platform !== "win32") {
      expect(s?.load).toBeGreaterThanOrEqual(0);
      expect(s?.memory).toBeGreaterThan(0);
      expect(s?.memory).toBeLessThanOrEqual(1);
    }
    const size = machineSize(mkdtempSync(join(tmpdir(), "stats-")));
    expect(size.cpus).toBeGreaterThanOrEqual(1);
    expect(size.memoryGb).toBeGreaterThan(0);
    expect(size.diskGb).toBeGreaterThan(0);
    expect(Number.isInteger(size.diskGb)).toBe(true);
    expect(machineSize("/no/such/folder").diskGb).toBe(0);
  });
});

describe("protocol 22 on the wire", () => {
  const hello = (extra: Record<string, unknown>) =>
    parseRunnerFrame(JSON.stringify({ type: "hello", token: "t", version: "1", protocol: 22, ...extra }));

  test("hello carries the size; nonsense or an older runner's hello has none", () => {
    expect(hello({ size: { cpus: 2, memoryGb: 4, diskGb: 80 } })).toMatchObject({
      size: { cpus: 2, memoryGb: 4, diskGb: 80 },
    });
    expect(hello({})).not.toHaveProperty("size");
    expect(hello({ size: { cpus: 0, memoryGb: 4, diskGb: 80 } })).not.toHaveProperty("size");
    expect(hello({ size: { cpus: 2, memoryGb: "4", diskGb: 80 } })).not.toHaveProperty("size");
  });

  test("a pong carries the load; without one, or a bad one, it is a plain pong", () => {
    const load = { loadAvg: 0.4, loadPeak: 1.2, memoryAvg: 0.5, memoryPeak: 0.7, hours: 6 };
    expect(parseRunnerFrame(JSON.stringify({ type: "pong", at: 1, load }))).toEqual({ type: "pong", at: 1, load });
    expect(parseRunnerFrame(JSON.stringify({ type: "pong", at: 1 }))).toEqual({ type: "pong", at: 1 });
    expect(parseRunnerFrame(JSON.stringify({ type: "pong", at: 1, load: { ...load, memoryPeak: 3 } }))).toEqual({
      type: "pong",
      at: 1,
    });
  });
});
