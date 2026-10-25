/**
 * The usage report's sender (ADR 0060 §5): samples the host, sends the report about an hour after start
 * and then once a day, and prints it for `agentes telemetry`. What goes in it is `buildTelemetryReport`.
 */
import { LOAD_SAMPLE_MS } from "@agenteschat/adapters";
import { inContainer, LoadWindow, machineSize, sampleLoad } from "@agenteschat/adapters/host-stats";
import type { Config } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import {
  buildTelemetryReport,
  isAgentesCloud,
  markServerStarted,
  saveHostLoad,
  type TelemetryFacts,
  telemetrySends,
  telemetryState,
} from "@agenteschat/engine";
import type { Logger } from "./logger";
import { version } from "./version";

export const FIRST_REPORT_MS = 3600_000;
export const REPORT_EVERY_MS = 24 * 3600_000;
/** After a failed send; once they run out, the next day's report takes its place (nothing piles up). */
export const RETRY_MS = [5 * 60_000, 30 * 60_000, 2 * 3600_000];
const SEND_TIMEOUT_MS = 10_000;

/** What this process knows about itself and its host. */
export function telemetryFacts(config: Config): TelemetryFacts {
  const container = inContainer();
  return {
    version,
    edition: isAgentesCloud(config.PUBLIC_URL) ? "cloud" : "selfhost",
    install: config.INSTALL_MODE ?? (container ? "docker" : "native"),
    os: process.platform,
    arch: process.arch,
    // FILES_DIR is the compose file's data volume.
    host: { size: machineSize(config.FILES_DIR ?? process.cwd()), container },
  };
}

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

const REAL_TIMERS: Timers = {
  set: (run, ms) => {
    const t = setTimeout(run, ms);
    t.unref?.();
    return t;
  },
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

export interface TelemetryDeps {
  db: Database;
  config: Config;
  log: Logger;
  fetch?: typeof fetch;
  timers?: Timers;
  sample?: typeof sampleLoad;
}

/**
 * Samples the host every `LOAD_SAMPLE_MS` (always: `agentes telemetry` prints the load too) and, on a
 * production server where the report is on, sends it. Failures stay in the debug log: nobody sees them
 * and nothing waits on them.
 */
export function startTelemetry(deps: TelemetryDeps) {
  const { db, config, log } = deps;
  const timers = deps.timers ?? REAL_TIMERS;
  const post = deps.fetch ?? fetch;
  const take = deps.sample ?? sampleLoad;
  const window = new LoadWindow();
  const pending = new Set<unknown>();
  let stopped = false;

  const later = (ms: number, run: () => Promise<void>) => {
    if (stopped) return;
    const timer = timers.set(() => {
      pending.delete(timer);
      if (stopped) return;
      run().catch((error: unknown) => log.debug("usage report", { error: String(error) }));
    }, ms);
    pending.add(timer);
  };

  const sample = async () => {
    try {
      window.add(take());
      await saveHostLoad(db, window.summary());
    } finally {
      later(LOAD_SAMPLE_MS, sample);
    }
  };

  const send = async () => {
    const state = await telemetryState(db);
    if (!telemetrySends(config, state.enabled)) return "off";
    const report = await buildTelemetryReport(db, telemetryFacts(config));
    const res = await post(config.TELEMETRY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return "sent";
  };

  /** One day's report, with its retries; `waited` keeps the next day where it was. */
  const day = async (retry = 0, waited = 0): Promise<void> => {
    try {
      log.debug("usage report", { outcome: await send() });
    } catch (error) {
      const delay = RETRY_MS[retry];
      log.debug("usage report not sent", { error: String(error), retryInMs: delay ?? null });
      if (delay !== undefined) return later(delay, () => day(retry + 1, waited + delay));
    }
    later(REPORT_EVERY_MS - waited, () => day());
  };

  const ready = (async () => {
    await markServerStarted(db).catch((error: unknown) => log.debug("usage report", { error: String(error) }));
    await sample().catch((error: unknown) => log.debug("usage report", { error: String(error) }));
  })();
  const cloud = isAgentesCloud(config.PUBLIC_URL);
  // A development server is nobody's installation.
  // ponytail: every replica sends its own report under the one instance id; claim the day in the row if that matters.
  if ((cloud || config.TELEMETRY === "on") && config.NODE_ENV === "production") {
    later(FIRST_REPORT_MS, () => day());
    log.info(
      `anonymous usage report: once a day to ${config.TELEMETRY_URL}${cloud ? "" : " unless turned off (TELEMETRY=off, or Settings → General)"}`,
    );
  }
  return {
    ready,
    stop() {
      stopped = true;
      for (const t of pending) timers.clear(t);
      pending.clear();
    },
  };
}

/** `agentes telemetry`: the next report, exactly, on stdout, and whether it goes out on stderr. Sends nothing. */
export async function printTelemetry(
  db: Database,
  config: Config,
  out: { write(text: string): unknown } = process.stdout,
  err: { write(text: string): unknown } = process.stderr,
) {
  const state = await telemetryState(db);
  const report = await buildTelemetryReport(db, telemetryFacts(config));
  out.write(`${JSON.stringify(report, null, 2)}\n`);
  const on = `On: sent once a day to ${config.TELEMETRY_URL}.`;
  err.write(
    isAgentesCloud(config.PUBLIC_URL)
      ? `${on}\n`
      : telemetrySends(config, state.enabled)
        ? `${on} TELEMETRY=off in .env turns it off.\n`
        : config.TELEMETRY === "off"
          ? "Off (TELEMETRY=off): nothing is sent.\n"
          : "Off (turned off in Settings): nothing is sent.\n",
  );
}
