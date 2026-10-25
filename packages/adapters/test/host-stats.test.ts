import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { combineLoads, LoadWindow, machineSize, memAvailable, sampleLoad, vmStatAvailable } from "../src/host-stats";
import { LOAD_SAMPLE_MS, parseRunnerFrame } from "../src/machine-protocol";

const HOUR = 3600_000;
const GIB = 2 ** 30;
afterEach(() => mock.restore());

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

  test("a restarted process starts from the samples the last one kept", () => {
    const t0 = Date.UTC(2026, 9, 25, 12);
    const before = new LoadWindow();
    before.add({ load: 2, memory: 0.9 }, t0);
    before.add({ load: 1, memory: 0.5 }, t0 + LOAD_SAMPLE_MS);
    const after = new LoadWindow(JSON.parse(JSON.stringify(before.samples)));
    expect(after.summary()).toBeNull();
    after.add({ load: 0, memory: 0.1 }, t0 + 3 * HOUR);
    expect(after.summary()).toEqual({ loadAvg: 1, loadPeak: 2, memoryAvg: 0.5, memoryPeak: 0.9, hours: 0.3 });
  });

  test("several computers' days as one: the averages averaged, the highest peaks", () => {
    const a = { loadAvg: 0.2, loadPeak: 0.8, memoryAvg: 0.4, memoryPeak: 0.6, hours: 24 };
    const b = { loadAvg: 0.6, loadPeak: 1.9, memoryAvg: 0.7, memoryPeak: 0.95, hours: 12 };
    expect(combineLoads([a, null, b])).toEqual({
      loadAvg: 0.4,
      loadPeak: 1.9,
      memoryAvg: 0.55,
      memoryPeak: 0.95,
      hours: 18,
    });
    expect(combineLoads([null, a])).toBe(a);
    expect(combineLoads([null])).toBeNull();
  });

  test("in a container with limits: the machine's size with the limit beside it, the load per machine CPU", async () => {
    // A 4-CPU, 8 GB machine running `docker run --cpus=1 --memory=1g`.
    spyOn(os, "cpus").mockReturnValue(Array.from({ length: 4 }, () => os.cpus()[0] as os.CpuInfo));
    spyOn(os, "availableParallelism").mockReturnValue(1);
    spyOn(os, "totalmem").mockReturnValue(8 * GIB);
    spyOn(process, "constrainedMemory").mockReturnValue(GIB);
    spyOn(os, "loadavg").mockReturnValue([4, 3.2, 2]);
    const dir = mkdtempSync(join(tmpdir(), "stats-"));
    expect(machineSize(dir)).toMatchObject({ cpus: 4, memoryGb: 8, limit: { cpus: 1, memoryGb: 1 } });
    if (process.platform !== "win32") expect((await sampleLoad())?.load).toBe(0.8);
    // No limit: none said.
    spyOn(os, "availableParallelism").mockReturnValue(4);
    spyOn(process, "constrainedMemory").mockReturnValue(8 * GIB);
    expect(machineSize(dir)).not.toHaveProperty("limit");
    spyOn(process, "constrainedMemory").mockReturnValue(0);
    expect(machineSize(dir)).not.toHaveProperty("limit");
  });

  test("a sample doesn't hold up the process while the system answers", async () => {
    let ticks = 0;
    const tick = setInterval(() => ticks++, 0);
    await sampleLoad();
    clearInterval(tick);
    // macOS reads its memory from `vm_stat`, a program; on Linux it is a file read.
    if (process.platform === "darwin") expect(ticks).toBeGreaterThan(0);
  });

  test("this computer: a sample and a size", async () => {
    const s = await sampleLoad();
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
    const limited = { cpus: 4, memoryGb: 8, diskGb: 80, limit: { cpus: 1, memoryGb: 1 } };
    expect(hello({ size: limited })).toMatchObject({ size: limited });
    // A limit above the machine itself isn't one.
    expect((hello({ size: { ...limited, limit: { cpus: 8, memoryGb: 1 } } }) as { size: object }).size).toEqual({
      cpus: 4,
      memoryGb: 8,
      diskGb: 80,
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
