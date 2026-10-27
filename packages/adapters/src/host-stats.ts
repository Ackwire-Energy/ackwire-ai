/**
 * How big this computer is and how busy it gets, for the usage report: the server samples its own host,
 * and the runner its computer (protocol 22) and its agents' browsers' traffic (protocol 23). Node's `os`
 * and `fs` only, so the runner bundle can use it.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { type BrowserTraffic, LOAD_SAMPLE_MS, type MachineLoad, type MachineSize } from "./machine-protocol";

const GIB = 2 ** 30;
const DAY_MS = 24 * 3600_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const halfGb = (bytes: number) => Math.round((bytes / GIB) * 2) / 2;
const round1 = (n: number) => Math.round(n * 10) / 10;
/** The hours `n` samples cover, at most a day. */
const hoursOf = (n: number) => Math.min(24, round1((n * LOAD_SAMPLE_MS) / 3600_000));
const execFileAsync = promisify(execFile);

/**
 * The whole machine's logical CPUs. `availableParallelism()` follows a container's CPU limit, but the
 * load average and the memory figures are the whole machine's, so loads are measured against this.
 */
const machineCpus = () => os.cpus().length || os.availableParallelism();

/**
 * The machine's logical CPUs, memory (to 0.5 GB) and the disk holding `dir` (to 1 GB), with `limit`
 * when this process may use less of them (a container's CPU or memory limit).
 */
export function machineSize(dir: string): MachineSize {
  let diskGb = 0;
  try {
    const fs = statfsSync(dir);
    diskGb = Math.round((fs.blocks * fs.bsize) / GIB);
  } catch {
    // a folder that went away: size unknown, the rest still says something
  }
  const cpus = machineCpus();
  const memory = os.totalmem();
  const size: MachineSize = { cpus, memoryGb: halfGb(memory), diskGb };
  const limitCpus = Math.min(cpus, os.availableParallelism());
  // 0 (Node with no limit) or more than the machine has (an unlimited cgroup): no limit.
  const limitMemory = Math.min(memory, process.constrainedMemory?.() || memory);
  if (limitCpus < cpus || limitMemory < memory) size.limit = { cpus: limitCpus, memoryGb: halfGb(limitMemory) };
  return size;
}

/** Docker, Podman or Kubernetes: the host is shared with whatever else runs there. */
export const inContainer = () =>
  existsSync("/.dockerenv") || existsSync("/run/.containerenv") || process.env.KUBERNETES_SERVICE_HOST !== undefined;

/** `MemAvailable` from `/proc/meminfo`, in bytes. */
export function memAvailable(meminfo: string): number | null {
  const kb = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo)?.[1];
  return kb ? Number(kb) * 1024 : null;
}

/** What macOS hands out without swapping, from `vm_stat`: free, inactive and speculative pages, in bytes. */
export function vmStatAvailable(vmStat: string): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  const pages = (name: string) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(vmStat)?.[1] ?? Number.NaN);
  const n = (pages("free") + pages("inactive") + pages("speculative")) * page;
  return Number.isFinite(n) ? n : null;
}

/** The share of the machine's memory in use now. `os.freemem()` counts the cache the system would hand back as used. */
async function memoryInUse(): Promise<number> {
  const total = os.totalmem();
  let available: number | null = null;
  try {
    if (process.platform === "linux") available = memAvailable(readFileSync("/proc/meminfo", "utf8"));
    else if (process.platform === "darwin") {
      available = vmStatAvailable((await execFileAsync("vm_stat", { encoding: "utf8", timeout: 5000 })).stdout);
    }
  } catch {
    // fall back to what the runtime says
  }
  return Math.min(1, Math.max(0, 1 - (available ?? os.freemem()) / total));
}

export interface LoadSample {
  /** Epoch milliseconds. */
  at: number;
  load: number;
  memory: number;
}

/** One sample: the 5-minute load average per logical CPU of the machine and the share of memory in use. Null on Windows. */
export async function sampleLoad(): Promise<Omit<LoadSample, "at"> | null> {
  if (process.platform === "win32") return null;
  const [, fiveMinutes = 0] = os.loadavg();
  return { load: fiveMinutes / machineCpus(), memory: await memoryInUse() };
}

