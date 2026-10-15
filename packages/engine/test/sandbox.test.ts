import { afterEach, describe, expect, test } from "bun:test";
import { createFakeSandboxProvider, type ExecRequest, type FakeSandboxProvider, orgTopic } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  applyOrgNetwork,
  createAgent,
  createOrganization,
  deleteAgentComputer,
  drainOutbox,
  ForbiddenError,
  getAgentComputer,
  grantKey,
  grantScopes,
  importSkillZip,
  NotFoundError,
  openDm,
  postPersonMessage,
  setAgentAccess,
  setAgentSkills,
  startAgentComputer,
  stopAgentComputer,
  type ToolContext,
  toolAccess,
  updateSandboxSettings,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SANDBOX = [{ connectionId: null, scope: "sandbox:run" }];

/** A real run (steps and usage rows reference it) in #general, in a thread of its own unless given. */
async function runCtx(threadRootId?: string, channelId?: string): Promise<ToolContext> {
  const channel = channelId ?? f.general.id;
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channel, {
    body: "@dev oi",
    ...(threadRootId ? { threadId: threadRootId } : {}),
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, msg.id));
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: channel,
    threadRootId: run.threadRootId,
    triggerMessageId: msg.id,
  };
}

const call = async (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
  const outcome = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
  if (outcome?.type !== "result") throw new Error(`expected a result, got ${outcome?.type}`);
  return outcome.output;
};

function sandboxSetup(exec?: NonNullable<Parameters<typeof createFakeSandboxProvider>[0]>["exec"]) {
  const provider: FakeSandboxProvider = createFakeSandboxProvider(exec ? { exec } : {});
  return provider;
}

describe("access", () => {
  test("off by default, not part of 'all tools', granted only explicitly", async () => {
    const provider = sandboxSetup();
    f = await setup({ sandbox: provider, reply: () => ({ chunks: ["ok"] }) });
    const ctx = await runCtx();
    expect((await f.tools?.list(ctx))?.map((t) => t.name)).not.toContain("run_code");
    expect(await call(ctx, "run_code", { language: "python", code: "print(1)" })).toMatchObject({
      isError: true,
      content: "Not allowed: this agent lacks the scope sandbox:run",
    });
    // "All tools" doesn't include running code.
    const all = new Set([grantKey(null, "*")]);
    expect(toolAccess(all, { name: "run_code", scope: "sandbox:run", connectionId: null })).toBe("off");
    expect(toolAccess(all, { name: "create_issue", scope: "issues:write", connectionId: null })).toBe("inherited");
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, {
      all: true,
      connectors: {},
      scopes: [],
      tools: { allow: [], deny: [] },
    });
    expect((await f.tools?.list(ctx))?.map((t) => t.name)).not.toContain("run_code");
    expect(provider.calls).toEqual([]);
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    expect((await f.tools?.list(ctx))?.map((t) => t.name)).toContain("run_code");
  });
});

