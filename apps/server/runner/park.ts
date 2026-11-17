import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./json-file";
import { bootId } from "./lock";

/**
 * An operator's park, for a server hosting this computer that runs short of memory: `agentes-runner park` asks the
 * running runner to park every desktop nobody uses (`DesktopSessions.parkIdle`, each opens what was open on it again at
 * its next start) and to ease every idle Chrome (`BrowserManager.easeIdle`, no tab lost). Nothing in use is touched. The
 * ask is a file the runner reads every second, as standby's (`standby.ts`), answered in another with what it did.
 */

export const PARK_FILE = "park.json";
export const PARK_ACK_FILE = "park-ack.json";

export interface ParkAsk {
  id: string;
  /** The boot it was asked in: another boot's ask is void. */
  boot: string;
}

export interface ParkDone {
  id: string;
  desktops: number;
  browsers: number;
}

export function askPark(home: string): ParkAsk {
  const ask: ParkAsk = { id: randomUUID(), boot: bootId() };
  writeJson(path.join(home, PARK_FILE), ask);
  return ask;
}

/** The ask waiting, taken: written in this boot, so a runner started later never parks for an old one. */
export function takePark(home: string, boot = bootId()): ParkAsk | null {
  const file = path.join(home, PARK_FILE);
  const ask = readJson<ParkAsk>(file);
  if (!ask) return null;
  rmSync(file, { force: true });
  return typeof ask.id === "string" && ask.boot === boot ? ask : null;
}

export function ackPark(home: string, done: ParkDone) {
  writeJson(path.join(home, PARK_ACK_FILE), done);
}

/** What the runner did for the ask `id`, once it did. */
export function parkDone(home: string, id: string): ParkDone | null {
  const done = readJson<Partial<ParkDone>>(path.join(home, PARK_ACK_FILE));
  return done?.id === id && typeof done.desktops === "number" && typeof done.browsers === "number"
    ? (done as ParkDone)
    : null;
}