/**
 * The last day of samples, summarized; `summary()` is the same object until the next sample. A new
 * process starts from the `samples` the last one kept, so a restart keeps the day.
 */
export class LoadWindow {
  private last: MachineLoad | null = null;

  constructor(private kept: readonly LoadSample[] = []) {}

  get samples(): readonly LoadSample[] {
    return this.kept;
  }

  add(sample: Omit<LoadSample, "at"> | null, at = Date.now()) {
    if (!sample) return;
    this.kept = [...this.kept, { at, ...sample }].filter((s) => s.at > at - DAY_MS);
    const n = this.kept.length;
    const avg = (pick: (s: LoadSample) => number) => round2(this.kept.reduce((sum, s) => sum + pick(s), 0) / n);
    const peak = (pick: (s: LoadSample) => number) => round2(Math.max(...this.kept.map(pick)));
    this.last = {
      loadAvg: avg((s) => s.load),
      loadPeak: peak((s) => s.load),
      memoryAvg: avg((s) => s.memory),
      memoryPeak: peak((s) => s.memory),
      hours: hoursOf(n),
    };
  }

  summary(): MachineLoad | null {
    return this.last;
  }
}

/** Several computers' days as one: their averages averaged and the highest peaks; null when none said. */
export function combineLoads(loads: readonly (MachineLoad | null)[]): MachineLoad | null {
  const known = loads.filter((l): l is MachineLoad => l !== null);
  if (known.length <= 1) return known[0] ?? null;
  const mean = (pick: (l: MachineLoad) => number) => known.reduce((sum, l) => sum + pick(l), 0) / known.length;
  const peak = (pick: (l: MachineLoad) => number) => known.reduce((max, l) => Math.max(max, pick(l)), 0);
  return {
    loadAvg: round2(mean((l) => l.loadAvg)),
    loadPeak: round2(peak((l) => l.loadPeak)),
    memoryAvg: round2(mean((l) => l.memoryAvg)),
    memoryPeak: round2(peak((l) => l.memoryPeak)),
    hours: round1(mean((l) => l.hours)),
  };
}

/**
 * The last day of what the agents' browsers sent and received, a sample every `LOAD_SAMPLE_MS` (an
 * empty one too, so `hours` says how long it was counted); `summary()` is the same object until the
 * next sample.
 */
export class TrafficWindow {
  private kept: { at: number; up: number; down: number }[] = [];
  private last: BrowserTraffic | null = null;

  add(bytes: { up: number; down: number }, at = Date.now()) {
    this.kept = [...this.kept, { at, up: bytes.up, down: bytes.down }].filter((s) => s.at > at - DAY_MS);
    const sum = (pick: (s: { up: number; down: number }) => number) => this.kept.reduce((n, s) => n + pick(s), 0);
    this.last = { up: sum((s) => s.up), down: sum((s) => s.down), hours: hoursOf(this.kept.length) };
  }

  summary(): BrowserTraffic | null {
    return this.last;
  }
}

/** Computers' browser traffic as the usage report has it: MB (10^6 bytes), the hours counted, how many said. */
export interface CombinedTraffic {
  upMb: number;
  downMb: number;
  hours: number;
  computers: number;
}

/** Several computers' browser traffic as one: the bytes summed, their hours averaged; null when none said. */
export function combineTraffic(traffic: readonly (BrowserTraffic | null)[]): CombinedTraffic | null {
  const known = traffic.filter((t): t is BrowserTraffic => t !== null);
  if (known.length === 0) return null;
  const sum = (pick: (t: BrowserTraffic) => number) => known.reduce((n, t) => n + pick(t), 0);
  return {
    upMb: Math.round(sum((t) => t.up) / 1e6),
    downMb: Math.round(sum((t) => t.down) / 1e6),
    hours: round1(sum((t) => t.hours) / known.length),
    computers: known.length,
  };
}
