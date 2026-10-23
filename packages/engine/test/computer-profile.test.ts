import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  computerProfile,
  computerTurnProfile,
  createAgentRuns,
  insertMessage,
  type RoutineBrief,
  runAuthority,
  runPermissionPrompt,
} from "../src";
import { type BrainTurnRequest, CodexBrain, type ComputerBrainLink } from "../src/brains/codex";
import type { BrainEvent, BrainTurn } from "../src/brains/types";
import { type Fixture, setup } from "./fixtures";

/**
 * ADR 0053 §3: a computer turn's permission profile follows who is behind its
 * run, on Claude Code and Codex alike; Codex never runs on a runner too old
 * to keep it within that profile.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const message = (author: "person" | "agent", body: string, meta: Record<string, unknown> = {}) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author:
      author === "person"
        ? { type: "person", userId: f.owner.id }
        : { type: "agent", agentId: f.agent.id, runId: null, hop: 1 },
    body,
    meta,
  });
const runFor = async (messageId: string, options: { background?: boolean } = {}) => {
  const [m] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
  if (!m) throw new Error("no message");
  const [run] = await f.db.transaction((tx) =>
    createAgentRuns(tx, m as never, [f.agent.id], "mention", options.background ? { background: true } : {}),
  );
  if (!run) throw new Error("no run");
  return run;
};
const brief = (access: "read" | "act"): RoutineBrief => ({
  routineId: crypto.randomUUID(),
  routineRunId: crypto.randomUUID(),
  name: "Revisar PRs",
  creatorUserId: f.owner.id,
  deliverTo: { channelId: f.general.id, threadId: null },
  access,
  report: "when_new",
  trigger: "schedule",
  dueAt: new Date().toISOString(),
});
const profileOf = (runId: string) => computerTurnProfile(f.db, { orgId: f.org.id, runId });

describe("the profile follows who is behind the run", () => {
  test("rules: a person works; a routine works only with access act; unattended runs read", () => {
    expect(computerProfile({ kind: "person", personId: "p" })).toBe("work");
    expect(computerProfile({ kind: "routine", personId: null, brief: { ...briefShape, access: "act" } })).toBe("work");
    expect(computerProfile({ kind: "routine", personId: null, brief: { ...briefShape, access: "read" } })).toBe("plan");
    // A routine whose brief is missing (an older firing) only reads.
    expect(computerProfile({ kind: "routine", personId: null, brief: null })).toBe("plan");
    for (const reason of ["routine_report", "agent_note", "agent"] as const) {
      expect(computerProfile({ kind: "unattended", personId: null, reason })).toBe("plan");
    }
  });

  test("a routine that reads gets plan, one that acts gets work, a person's run work", async () => {
    f = await setup();
    const read = await message("person", "Confira a INBOX", { routineBrief: brief("read"), background: true });
    const readRun = await runFor(read.id, { background: true });
    expect(await profileOf(readRun.id)).toBe("plan");

    const act = await message("person", "Faça as issues", { routineBrief: brief("act"), background: true });
    const actRun = await runFor(act.id, { background: true });
    expect(await profileOf(actRun.id)).toBe("work");

    const ask = await message("person", "@dev olha os PRs");
    const personRun = await runFor(ask.id);
    expect(await profileOf(personRun.id)).toBe("work");
  });

  test("an unattended run reads until a person writes into it; a run that is gone reads", async () => {
    f = await setup();
    const report = await message("agent", "Erro novo no checkout", {
      notice: { kind: "routine_handoff", text: "Erro novo no checkout", from: "Routine «Sentry»", refs: {} },
    });
    const woken = await runFor(report.id);
    expect(await profileOf(woken.id)).toBe("plan");
    // Read again each turn: a person who wrote into it is behind it from then on.
    await f.db
      .update(schema.agentRuns)
      .set({ transcript: { ...(woken.transcript as Record<string, unknown>), steeredBy: f.owner.id } as never })
      .where(eq(schema.agentRuns.id, woken.id));
    expect(await profileOf(woken.id)).toBe("work");
    expect(await runAuthority(f.db, { ...woken, transcript: { steeredBy: f.owner.id } })).toMatchObject({
      kind: "person",
    });
    expect(await profileOf(crypto.randomUUID())).toBe("plan");
  });
});

const briefShape: RoutineBrief = {
  routineId: "r",
  routineRunId: "rr",
  name: "x",
  creatorUserId: null,
  deliverTo: { channelId: "c", threadId: null },
  access: "read",
  report: "when_new",
  trigger: "schedule",
  dueAt: "",
};

// ── Codex: the profile goes with the turn, never to a runner that can't keep it ──

function turn(): BrainTurn {
  return {
    runId: "0193aaaa-0000-7000-8000-000000000001",
    orgId: "org",
    agentId: "agent",
    channelId: "channel",
    threadRootId: null,
    system: "You are Dev.",
    messages: [{ role: "user", content: "check the inbox" }],
    tools: [],
    trigger: "check the inbox",
    session: { id: "0193aaaa-0000-7000-8000-00000000c0de", resume: false, machineId: "m1", cwd: "" },
  };
}

function link(protocol: number): ComputerBrainLink & { sent: BrainTurnRequest[] } {
  const sent: BrainTurnRequest[] = [];
  return {
    sent,
    async status() {
      return { online: true, execAllowed: true, protocol, executors: { codex: { version: "codex-cli 0.163.0" } } };
    },
    async turn(_machineId, request, { onEvent }) {
      sent.push(request);
      onEvent({ type: "done", text: "ok" });
    },
  };
}

const io = () => ({
  signal: new AbortController().signal,
  executeTool: async () => {
    throw new Error("computer brains don't execute tools in the engine");
  },
});

async function collect(it: AsyncIterable<BrainEvent>) {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("the server's rules for a run's prompts (Claude Code and Codex alike)", () => {
  const scope = { cwd: "/w/dev/repos/acme/app", folders: ["/w/dev/repos/acme/app", "/w/dev"], home: "/Users/w" };
  const ask = (tool_name: string, input: Record<string, unknown>) =>
    JSON.parse(runPermissionPrompt({ tool_name, input, scope }, { canRun: true })) as {
      behavior: string;
      message?: string;
    };
  test("secrets, inline code and writes outside its folders are refused; its own work is allowed", () => {
    expect(ask("Read", { file_path: "/Users/w/.ssh/id_ed25519" })).toMatchObject({ behavior: "deny" });
    expect(ask("Bash", { command: "cat ~/.aws/credentials" })).toMatchObject({ behavior: "deny" });
    const inline = ask("Bash", { command: "python3 -c 'import os'" });
    expect(inline.behavior).toBe("deny");
    expect(inline.message).toContain("runs code given inline");
    expect(ask("Write", { file_path: "/etc/hosts" }).behavior).toBe("deny");
    expect(ask("Bash", { command: "gh -R acme/app pr merge 3" }).behavior).toBe("deny");
    expect(ask("Bash", { command: "npm install" }).behavior).toBe("allow");
    expect(ask("Write", { file_path: "/w/dev/repos/acme/app/src/a.ts" }).behavior).toBe("allow");
  });
});

describe("Codex turns carry their profile", () => {
  test("a background plan turn: read-only profile and no process kept", async () => {
    const l = link(16);
    const brain = new CodexBrain({
      link: l,
      mcp: async () => ({ token: "t" }),
      permissions: async () => ({ mode: "plan", branchPrefix: "agentes/dev/" }),
      keepAlive: false,
    });
    expect(await collect(brain.run(turn(), io()))).toMatchObject([{ type: "done", text: "ok" }]);
    expect(l.sent[0]).toMatchObject({ permissions: { mode: "plan" }, keepAlive: false });
  });

  test("a runner older than the profiles fails the turn (runner_outdated) instead of running with more power", async () => {
    const l = link(15);
    const brain = new CodexBrain({
      link: l,
      mcp: async () => ({ token: "t" }),
      permissions: async () => ({ mode: "work", branchPrefix: "agentes/dev/" }),
    });
    expect(await collect(brain.run(turn(), io()))).toMatchObject([
      { type: "error", code: "runner_outdated", retryable: true },
    ]);
    expect(l.sent).toHaveLength(0);
  });
});
