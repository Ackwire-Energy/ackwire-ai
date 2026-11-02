import { afterEach, describe, expect, test } from "bun:test";
import { DELETE_BRANCHES_POINTER } from "@agenteschat/adapters/command-policy";
import { eq, schema } from "@agenteschat/db";
import {
  createAgent,
  createOrganization,
  drainOutbox,
  ForbiddenError,
  getAgentComputer,
  grantKey,
  grantScopes,
  importSkillZip,
  KILLED_NOTE,
  NO_COMPUTER_MESSAGE,
  NotFoundError,
  notAllowedMessage,
  postPersonMessage,
  setAgentAccess,
  setAgentSkills,
  type ToolContext,
  toolAccess,
  updateSandboxSettings,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";
import { connectedComputer } from "./machine-fixtures";

const WHY = "The person asked for this and the checks passed: this action finishes what was requested.";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SANDBOX = [{ connectionId: null, scope: "sandbox:run" }];

/** A real run (steps and usage rows reference it) in #general, top-level unless a thread is given. */
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

describe("binary files", () => {
  test("read_file says what a binary file is instead of its bytes; text still reads; export_file refuses it", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const { runner } = await connectedComputer(f);
    const ctx = await runCtx();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xc3, 0x28]);
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x80]);
    for (const [path, bytes] of [
      ["screenshots/before.jpg", jpeg],
      ["out/data.zip", zip],
      ["out/chart.jpg", jpeg],
    ] as const) {
      expect((await call(ctx, "write_file", { path, content: "x" })).isError).toBeFalsy();
      const key = [...runner.files.keys()].find((k) => k.endsWith(path)) as string;
      runner.files.set(key, bytes);
    }
    const shot = await call(ctx, "read_file", { path: "screenshots/before.jpg" });
    expect(shot.isError).toBeFalsy();
    expect(shot.content).toBe(
      "screenshots/before.jpg: binary file (14 bytes, image/jpeg): not shown as text. desktop_read tells what the screen shows now; upload_file shows the picture to people.",
    );
    // desktop_read reads the live screen: never offered for a picture that isn't a screenshot.
    const chart = await call(ctx, "read_file", { path: "out/chart.jpg" });
    expect(chart.content).toEndWith(
      "not shown as text. Inspect it with run_code (`tesseract` for its text, `exiftool`), or show it to people with upload_file.",
    );
    const archive = await call(ctx, "read_file", { path: "out/data.zip" });
    expect(archive.content).toStartWith(
      "out/data.zip: binary file (7 bytes, zip): not shown as text. Inspect it with run_code",
    );
    expect(await call(ctx, "export_file", { path: "out/data.zip" })).toMatchObject({ isError: true });
    expect((await call(ctx, "write_file", { path: "notes.md", content: "olá 🐝" })).isError).toBeFalsy();
    expect((await call(ctx, "read_file", { path: "notes.md" })).content).toEndWith(
      ':\n<external_data source="file notes.md">\nolá 🐝\n</external_data>',
    );
  });
});

describe("access", () => {
  test("new agents get the computer and the browser", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"] }) });
    const agent = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Ops", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const scopes = await f.db
      .select({ scope: schema.agentScopes.scope })
      .from(schema.agentScopes)
      .where(eq(schema.agentScopes.agentId, agent.id));
    expect(scopes.map((s) => s.scope)).toEqual(expect.arrayContaining(["sandbox:run", "browser:use"]));
  });

  test("revocable, not part of 'all tools'", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const ctx = await runCtx();
    expect((await f.tools?.list(ctx))?.map((t) => t.name)).not.toContain("run_code");
    expect(await call(ctx, "run_code", { language: "python", code: "print(1)" })).toMatchObject({
      isError: true,
      content:
        "Not allowed: this agent lacks the scope sandbox:run. If the request needs it, ask for it with request_permission",
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
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    expect((await f.tools?.list(ctx))?.map((t) => t.name)).toContain("run_code");
    // Granted, but no computer was chosen for it: computer_status says so.
    expect(await call(ctx, "computer_status", {})).toMatchObject({ isError: true, content: NO_COMPUTER_MESSAGE });
  });
});

