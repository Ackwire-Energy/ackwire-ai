/**
 * ─── MOCK ────────────────────────────────────────────────────────────────────
 * In-memory stand-ins for backend features that have no endpoint yet. They
 * live only in the browser tab (lost on reload) and never talk to a model,
 * MCP server or connector. Each file lists the endpoint it is waiting for;
 * replace the mock with an HTTP call in `src/api/index.ts` when it lands.
 *
 * Left today: the org-wide invite link, "ask for a new invitation", custom
 * MCP servers, storage, artifacts, issues, routines and the calendar.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Agent, Channel, Me, Member } from "../types";

export interface MockContext {
  seed: boolean;
  now: () => Date;
  /** Real data the seeds attach to. */
  lookup: {
    me(): Promise<Me | null>;
    agents(orgId: string): Promise<Agent[]>;
    channels(orgId: string): Promise<Channel[]>;
    members(orgId: string): Promise<Member[]>;
  };
}

let counter = 0;
export const mockId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;

export const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000).toISOString();
export const hoursFromNow = (now: Date, h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();

/** Lazily seeded per-organization store. */
export function perOrg<T>(init: (orgId: string) => Promise<T>) {
  const stores = new Map<string, Promise<T>>();
  return (orgId: string) => {
    let store = stores.get(orgId);
    if (!store) {
      store = init(orgId);
      stores.set(orgId, store);
    }
    return store;
  };
}

export class MockNotFoundError extends Error {
  readonly status = 404;
  readonly code = "not_found";
}

export const clone = <T>(value: T): T => structuredClone(value);