describe("one computer per agent", () => {
  test("created on first use and shared by every conversation of the agent; no secrets go in", async () => {
    const requests: ExecRequest[] = [];
    const provider = sandboxSetup((req) => {
      requests.push(req);
      return { exitCode: 0, stdout: "2\n", stderr: "", timedOut: false };
    });
    f = await setup({ sandbox: provider, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const a = await runCtx();
    const out = await call(a, "run_code", { language: "python", code: "print(1+1)" });
    expect(out).toMatchObject({ isError: false });
    expect(out.content).toStartWith("run_code python: exit code 0");
    expect(out.content).toContain("stdout:\n2");
    await call(await runCtx(a.threadRootId), "write_file", { path: "notas.md", content: "oi" });
    // Another thread and a DM: the same machine, with the same files.
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const read = await call(await runCtx(undefined, dm.id), "read_file", { path: "notas.md" });
    expect(read.content).toContain("oi");
    await call(await runCtx(), "list_files", {});
    const creates = provider.calls.filter((c) => c.op === "create");
    expect(creates).toHaveLength(1);
    expect(Object.keys(creates[0]?.spec ?? {}).sort()).toEqual([
      "allowDomains",
      "autoArchiveMinutes",
      "autoStopMinutes",
      "key",
      "labels",
      "network",
    ]);
    expect(creates[0]?.spec).toMatchObject({ allowDomains: [], autoStopMinutes: 10, autoArchiveMinutes: 7 * 24 * 60 });
    expect(JSON.stringify(creates[0]?.spec)).not.toContain("sk-ant");
    expect(requests.every((r) => !("env" in r) && !("envs" in r))).toBe(true);
    expect(requests[0]?.command).toMatch(/^timeout -k 5 60 python3 '\.agentes\/run-\d+\.py'$/);
    const rows = await f.db.select().from(schema.sandboxes);
    expect(rows.map((r) => [r.key, r.agentId])).toEqual([[`agent:${f.agent.id}`, f.agent.id]]);
  });

  test("stopped or archived: started again with its files; lost by the provider: a new one, and the agent is told", async () => {
    const provider = sandboxSetup();
    f = await setup({ sandbox: provider, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    await call(await runCtx(), "write_file", { path: "a.txt", content: "a" });
    const [row] = await f.db.select().from(schema.sandboxes);
    provider.setState(row?.providerId ?? "", "archived");
    expect((await call(await runCtx(), "read_file", { path: "a.txt" })).content).toContain("a");
    expect(provider.calls.filter((c) => c.op === "start")).toHaveLength(1);
    provider.setState(row?.providerId ?? "", "destroyed");
    const after = await call(await runCtx(), "list_files", {});
    expect(after.content).toStartWith("Note: your computer was lost by the provider");
    expect(provider.calls.filter((c) => c.op === "create")).toHaveLength(2);
    expect((await f.db.select().from(schema.sandboxes)).filter((r) => r.deletedAt === null)).toHaveLength(1);
    const audit = await f.db.select().from(schema.auditLog);
    expect(audit.some((x) => x.action === "sandbox.recreated")).toBe(true);
  });

  test("org allowlist goes to the provider; other agents get their own computer", async () => {
    const provider = sandboxSetup();
    f = await setup({ sandbox: provider, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    await updateSandboxSettings(f.db, f.owner.id, f.org.id, { allowDomains: ["PyPI.org", "*.npmjs.org"] });
    await expect(updateSandboxSettings(f.db, f.owner.id, f.org.id, { allowDomains: ["http://x"] })).rejects.toThrow(
      "Not a domain",
    );
    await call(await runCtx(), "write_file", { path: "a.txt", content: "a" });
    expect(provider.calls[0]?.spec?.allowDomains).toEqual(["pypi.org", "*.npmjs.org"]);
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      {
        name: "Ops",
        handle: "ops",
        role: "",
        instructions: "",
        credentialId: f.credential.id,
      },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: other.id });
    await grantScopes(f.db, f.org.id, other.id, SANDBOX);
    const ctx = { ...(await runCtx()), agentId: other.id };
    expect((await call(ctx, "read_file", { path: "a.txt" })).isError).toBe(true);
    expect(provider.calls.filter((c) => c.op === "create")).toHaveLength(2);
  });
});

describe("limits and cost", () => {
  test("usage is recorded per agent and org; budget and the daily cap block before running", async () => {
    const provider = sandboxSetup();
    f = await setup({ sandbox: provider, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const ctx = await runCtx();
    await call(ctx, "run_code", { language: "node", code: "1" });
    const usage = (await f.db.select().from(schema.usageRecords)).filter((u) => u.kind === "sandbox");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ orgId: f.org.id, agentId: f.agent.id, runId: ctx.runId, provider: "fake" });
    expect(usage[0]?.costNanoUsd).toBeGreaterThan(0);
    const [box] = await f.db.select().from(schema.sandboxes);
    expect(box?.billedSeconds).toBeGreaterThanOrEqual(1);
    expect(box?.costNanoUsd).toBe(usage[0]?.costNanoUsd);

    // Budget almost used: refused before anything runs.
    await f.db.update(schema.agents).set({ monthlyBudgetNanoUsd: 1000 }).where(eq(schema.agents.id, f.agent.id));
    const execs = provider.calls.filter((c) => c.op === "exec").length;
    const refused = await call(ctx, "run_code", { language: "node", code: "1" });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toContain("monthly budget");
    expect(provider.calls.filter((c) => c.op === "exec")).toHaveLength(execs);

    await f.db.update(schema.agents).set({ monthlyBudgetNanoUsd: null }).where(eq(schema.agents.id, f.agent.id));
    await updateSandboxSettings(f.db, f.owner.id, f.org.id, { dailyMinutes: 0 });
    expect((await call(ctx, "run_code", { language: "node", code: "1" })).content).toContain("computer minutes");
    await updateSandboxSettings(f.db, f.owner.id, f.org.id, { dailyMinutes: 60, enabled: false });
    expect((await f.tools?.list(ctx))?.map((t) => t.name)).not.toContain("run_code");
  });

  test("timeouts and long output are cut; approval when the org asks for it", async () => {
    const provider = sandboxSetup((req) =>
      req.command.includes("python3")
        ? { exitCode: 124, stdout: "", stderr: "", timedOut: true }
        : { exitCode: 0, stdout: "x".repeat(50_000), stderr: "", timedOut: false },
    );
    f = await setup({ sandbox: provider, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const ctx = await runCtx();
    const slow = await call(ctx, "run_code", { language: "python", code: "while True: pass", timeout_seconds: 5 });
    expect(slow).toMatchObject({ isError: true });
    expect(slow.content).toStartWith("run_code python: timed out after 5 s");
    expect(provider.calls.find((c) => c.op === "exec")?.request).toMatchObject({ timeoutSeconds: 15 });
    const long = await call(ctx, "run_code", { language: "bash", code: "yes x" });
    expect(long.content.length).toBeLessThan(21_000);
    expect(long.content).toContain("characters cut");

    await updateSandboxSettings(f.db, f.owner.id, f.org.id, { requireApproval: true });
    const outcome = await f.tools?.invoke(await runCtx(), {
      toolUseId: crypto.randomUUID(),
      name: "run_code",
      input: { language: "bash", code: "echo oi" },
    });
    expect(outcome?.type).toBe("approval");
  });
});

describe("what the agent is running", () => {
  test("the activity shows the code (secrets masked); output streams live, capped; the step keeps it", async () => {
    const provider = sandboxSetup(() => ({
      exitCode: 0,
      stdout: `${"x".repeat(100_000)}token sk-ant-abcdefghijklmnop`,
      stderr: "warn",
      timedOut: false,
    }));
    f = await setup({
      sandbox: provider,
      reply: (req) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (last.includes("tool_result")) return { chunks: ["Rodei."] };
        return {
          chunks: [],
          toolUses: [
            {
              name: "run_code",
              input: { language: "python", code: 'key = "sk-ant-abcdefghijklmnop"\nprint(1)' },
            },
          ],
        };
      },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const events = f.listen(f.general.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev roda isso",
    });
    await drainOutbox(f.db, f.handlers);
    await Bun.sleep(5);
    const start = events.find((e) => e.type === "agent.tool" && (e as { tool?: string }).tool === "run_code") as
      | { toolUseId?: string; code?: { language: string; source: string } }
      | undefined;
    expect(start?.code?.language).toBe("python");
    expect(start?.code?.source).toContain("print(1)");
    expect(start?.code?.source).not.toContain("sk-ant-abcdefghijklmnop");
    const out = events.filter((e) => e.type === "agent.tool.output") as unknown as {
      stream: string;
      text: string;
      toolUseId?: string;
      threadId: string | null;
    }[];
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((o) => o.toolUseId === start?.toolUseId && o.threadId !== null)).toBe(true);
    const streamed = out.map((o) => o.text).join("");
    expect(streamed.length).toBeLessThan(66 * 1024);
    expect(streamed).toContain("mais saída");
    expect(out.some((o) => o.stream === "stderr" && o.text.includes("warn"))).toBe(true);
    // After the fact: the call (with the code) and the result (exit code, output) are in the run's steps.
    const steps = await f.db.select().from(schema.agentRunSteps);
    const callStep = steps.find((s) => s.kind === "tool_call")?.data as { input?: { code?: string } };
    expect(callStep?.input?.code).toContain("print(1)");
    const result = steps.find((s) => s.kind === "tool_result")?.data as {
      content: string;
      data?: { exitCode?: number };
    };
    expect(result.content).toStartWith("run_code python: exit code 0");
    expect(result.data?.exitCode).toBe(0);
  });
});

describe("turning the computer on and off from the chat", () => {
  test("computer_status, computer_start (creates it), computer_stop (files kept), audited as the agent", async () => {
    const provider = sandboxSetup();
    f = await setup({ sandbox: provider, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const ctx = await runCtx();
    expect((await call(ctx, "computer_status", {})).content).toStartWith("Status: none");
    const on = await call(ctx, "computer_start", {});
    expect(on.isError).toBeFalsy();
    expect(on.content).toStartWith("Your computer is running.");
    expect(provider.calls.filter((c) => c.op === "create")).toHaveLength(1);
    await call(ctx, "write_file", { path: "a.txt", content: "a" });
    const off = await call(ctx, "computer_stop", {});
    expect(off.content).toBe("Your computer is stopped; files kept.");
    const [row] = await f.db.select().from(schema.sandboxes);
    expect(row?.status).toBe("stopped");
    const audit = (await f.db.select().from(schema.auditLog)).find((a) => a.action === "sandbox.stopped");
    expect(audit).toMatchObject({ actorType: "agent", actorId: f.agent.id });
    expect((await call(ctx, "read_file", { path: "a.txt" })).content).toContain("a"); // starts again, same files
  });
});

describe("network mode", () => {
  test("open internet: new computers get it; running ones switch in place; stopped ones on next start", async () => {
    const provider = sandboxSetup();
    f = await setup({ sandbox: provider, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const deps = f.sandboxDeps as NonNullable<typeof f.sandboxDeps>;
    // Blocked by default: the agent reads it in run_code's description.
    const ctx = await runCtx();
    expect((await f.tools?.list(ctx))?.find((t) => t.name === "run_code")?.description).toContain("No internet access");
    await call(ctx, "write_file", { path: "a.txt", content: "a" });
    expect(provider.calls[0]?.spec?.network).toBe("blocked");

    await expect(updateSandboxSettings(f.db, f.owner.id, f.org.id, { network: "allowlist" })).rejects.toMatchObject({
      code: "sandbox.allowlist_empty",
    });
    const member = await addMember(f.db, f.org.id, "member", "bia");
    await expect(updateSandboxSettings(f.db, member.id, f.org.id, { network: "open" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await updateSandboxSettings(f.db, f.owner.id, f.org.id, { network: "open" })).network).toBe("open");
    expect(await applyOrgNetwork(deps, f.org.id)).toEqual({ applied: 1, later: 0 });
    expect(provider.calls.filter((c) => c.op === "network").map((c) => c.network?.mode)).toEqual(["open"]);
    const [row] = await f.db.select().from(schema.sandboxes);
    expect(row?.network).toBe("open");
    expect((await f.tools?.list(ctx))?.find((t) => t.name === "run_code")?.description).toContain(
      "open internet access",
    );

    // Stopped: nothing now; applied when it starts again.
    provider.setState(row?.providerId ?? "", "stopped");
    await updateSandboxSettings(f.db, f.owner.id, f.org.id, { network: "allowlist", allowDomains: ["pypi.org"] });
    expect(await applyOrgNetwork(deps, f.org.id)).toEqual({ applied: 0, later: 1 });
    await call(await runCtx(), "list_files", {});
    const last = provider.calls.filter((c) => c.op === "network").at(-1);
    expect(last?.network).toEqual({ mode: "allowlist", allowDomains: ["pypi.org"] });
    expect(provider.calls.filter((c) => c.op === "create")).toHaveLength(1); // same machine, files kept
  });

  test("the migration maps existing settings: domains = allowlist, none = blocked", async () => {
    f = await setup();
    const zed = await addUser(f.db, "zed");
    const { organization } = await createOrganization(f.db, zed.id, { name: "Outra" });
    await f.db.insert(schema.orgSandboxSettings).values([
      { orgId: f.org.id, allowDomains: ["pypi.org"], network: "blocked" },
      { orgId: organization.id, allowDomains: [], network: "blocked" },
    ]);
    const file = await Bun.file(new URL("../../db/migrations/0030_sandbox_network.sql", import.meta.url)).text();
    const update =
      file
        .split("--> statement-breakpoint")
        .find((s) => s.includes("UPDATE"))
        ?.trim() ?? "";
    await f.db.execute(sql.raw(update));
    const rows = await f.db.select().from(schema.orgSandboxSettings);
    expect(Object.fromEntries(rows.map((r) => [r.orgId, r.network]))).toEqual({
      [f.org.id]: "allowlist",
      [organization.id]: "blocked",
    });
  });

  test("with open internet a network failure is explained as the site, not a block", async () => {
    const provider = sandboxSetup(() => ({
      exitCode: 6,
      stdout: "",
      stderr: "curl: (6) Could not resolve host: nao-existe.example",
      timedOut: false,
    }));
    f = await setup({ sandbox: provider, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    await updateSandboxSettings(f.db, f.owner.id, f.org.id, { network: "open" });
    const out = await call(await runCtx(), "run_code", { language: "bash", code: "curl https://nao-existe.example" });
    expect(out.content).toContain("tem internet liberada");
    expect(out.content).not.toContain("sem internet:");
  });
});

describe("blocked network", () => {
  test("a DNS or connection failure says plainly there's no internet, and where to allow a domain", async () => {
    const provider = sandboxSetup(() => ({
      exitCode: 6,
      stdout: "",
      stderr: "curl: (6) Could not resolve host: example.com",
      timedOut: false,
    }));
    f = await setup({ sandbox: provider, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const out = await call(await runCtx(), "run_code", { language: "bash", code: "curl https://example.com" });
    expect(out.content).toContain("sem internet");
    expect(out.content).toContain("Configurações → Sandbox");
    expect(out.content).not.toMatch(/permiss(ão|ões) negada/i);
  });
});

describe("Drive and skills", () => {
  test("export a sandbox file to the Drive (new and as a version), import one back", async () => {
    const provider = sandboxSetup();
    f = await setup({ sandbox: provider, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const ctx = await runCtx();
    await call(ctx, "write_file", { path: "out/vendas.csv", content: 'mês,total\njan,"1,5"\n' });
    const saved = await call(ctx, "export_file", { path: "out/vendas.csv", title: "Vendas" });
    expect(saved.isError).toBeFalsy();
    const [table] = await f.db.select().from(schema.artifacts);
    expect(table).toMatchObject({ kind: "table", title: "Vendas", channelId: f.general.id });
    expect(saved.data).toEqual({ artifact: { id: table?.id, version: 1 } });
    await call(ctx, "write_file", { path: "out/vendas.csv", content: "mês,total\nfev,2\n" });
    const v2 = await call(ctx, "export_file", { path: "out/vendas.csv", artifact_id: table?.id });
    expect(v2.content).toContain("version 2");
    expect((await call(ctx, "export_file", { path: "out/x.bin" })).isError).toBe(true);

    const imported = await call(ctx, "import_file", { artifact_id: table?.id });
    expect(imported.content).toContain("imports/vendas.csv");
    const box = [...provider.boxes.values()][0];
    expect(new TextDecoder().decode(box?.files.get("imports/vendas.csv"))).toBe("mês,total\r\nfev,2");
  });

  test("run_skill_script copies the skill and runs the script; read_skill_file still refuses it", async () => {
    const provider = sandboxSetup();
    f = await setup({ sandbox: provider, skillTools: true, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const md = "---\nname: graficos\ndescription: Faz gráficos.\n---\nRode scripts/plot.py.";
    const zip = await zipOf({ "SKILL.md": md, "scripts/plot.py": "print('plot')", "ref.md": "# ref" });
    const skill = await importSkillZip({ db: f.db, blobs: f.artifactDeps.blobs }, f.owner.id, f.org.id, zip);
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: skill.id, enabled: true }]);
    const ctx = await runCtx();
    expect((await call(ctx, "read_skill_file", { name: "graficos", path: "scripts/plot.py" })).isError).toBe(true);
    const out = await call(ctx, "run_skill_script", {
      skill: "graficos",
      path: "scripts/plot.py",
      args: ["--n", "it's"],
    });
    expect(out).toMatchObject({ isError: false });
    const box = [...provider.boxes.values()][0];
    expect([...(box?.files.keys() ?? [])].sort()).toEqual([
      ".skills/graficos/ref.md",
      ".skills/graficos/scripts/plot.py",
    ]);
    const exec = provider.calls.find((c) => c.op === "exec");
    expect(exec?.request?.command).toBe("timeout -k 5 60 python3 '.skills/graficos/scripts/plot.py' '--n' 'it'\\''s'");
    expect((await call(ctx, "run_skill_script", { skill: "graficos", path: "ref.md" })).isError).toBe(true);
  });
});

describe("the agent's computer API", () => {
  test("status, start, stop, delete: owner or admins only; other organizations see nothing", async () => {
    const provider = sandboxSetup((req) =>
      req.command.startsWith("du ")
        ? { exitCode: 0, stdout: "512\n", stderr: "", timedOut: false }
        : { exitCode: 0, stdout: "", stderr: "", timedOut: false },
    );
    f = await setup({ sandbox: provider, reply: () => ({ chunks: ["ok"] }) });
    const deps = { ...(f.sandboxDeps as NonNullable<typeof f.sandboxDeps>), pubsub: f.pubsub };
    const events: { type?: string; event?: Record<string, unknown> }[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e as (typeof events)[number]));
    const computerEvents = () =>
      events.filter((e) => e.event?.type === "agent.computer").map((e) => [e.event?.status, e.event?.step]);
    expect(await getAgentComputer(deps, f.owner.id, f.org.id, f.agent.id)).toEqual({
      status: "none",
      diskUsedGib: 0,
      costMonthUsd: 0,
      createdAt: null,
      lastUsedAt: null,
      target: { kind: "cloud" },
    });
    // Start returns at once; the job does the provider work and reports each step.
    expect(await startAgentComputer(deps, f.owner.id, f.org.id, f.agent.id)).toEqual({ status: "starting" });
    expect(provider.calls).toEqual([]);
    expect((await getAgentComputer(deps, f.owner.id, f.org.id, f.agent.id)).status).toBe("starting");
    await drainOutbox(f.db, f.handlers);
    expect(await getAgentComputer(deps, f.owner.id, f.org.id, f.agent.id)).toMatchObject({
      status: "running",
      diskUsedGib: 0.5,
      network: "blocked",
    });
    expect(await stopAgentComputer(deps, f.owner.id, f.org.id, f.agent.id)).toEqual({ status: "stopping" });
    await drainOutbox(f.db, f.handlers);
    expect((await getAgentComputer(deps, f.owner.id, f.org.id, f.agent.id)).status).toBe("stopped");
    await startAgentComputer(deps, f.owner.id, f.org.id, f.agent.id);
    await drainOutbox(f.db, f.handlers);
    expect((await getAgentComputer(deps, f.owner.id, f.org.id, f.agent.id)).status).toBe("running");
    expect(provider.calls.filter((c) => c.op === "create")).toHaveLength(1);
    await Bun.sleep(5);
    expect(computerEvents()).toEqual([
      ["starting", "creating"],
      ["starting", "creating"],
      ["running", "ready"],
      ["stopping", undefined],
      ["stopped", undefined],
      ["starting", "preparing"],
      ["starting", "preparing"],
      ["running", "ready"],
    ]);

    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(getAgentComputer(deps, bia.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    const zed = await addUser(f.db, "zed");
    const { organization } = await createOrganization(f.db, zed.id, { name: "Outra" });
    await expect(getAgentComputer(deps, zed.id, organization.id, f.agent.id)).rejects.toBeInstanceOf(NotFoundError);

    await deleteAgentComputer(deps, f.owner.id, f.org.id, f.agent.id);
    expect((await getAgentComputer(deps, f.owner.id, f.org.id, f.agent.id)).status).toBe("none");
    expect(provider.calls.some((c) => c.op === "destroy")).toBe(true);
    const actions = (await f.db.select().from(schema.auditLog)).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["sandbox.created", "sandbox.stopped", "sandbox.deleted"]));
  });

  test("a start that fails ends as error with the reason, never naming the provider", async () => {
    const provider = sandboxSetup();
    provider.create = async () => {
      throw new Error("Daytona quota exceeded in /home/daytona");
    };
    f = await setup({ sandbox: provider, reply: () => ({ chunks: ["ok"] }) });
    const deps = { ...(f.sandboxDeps as NonNullable<typeof f.sandboxDeps>), pubsub: f.pubsub };
    await startAgentComputer(deps, f.owner.id, f.org.id, f.agent.id);
    await drainOutbox(f.db, f.handlers);
    const view = await getAgentComputer(deps, f.owner.id, f.org.id, f.agent.id);
    expect(view.status).toBe("error");
    expect(view.error?.message).toBe("computador quota exceeded in ~");
  });

  test("granted but no provider on the server: the prompt says the sandbox is off", async () => {
    let prompt = "";
    f = await setup({
      contextTools: true,
      reply: (req: ModelRequest) => {
        prompt = systemText(req.system ?? "");
        return { chunks: ["ok"] };
      },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    await runCtx();
    expect(prompt).toContain("Rodar código (sandbox): liberado para você, mas o ambiente de código está desligado");
  });
});

/** A minimal zip (stored entries). */
async function zipOf(files: Record<string, string>) {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = enc.encode(path);
    const data = enc.encode(text);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const size = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
