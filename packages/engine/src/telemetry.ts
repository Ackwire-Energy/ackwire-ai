import type { MachineLoad, MachineSize } from "@agenteschat/adapters";
import { type Database, eq, rowsOf, schema, sql } from "@agenteschat/db";

const { instanceTelemetry } = schema;

/**
 * The usage report (ADR 0060 §5): counts and sizes about this installation, sent once a day to agentes.chat.
 * Never content: no messages, files, names, emails, hostnames, paths, prompts, IPs, or ids of
 * organizations, people or computers. The only id is the random `instance` made at first start.
 */
export interface TelemetryReport {
  report: 1;
  instance: string;
  version: string;
  edition: "selfhost" | "cloud";
  install: "docker" | "native" | "desktop";
  os: string;
  arch: string;
  uptimeHours: number;
  host: { size: MachineSize; container: boolean; load: MachineLoad | null };
  organizations: number;
  people: { total: number; active1d: number; active7d: number; active30d: number };
  agents: number;
  computers: TelemetryComputer[];
  lastDay: {
    runs: number;
    toolCalls: number;
    /** People watching or controlling agents' desktops, and terminals open on agents' computers. */
    desktopMinutes: number;
    terminalMinutes: number;
    models: { provider: string; model: string; calls: number; inputTokens: number; outputTokens: number }[];
  };
}

export interface TelemetryComputer {
  kind: schema.MachineKind;
  os: string;
  arch: string;
  /** Null: its runner is older than protocol 22 and nobody else said. */
  size: MachineSize | null;
  agents: number;
  load: MachineLoad | null;
}

/** What only the server process knows about itself. */
export type TelemetryFacts = Pick<TelemetryReport, "version" | "edition" | "install" | "os" | "arch"> & {
  host: { size: MachineSize; container: boolean };
};

const DAY_MS = 24 * 3600_000;
const ARCHES = new Set(["x64", "arm64", "arm", "ia32", "ppc64", "s390x", "riscv64", "loong64"]);
/** Ids, not text: anything else (a name someone typed) is reported as `other`. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,79}$/;
const MAX_MODELS = 50;

/** agentes.chat's own servers: their report always goes out, and nobody there has the switch. */
export function isAgentesCloud(publicUrl: string) {
  const host = new URL(publicUrl).hostname;
  return host === "agentes.chat" || host.endsWith(".agentes.chat");
}

/** Whether the report goes out: always on agentes.chat's own servers; elsewhere unless `TELEMETRY=off` or the switch is off. */
export function telemetrySends(config: { TELEMETRY: "on" | "off"; PUBLIC_URL: string }, enabled: boolean) {
  return isAgentesCloud(config.PUBLIC_URL) || (config.TELEMETRY === "on" && enabled);
}

/** The installation's row, made on first use with its random id. */
export async function telemetryState(db: Database) {
  await db.insert(instanceTelemetry).values({}).onConflictDoNothing();
  const [row] = await db.select().from(instanceTelemetry).where(eq(instanceTelemetry.id, 1));
  if (!row) throw new Error("instance_telemetry has no row");
  return row;
}

/** At boot: the uptime counts from now. */
export async function markServerStarted(db: Database, now = new Date()) {
  await db
    .insert(instanceTelemetry)
    .values({ startedAt: now })
    .onConflictDoUpdate({ target: instanceTelemetry.id, set: { startedAt: now } });
}

/** The owner's switch in Settings. */
export async function setTelemetryEnabled(db: Database, enabled: boolean) {
  await db
    .insert(instanceTelemetry)
    .values({ enabled })
    .onConflictDoUpdate({ target: instanceTelemetry.id, set: { enabled } });
}

/** The host's last day as its newest sample leaves it; kept in the row so `agentes telemetry` prints it too. */
export async function saveHostLoad(db: Database, load: MachineLoad | null, now = new Date()) {
  if (!load) return;
  const hostLoad = { ...load, at: now.toISOString() };
  await db
    .insert(instanceTelemetry)
    .values({ hostLoad })
    .onConflictDoUpdate({ target: instanceTelemetry.id, set: { hostLoad } });
}

/** A load summary from over a day ago says nothing about the last day. */
const fresh = (load: schema.MachineLoadRecord | null, now: Date): MachineLoad | null => {
  if (!load || now.getTime() - Date.parse(load.at) > DAY_MS) return null;
  const { at: _at, ...rest } = load;
  return rest;
};
const int = (v: unknown) => Math.round(Number(v ?? 0));
const archOf = (arch: string) => (ARCHES.has(arch) ? arch : "other");

