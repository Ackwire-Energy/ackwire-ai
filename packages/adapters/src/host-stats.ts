/**
 * How big this computer is and how busy it gets, for the usage report: the server samples its own host,
 * and the runner its computer (protocol 22). Node's `os` and `fs` only, so the runner bundle can use it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { LOAD_SAMPLE_MS, type MachineLoad, type MachineSize } from "./machine-protocol";

const GIB = 2 ** 30;
const DAY_MS = 24 * 3600_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Logical CPUs, memory (to 0.5 GB) and the disk holding `dir` (to 1 GB), as this process sees them. */
export function machineSize(dir: string): MachineSize {
  let diskGb = 0;
  try {
    const fs = statfsSync(dir);
    diskGb = Math.round((fs.blocks * fs.bsize) / GIB);
  } catch {
    // a folder that went away: size unknown, the rest still says something
  }
  return { cpus: os.availableParallelism(), memoryGb: Math.round((os.totalmem() / GIB) * 2) / 2, diskGb };
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

/** The share of memory in use now. `os.freemem()` counts the cache the system would hand back as used. */
function memoryInUse(): number {
  const total = os.totalmem();
  let available: number | null = null;
  try {
    if (process.platform === "linux") available = memAvailable(readFileSync("/proc/meminfo", "utf8"));
    else if (process.platform === "darwin") {
      available = vmStatAvailable(execFileSync("vm_stat", { encoding: "utf8", timeout: 5000 }));
    }
  } catch {
    // fall back to what the runtime says
  }
  return Math.min(1, Math.max(0, 1 - (available ?? os.freemem()) / total));
}

/** One sample: the 5-minute load average per logical CPU and the share of memory in use. Null on Windows. */
export function sampleLoad(): { load: number; memory: number } | null {
  if (process.platform === "win32") return null;
  const [, fiveMinutes = 0] = os.loadavg();
  return { load: fiveMinutes / os.availableParallelism(), memory: memoryInUse() };
}

/** The last day of samples, summarized; `summary()` is the same object until the next sample. */
export class LoadWindow {
  private samples: { at: number; load: number; memory: number }[] = [];
  private last: MachineLoad | null = null;

  add(sample: { load: number; memory: number } | null, at = Date.now()) {
    if (!sample) return;
    this.samples.push({ at, ...sample });
    this.samples = this.samples.filter((s) => s.at > at - DAY_MS);
    const n = this.samples.length;
    const avg = (pick: (s: (typeof this.samples)[number]) => number) =>
      round2(this.samples.reduce((sum, s) => sum + pick(s), 0) / n);
    const peak = (pick: (s: (typeof this.samples)[number]) => number) => round2(Math.max(...this.samples.map(pick)));
    this.last = {
      loadAvg: avg((s) => s.load),
      loadPeak: peak((s) => s.load),
      memoryAvg: avg((s) => s.memory),
      memoryPeak: peak((s) => s.memory),
      hours: Math.min(24, Math.round(((n * LOAD_SAMPLE_MS) / 3600_000) * 10) / 10),
    };
  }

  summary(): MachineLoad | null {
    return this.last;
  }
}
