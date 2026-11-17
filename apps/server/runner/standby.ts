import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { readJson, writeJson } from "./json-file";
import { bootId } from "./lock";

/**
 * An operator's standby (ADR 0176): `agentes-runner standby` asks the running runner to drop its link to the server
 * and keep everything else running (tasks, the agents' Chrome, their desktops, their programs and holds), so a pause of
 * the computer keeps them all; `agentes-runner resume` brings the link back. The ask is a file the runner reads every
 * second, answered in another once it applied it. It lapses by itself, in the computer's own running time
 * (`os.uptime`, which a paused computer doesn't count), unless asked again, so a runner nobody resumes comes back.
 */

export const STANDBY_FILE = "standby.json";
export const STANDBY_ACK_FILE = "standby-ack.json";
/** How long a standby lasts, in running minutes, when not asked again. */
export const STANDBY_DEFAULT_MINUTES = 5;
export const STANDBY_MAX_MINUTES = 60;
/** How often the runner reads the ask. */
export const STANDBY_POLL_MS = 1_000;

export interface StandbyAsk {
  id: string;
  /** The boot it was asked in: another boot's ask is void. */
  boot: string;
  /** `os.uptime()` seconds it lasts until; 0: resume. */
  until: number;
}

const file = (home: string, name: string) => path.join(home, name);

/** Writes the ask (`minutes` 0: resume) and returns it. */
export function askStandby(home: string, minutes: number, uptime = os.uptime()): StandbyAsk {
  const ask: StandbyAsk = { id: randomUUID(), boot: bootId(), until: minutes > 0 ? uptime + minutes * 60 : 0 };
  writeJson(file(home, STANDBY_FILE), ask);
  return ask;
}

export function readStandby(home: string): StandbyAsk | null {
  const ask = readJson<StandbyAsk>(file(home, STANDBY_FILE));
  return ask && typeof ask.id === "string" && typeof ask.until === "number" ? ask : null;
}

/** In force now: asked in this boot, and not lapsed. */
export function standbyOn(ask: StandbyAsk | null, uptime = os.uptime(), boot = bootId()): boolean {
  return ask !== null && ask.boot === boot && ask.until > uptime;
}

/** The runner applied the ask `id`. */
export function ackStandby(home: string, id: string) {
  writeJson(file(home, STANDBY_ACK_FILE), { id });
}

export function standbyAcked(home: string, id: string): boolean {
  return readJson<{ id?: unknown }>(file(home, STANDBY_ACK_FILE))?.id === id;
}