/** The next report, exactly as it would be sent now. */
export async function buildTelemetryReport(
  db: Database,
  facts: TelemetryFacts,
  now = new Date(),
): Promise<TelemetryReport> {
  const state = await telemetryState(db);
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const day = since(1);

  const [counts] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select
        (select count(*) from organizations) as organizations,
        (select count(*) from users) as people,
        (select count(*) from agents where archived_at is null) as agents,
        (select count(*) from agent_runs where created_at >= ${day}) as runs,
        (select count(*) from agent_run_steps where kind = 'tool_call' and created_at >= ${day}) as tool_calls,
        (select coalesce(sum((details->>'seconds')::numeric), 0) from audit_log
          where action in ('desktop.watched', 'desktop.controlled') and created_at >= ${day}) as desktop_seconds,
        (select coalesce(sum((details->>'seconds')::numeric), 0) from audit_log
          where action = 'terminal.session' and created_at >= ${day}) as terminal_seconds`),
  );
  // Active: their app was open (a socket to a workspace) or their session was used.
  const [active] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select
        count(*) filter (where seen >= ${since(1)}) as d1,
        count(*) filter (where seen >= ${since(7)}) as d7,
        count(*) filter (where seen >= ${since(30)}) as d30
      from (
        select user_id, max(at) as seen from (
          select user_id, last_seen_at as at from organization_members where last_seen_at is not null
          union all
          select user_id, updated_at from sessions
        ) seen group by user_id
      ) people`),
  );
  const machines = rowsOf<{
    kind: schema.MachineKind;
    os: string;
    arch: string;
    size: MachineSize | null;
    specs: MachineSize | null;
    load: schema.MachineLoadRecord | null;
    agents: unknown;
  }>(
    await db.execute(sql`
      select m.kind, m.os, m.arch, m.size, p.specs, m.load,
        (select count(*) from agents a where a.machine_id = m.id and a.archived_at is null) as agents
      from machines m
      left join machine_provisioning p on m.kind = 'managed' and p.org_id = m.org_id
      where m.deleted_at is null and m.last_seen_at is not null
      order by m.created_at`),
  );
  const computers: TelemetryComputer[] = [];
  let host: TelemetryComputer | undefined;
  for (const m of machines) {
    const c = {
      kind: m.kind,
      os: m.os,
      arch: archOf(m.arch),
      size: m.size ?? m.specs ?? null,
      agents: int(m.agents),
      load: fresh(m.load, now),
    };
    // The server's own computer has a row for each organization it serves: one machine all the same.
    if (m.kind === "host" && host) {
      host.agents += c.agents;
      host.size ??= c.size;
      host.load ??= c.load;
      continue;
    }
    if (m.kind === "host") host = c;
    computers.push(c);
  }
  const models = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select provider, model, count(*) as calls,
        sum(input_tokens + cache_read_tokens + cache_write_tokens) as input_tokens, sum(output_tokens) as output_tokens
      from usage_records
      where created_at >= ${day} and kind <> 'sandbox'
      group by provider, model
      order by calls desc, provider, model
      limit ${MAX_MODELS}`),
  );

  return {
    report: 1,
    instance: state.instanceId,
    version: facts.version,
    edition: facts.edition,
    install: facts.install,
    os: facts.os,
    arch: archOf(facts.arch),
    uptimeHours: Math.max(0, Math.round((now.getTime() - state.startedAt.getTime()) / 360_000) / 10),
    host: { size: facts.host.size, container: facts.host.container, load: fresh(state.hostLoad, now) },
    organizations: int(counts?.organizations),
    people: {
      total: int(counts?.people),
      active1d: int(active?.d1),
      active7d: int(active?.d7),
      active30d: int(active?.d30),
    },
    agents: int(counts?.agents),
    computers,
    lastDay: {
      runs: int(counts?.runs),
      toolCalls: int(counts?.tool_calls),
      desktopMinutes: int(Number(counts?.desktop_seconds) / 60),
      terminalMinutes: int(Number(counts?.terminal_seconds) / 60),
      models: models.map((r) => {
        const provider = String(r.provider);
        const model = String(r.model).toLowerCase();
        return {
          provider: PROVIDER_ID.test(provider) ? provider : "other",
          model: MODEL_ID.test(model) ? model : "other",
          calls: int(r.calls),
          inputTokens: int(r.input_tokens),
          outputTokens: int(r.output_tokens),
        };
      }),
    },
  };
}
