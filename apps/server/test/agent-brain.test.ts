import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type ServerFrame } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.5.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

interface Brain {
  agentId: string;
  brain: string;
  model: string | null;
  effectiveModel: string | null;
  fallback: boolean;
  computer: { machineId: string; name: string; online: boolean } | null;
  options: { kind: string; available: boolean; reason?: string; experimental: boolean; models: { value: string }[] }[];
  canEdit: boolean;
}

interface MissionBrain {
  brain: string | null;
  model: string | null;
  effectiveBrain: string;
  effectiveModel: string | null;
  canSetBrain: boolean;
  canSetModel: boolean;
}

/** A connected runner that starts every task it is asked to. */
function fakeRunner() {
  const hub = t.engine.machineHub;
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request") return;
      setTimeout(() => {
        const ok = (data: unknown) => void reply({ type: "result", id: frame.id, ok: true, data });
        if (frame.op === "task.start") {
          return ok({
            taskId: frame.taskId,
            pid: 7,
            startedAt: new Date().toISOString(),
            cwd: frame.cwd ?? "",
            command: "claude -p",
          });
        }
        if (frame.op === "read") return ok({ base64: null, size: 0 });
        return ok({ size: 0 });
      }, 1);
    },
    close() {},
  });
  return {
    hello: (token: string) => hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, exec: true })),
  };
}

async function workspace() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const member = browser(t);
  await signUp(member, "bia@example.com");
  const { url } = (await (
    await api("/invitations", { json: { email: "bia@example.com", role: "member" } })
  ).json()) as { url: string };
  await member(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  const asBia = (path: string, init?: Parameters<typeof member>[1]) =>
    member(`/api/app/organizations/${seeded.orgId}${path}`, init);
  return { ...seeded, api, asBia };
}

async function pairMac(api: (path: string, init?: Parameters<ReturnType<typeof browser>>[1]) => Promise<Response>) {
  const pairing = (await (await api("/machines/pairings", { json: { name: "mac" } })).json()) as { code: string };
  return (await (
    await t.app.request("/api/machines/pair", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ code: pairing.code, ...RUNNER, exec: true }),
    })
  ).json()) as { machineId: string; token: string };
}

test("agent brain: defaults, who may, the plan warning, what the computer has, model and fallback", async () => {
  const { api, asBia, agentId } = await workspace();

  // Defaults: the model (API), fallback on, nothing to offer without a computer.
  const first = await api(`/agents/${agentId}/brain`);
  expect(first.status).toBe(200);
  const fresh = (await first.json()) as Brain;
  expect(fresh).toMatchObject({ brain: "model", model: null, effectiveModel: null, fallback: true, computer: null });
  expect(fresh.options.map((o) => [o.kind, o.available, o.reason ?? null])).toEqual([
    ["model", true, null],
    ["claude_code", false, "no_computer"],
    ["codex", false, "no_computer"],
  ]);
  expect(fresh.options.find((o) => o.kind === "codex")?.experimental).toBe(true);
  expect(fresh.options.find((o) => o.kind === "claude_code")?.models.map((m) => m.value)).toEqual([
    "opus",
    "sonnet",
    "haiku",
  ]);
  const noComputer = await api(`/agents/${agentId}/brain`, {
    method: "PUT",
    json: { brain: "claude_code", acceptPlanTerms: true },
  });
  expect(noComputer.status).toBe(409);
  expect(((await noComputer.json()) as { error: { code: string } }).error.code).toBe("brain.no_computer");

  // A member neither sees nor changes it.
  expect((await asBia(`/agents/${agentId}/brain`)).status).toBe(403);
  expect((await asBia(`/agents/${agentId}/brain`, { method: "PUT", json: { fallback: false } })).status).toBe(403);

  // With a computer: Claude Code (a runner that doesn't list its CLIs is assumed to have it), no Codex.
  const mac = await pairMac(api);
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: mac.machineId } });
  const withMac = (await (await api(`/agents/${agentId}/brain`)).json()) as Brain;
  expect(withMac.computer?.name).toBe("mac");
  expect(withMac.options.find((o) => o.kind === "claude_code")?.available).toBe(true);
  expect(withMac.options.find((o) => o.kind === "codex")).toMatchObject({ available: false, reason: "not_installed" });

  // The warning must be confirmed; never blocked once it is.
  const unconfirmed = await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "claude_code" } });
  expect(unconfirmed.status).toBe(400);
  expect(((await unconfirmed.json()) as { error: { code: string } }).error.code).toBe("brain.terms_required");
  expect(
    (await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "codex", acceptPlanTerms: true } })).status,
  ).toBe(409);
  const chosen = await api(`/agents/${agentId}/brain`, {
    method: "PUT",
    json: { brain: "claude_code", model: "Opus", acceptPlanTerms: true },
  });
  expect(chosen.status).toBe(200);
  expect(await chosen.json()).toMatchObject({ brain: "claude_code", model: "opus", effectiveModel: "opus" });

  // Model and fallback change without confirming again; bad models are refused.
  const fallbackOff = await api(`/agents/${agentId}/brain`, { method: "PUT", json: { fallback: false } });
  expect(fallbackOff.status).toBe(200);
  expect(await fallbackOff.json()).toMatchObject({ brain: "claude_code", model: "opus", fallback: false });
  const sonnet = (await (
    await api(`/agents/${agentId}/brain`, { method: "PUT", json: { model: null } })
  ).json()) as Brain;
  expect(sonnet).toMatchObject({ model: null, effectiveModel: "sonnet" });
  expect((await api(`/agents/${agentId}/brain`, { method: "PUT", json: { model: "gpt-6-sol" } })).status).toBe(400);
  expect((await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "robot" } })).status).toBe(400);

  // Persisted, and audited.
  const [row] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  expect(row).toMatchObject({ brain: "claude_code", brainModel: null, brainFallback: false });
  const audit = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent.brain"));
  expect(audit.length).toBe(3);
  expect(JSON.stringify(audit.map((a) => a.details))).toContain('"acceptedPlanTerms":true');

  // Codex appears once the computer has a recent one; any model name is taken as typed.
  await t.db
    .update(schema.machines)
    .set({
      executors: { claude: { version: "2.1.0" }, codex: { version: "codex-cli 0.170.0" }, detectedAt: "2026-10-17" },
    })
    .where(eq(schema.machines.id, mac.machineId));
  const codex = await api(`/agents/${agentId}/brain`, {
    method: "PUT",
    json: { brain: "codex", model: "gpt-6.1-codex", acceptPlanTerms: true },
  });
  expect(codex.status).toBe(200);
  expect(await codex.json()).toMatchObject({ brain: "codex", model: "gpt-6.1-codex" });

  // Back to the API: no confirmation, the model is cleared.
  const back = await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "model" } });
  expect(await back.json()).toMatchObject({ brain: "model", model: null, fallback: false });
});