describe("limits", () => {
  test("a command the system killed (137) most likely ran out of memory; one a person stopped didn't", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    await connectedComputer(f, {
      exec: (req) =>
        req.command.includes("python3")
          ? { exitCode: 137, stdout: "", stderr: "", canceled: { killed: true } }
          : { exitCode: 137, stdout: "", stderr: "Killed\n" },
    });
    const ctx = await runCtx();
    const killed = await call(ctx, "run_code", { language: "bash", code: "./gradlew assembleDebug" });
    expect(killed.content).toStartWith("run_code bash: exit code 137");
    expect(killed.content).toEndWith(`\n${KILLED_NOTE}`);
    const stopped = await call(ctx, "run_code", { language: "python", code: "import time; time.sleep(60)" });
    expect(stopped.content).not.toContain(KILLED_NOTE);
  });

  test("timeouts and long output are cut; approval and the org's switch", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const { runner } = await connectedComputer(f, {
      exec: (req) =>
        req.command.includes("python3")
          ? { exitCode: 124, stdout: "", stderr: "", timedOut: true }
          : { exitCode: 0, stdout: "x".repeat(50_000), stderr: "" },
    });
    const ctx = await runCtx();
    const slow = await call(ctx, "run_code", { language: "python", code: "while True: pass", timeout_seconds: 5 });
    expect(slow).toMatchObject({ isError: true });
    expect(slow.content).toStartWith("run_code python: timed out after 5 s");
    // The runner enforces it: the request carries the command's own timeout.
    expect(runner.sent.find((s) => s.type === "request" && s.op === "exec")).toMatchObject({ timeoutSeconds: 5 });
    const long = await call(ctx, "run_code", { language: "bash", code: "yes x" });
    expect(long.content.length).toBeLessThan(21_000);
    expect(long.content).toContain("characters cut");
    // What a command prints reaches the model inside the outside-content envelope (ADR 0117), cut once.
    expect(long.content).toStartWith("run_code bash: exit code 0");
    expect(long.content).toContain('\n<external_data source="run_code output">\nstdout:\n');
    expect(long.content).toEndWith("\n</external_data>");
    expect(long.content.match(/characters cut/g)).toHaveLength(1);

    // A member can't change the Run code settings (`configure`).
    const member = await addMember(f.db, f.org.id, "member", "bia");
    await expect(updateSandboxSettings(f.db, member.id, f.org.id, { requireApproval: true })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await updateSandboxSettings(f.db, f.owner.id, f.org.id, { requireApproval: true });
    const outcome = await f.tools?.invoke(await runCtx(), {
      toolUseId: crypto.randomUUID(),
      name: "run_code",
      input: { language: "bash", code: "echo oi", why: WHY },
    });
    expect(outcome?.type).toBe("approval");

    // Turned off for the organization: the tools are gone.
    await updateSandboxSettings(f.db, f.owner.id, f.org.id, { requireApproval: false, enabled: false });
    expect((await f.tools?.list(ctx))?.map((t) => t.name)).not.toContain("run_code");
  });
});