test("mission brain: from the executor by default; the brain before Start, the model any time; who may", async () => {
  const { api, asBia, agentId, channelId } = await workspace();
  const mac = await pairMac(api);
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: mac.machineId } });
  await fakeRunner().hello(mac.token);
  const mission = (await (
    await api("/missions", { json: { agentId, channelId, goal: "Build our mobile app", title: "Mobile app" } })
  ).json()) as { id: string; executor: string };
  expect(mission.executor).toBe("claude");

  const read = await api(`/missions/${mission.id}/brain`);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({
    brain: null,
    model: null,
    effectiveBrain: "claude_code",
    effectiveModel: "sonnet",
    canSetBrain: true,
    canSetModel: true,
  });

  // The agent's own Claude Code model carries over to its missions.
  await t.db
    .update(schema.agents)
    .set({ brain: "claude_code", brainModel: "haiku" })
    .where(eq(schema.agents.id, agentId));
  expect(((await (await api(`/missions/${mission.id}/brain`)).json()) as MissionBrain).effectiveModel).toBe("haiku");

  const opus = await api(`/missions/${mission.id}/brain`, { method: "PUT", json: { model: "opus" } });
  expect(opus.status).toBe(200);
  expect(await opus.json()).toMatchObject({ model: "opus", effectiveModel: "opus" });
  expect((await api(`/missions/${mission.id}/brain`, { method: "PUT", json: { model: "o p u s" } })).status).toBe(400);
  expect((await api(`/missions/${mission.id}/brain`, { method: "PUT", json: { brain: "codex" } })).status).toBe(409);

  // A member who isn't taking part can read it, not change it.
  const bia = await asBia(`/missions/${mission.id}/brain`, { method: "PUT", json: { model: "haiku" } });
  expect([403, 404]).toContain(bia.status);

  // Started: the brain is locked, the model still changes.
  await t.db.update(schema.missions).set({ status: "active" }).where(eq(schema.missions.id, mission.id));
  const locked = await api(`/missions/${mission.id}/brain`, { method: "PUT", json: { brain: "model" } });
  expect(locked.status).toBe(409);
  expect(((await locked.json()) as { error: { code: string } }).error.code).toBe("mission.wrong_status");
  const active = (await (await api(`/missions/${mission.id}/brain`)).json()) as MissionBrain;
  expect(active).toMatchObject({ canSetBrain: false, canSetModel: true });
  const sonnet = await api(`/missions/${mission.id}/brain`, { method: "PUT", json: { model: "sonnet" } });
  expect(await sonnet.json()).toMatchObject({ model: "sonnet", effectiveBrain: "claude_code" });

  const [row] = await t.db.select().from(schema.missions).where(eq(schema.missions.id, mission.id));
  expect(row).toMatchObject({ brain: null, brainModel: "sonnet" });
  const events = await t.db.select().from(schema.missionEvents).where(eq(schema.missionEvents.missionId, mission.id));
  expect(events.filter((e) => e.kind === "brain_changed").length).toBe(2);
});