describe("what the agent is running", () => {
  test("the activity shows the code (secrets masked); output streams live, capped; the step keeps it", async () => {
    f = await setup({
      machines: true,
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
    const big = `${"x".repeat(100_000)}token sk-ant-abcdefghijklmnop`;
    await connectedComputer(f, {
      exec: (_req, out) => {
        out("stdout", big);
        out("stderr", "warn");
        return { exitCode: 0, stdout: big, stderr: "warn" };
      },
    });
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
    // Asked in the channel: the output streams where the run answers, the channel itself.
    expect(out.every((o) => o.toolUseId === start?.toolUseId && o.threadId === null)).toBe(true);
    const streamed = out.map((o) => o.text).join("");
    expect(streamed.length).toBeLessThan(66 * 1024);
    expect(streamed).toContain("more output");
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

describe("network", () => {
  test("a network failure is that machine's own, never a block of ours", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    await connectedComputer(f, {
      exec: () => ({ exitCode: 6, stdout: "", stderr: "curl: (6) Could not resolve host: example.com" }),
    });
    const out = await call(await runCtx(), "run_code", { language: "bash", code: "curl https://example.com" });
    expect(out.content).toContain("network failure: this is a connected computer");
    expect(out.content).not.toContain("no internet");
  });
});

describe("Drive and skills", () => {
  test("export a sandbox file to the Drive (new and as a version), import one back", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const { runner } = await connectedComputer(f);
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
    expect(new TextDecoder().decode(runner.files.get("imports/vendas.csv"))).toBe("mês,total\r\nfev,2");
  });

  test("run_skill_script copies the skill and runs the script; read_skill_file still refuses it", async () => {
    f = await setup({ machines: true, skillTools: true, reply: () => ({ chunks: ["ok"] }) });
    const { runner } = await connectedComputer(f);
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
    expect([...runner.files.keys()].sort()).toEqual([".skills/graficos/ref.md", ".skills/graficos/scripts/plot.py"]);
    // On a connected computer a safe path goes unquoted; the arguments are always quoted.
    expect(runner.sent.find((s) => s.type === "request" && s.op === "exec")).toMatchObject({
      command: "python3 .skills/graficos/scripts/plot.py '--n' 'it'\\''s'",
    });
    expect((await call(ctx, "run_skill_script", { skill: "graficos", path: "ref.md" })).isError).toBe(true);
  });
});

describe("commands the computer holds for a person (ADR 0053 §3)", () => {
  test("run_code and a skill script: held, they say why and how to ask; with why they ask in the chat, and the approved call runs", async () => {
    f = await setup({ machines: true, skillTools: true, reply: () => ({ chunks: ["ok"] }) });
    const HELD =
      "This push goes to the default branch main: a person approves it first. To ask them, make the same call again with why set to your reason: it waits for their decision in the chat.";
    // Like the runner: it holds every command a person hasn't approved.
    const { runner } = await connectedComputer(f, {
      exec: (req) =>
        req.approved
          ? { exitCode: 0, stdout: "pushed", stderr: "" }
          : { fail: { code: "approval_needed", message: HELD } },
    });
    const ctx = await runCtx();
    expect(await call(ctx, "run_code", { language: "bash", code: "git push origin main" })).toEqual({
      content: `Not run: ${HELD}`,
      isError: true,
      data: { code: "command.approval_needed" },
    });
    // The same call with why: an approval card in the chat; nothing else reaches the computer.
    const asked = await f.tools?.invoke(ctx, {
      toolUseId: crypto.randomUUID(),
      name: "run_code",
      input: { language: "bash", code: "git push origin main", why: WHY },
    });
    if (asked?.type !== "approval") throw new Error(`expected an approval, got ${asked?.type}`);
    expect(asked.approval).toMatchObject({ tool: "run_code", why: WHY, channelId: f.general.id });
    const execs = () => runner.sent.filter((s) => s.type === "request" && s.op === "exec");
    expect(execs()).toHaveLength(1);
    expect(execs()[0]).not.toHaveProperty("approved");
    // A person approved it: that exact call runs, and the computer is told a person approved it.
    const ran = await f.tools?.executeApproved(ctx, { ...asked.approval, status: "approved" });
    expect(ran?.content).toContain("pushed");
    expect(execs()).toHaveLength(2);
    expect(execs()[1]).toMatchObject({ approved: true });
    // A skill's script the same way.
    const md = "---\nname: entrega\ndescription: Publica.\n---\nRode scripts/ship.sh.";
    const zip = await zipOf({ "SKILL.md": md, "scripts/ship.sh": "git push origin main" });
    const skill = await importSkillZip({ db: f.db, blobs: f.artifactDeps.blobs }, f.owner.id, f.org.id, zip);
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: skill.id, enabled: true }]);
    expect(await call(ctx, "run_skill_script", { skill: "entrega", path: "scripts/ship.sh" })).toMatchObject({
      content: `Not run: ${HELD}`,
      data: { code: "command.approval_needed" },
    });
    const script = await f.tools?.invoke(ctx, {
      toolUseId: crypto.randomUUID(),
      name: "run_skill_script",
      input: { skill: "entrega", path: "scripts/ship.sh", why: WHY },
    });
    expect(script?.type).toBe("approval");
    // A why too short to tell the person anything is refused, with nothing asked.
    const short = await call(ctx, "run_code", { language: "bash", code: "git push origin main", why: "ship" });
    expect(short).toMatchObject({ isError: true, data: { code: "tool.why_missing" } });
  });

  test("what our git proxy refuses never runs, approved or not: the computer's refusal reads as it is", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const NEVER = `This deletes the remote branch old: ${DELETE_BRANCHES_POINTER}`;
    // Like the runner through the proxy: refused whoever approved, and a folder refusal keeps its advice.
    let refusal = NEVER;
    const { runner } = await connectedComputer(f, {
      exec: () => ({ fail: { code: "not_allowed", message: refusal } }),
    });
    const ctx = await runCtx();
    expect(await call(ctx, "run_code", { language: "bash", code: "git push origin --delete old" })).toEqual({
      content: `Not run: ${NEVER}`,
      isError: true,
      data: { code: "command.not_allowed" },
    });
    const asked = await f.tools?.invoke(ctx, {
      toolUseId: crypto.randomUUID(),
      name: "run_code",
      input: { language: "bash", code: "git push origin --delete old", why: WHY },
    });
    if (asked?.type !== "approval") throw new Error(`expected an approval, got ${asked?.type}`);
    const ran = await f.tools?.executeApproved(ctx, { ...asked.approval, status: "approved" });
    expect(ran).toMatchObject({ isError: true, content: `Not run: ${NEVER}` });
    expect(runner.sent.filter((s) => s.type === "request" && s.op === "exec").at(-1)).toMatchObject({ approved: true });
    expect(notAllowedMessage("Mac", NEVER)).toBe(NEVER);
    refusal = "/etc is outside the folders this agent may use";
    const folder = await call(ctx, "run_code", { language: "bash", code: "ls /etc" });
    expect(folder.content).toContain("request_folder_access");
  });
});

describe("the agent's computer API", () => {
  test("owner or admins only; other organizations see nothing", async () => {
    f = await setup();
    expect(await getAgentComputer(f.db, f.owner.id, f.org.id, f.agent.id)).toEqual({ target: { kind: "none" } });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(getAgentComputer(f.db, bia.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    const zed = await addUser(f.db, "zed");
    const { organization } = await createOrganization(f.db, zed.id, { name: "Outra" });
    await expect(getAgentComputer(f.db, zed.id, organization.id, f.agent.id)).rejects.toBeInstanceOf(NotFoundError);
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
