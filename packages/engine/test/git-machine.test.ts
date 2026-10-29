import { afterEach, describe, expect, test } from "bun:test";
import { GIT_PROTOCOL, type GitSyncRepo, MACHINE_PROTOCOL_VERSION, type ServerFrame } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  type ConnectorDeps,
  codePrompt,
  connectorGrantValidator,
  createApiKeyConnection,
  createGitToolSource,
  deleteMachine,
  drainOutbox,
  handleGitProxy,
  issueGitToken,
  type MachineHub,
  machineGitSetup,
  namedRepo,
  pkt,
  postPersonMessage,
  prepareAgentCode,
  repositoriesPrompt,
  requestTimeoutMs,
  runPermissionPrompt,
  setAgentComputerTarget,
  setAgentRepositories,
  setAgentScopes,
  type ToolContext,
  verifyGitToken,
  ZERO_OID,
} from "../src";
import { type Fixture, SECRET, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const GH_TOKEN = "ghp_secret_123456";
const PUBLIC_URL = "https://agentes.test";
const RUNNER = { hostname: "mac", os: "darwin", arch: "arm64", version: "0.10.0", workspace: "/Users/w/agentes" };
const FOLDER = "/Users/w/agentes/dev-0193aaaa";

type Request = Extract<ServerFrame, { type: "request" }>;
type SyncRequest = Extract<Request, { op: "git.sync" }>;

/** A runner over an in-memory socket that answers `git.sync` with `answer` (and records what it got). */
function fakeRunner(hub: MachineHub, answer: (req: SyncRequest) => GitSyncRepo[], protocol = MACHINE_PROTOCOL_VERSION) {
  const sent: ServerFrame[] = [];
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const socket = {
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      sent.push(frame);
      if (frame.type === "request" && frame.op === "git.sync") {
        setTimeout(() => {
          reply({ type: "output", id: frame.id, stream: "stderr", chunk: "Receiving objects: 100% (3/3)\r" });
          try {
            void reply({ type: "result", id: frame.id, ok: true, data: { repos: answer(frame) } });
          } catch (err) {
            void reply({ type: "result", id: frame.id, ok: false, error: { code: "internal", message: String(err) } });
          }
        }, 1);
      }
    },
    close() {
      void hub.close(conn);
    },
  };
  const conn = hub.open(socket);
  return {
    sent,
    syncs: () => sent.filter((s): s is SyncRequest => s.type === "request" && s.op === "git.sync"),
    hello: (token: string) =>
      hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, protocol, exec: true })),
  };
}

/** GitHub connected, the agent on a connected Mac with only `github:git.read` (no sandbox:run). */
async function world(options: { scopes?: string[]; protocol?: number } = {}) {
  f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
  const hub = f.machineHub as MachineHub;
  const connectors: ConnectorDeps = { db: f.db, keyWrappers: [f.keyWrapper], publicUrl: PUBLIC_URL };
  const connection = await createApiKeyConnection(connectors, f.owner.id, f.org.id, {
    connector: "github",
    apiKey: GH_TOKEN,
  });
  await setAgentScopes(
    f.db,
    f.owner.id,
    f.org.id,
    f.agent.id,
    (options.scopes ?? ["github:git.read"]).map((scope) => ({ connectionId: connection.id, scope })),
    connectorGrantValidator,
  );
  const deps = { db: f.db, pubsub: f.pubsub, publicUrl: PUBLIC_URL };
  const paired = await pairMachine(deps, f.owner.id, f.org.id, { name: "Mac", ...RUNNER });
  await setAgentComputerTarget(deps, f.owner.id, f.org.id, f.agent.id, paired.machineId);
  const answers: { fn: (req: SyncRequest) => GitSyncRepo[] } = {
    fn: (req) =>
      req.repos.map((r) => ({
        repo: r.repo,
        dir: r.dir,
        path: `${FOLDER}/${r.dir}`,
        status: r.clone ? "cloned" : "missing",
        ...(r.clone ? { branch: "main", defaultBranch: "main", head: "abc1234" } : {}),
      })),
  };
  const runner = fakeRunner(hub, (req) => answers.fn(req), options.protocol);
  await runner.hello(paired.token);
  const git = { publicUrl: PUBLIC_URL, secret: SECRET };
  return { hub, connectors, connection, paired, runner, answers, git, machineDeps: { db: f.db, hub, git } };
}

async function runCtx(): Promise<ToolContext> {
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev oi",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, msg.id));
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: run.threadRootId,
    triggerMessageId: msg.id,
    toolUseId: "tu_1",
  };
}

const fakeUpstream = () => {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/info/refs"))
      return new Response("001e# service=git-upload-pack\n0000", {
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      });
    if (url.endsWith("/git-receive-pack")) return new Response("000eunpack ok\n0000");
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, gitUrl: "https://github.test", apiUrl: "https://api.github.test" };
};

describe("git on a connected machine through the proxy (ADR 0024 addendum)", () => {
  test("the credential is ours, bound to the machine and the agent; the proxy keeps the agent's policy", async () => {
    const w = await world({ scopes: ["github:git.read", "github:git.write"] });
    const setupFor = await machineGitSetup(w.machineDeps, f.org.id, f.agent.id, w.paired.machineId);
    expect(setupFor?.proxy.base).toBe(`${PUBLIC_URL}/api/git/${f.org.id}/${w.connection.id}/`);
    expect(setupFor?.author).toEqual({ name: "Dev (agentes)", email: "dev@agents.agentes.test" });
    const claims = verifyGitToken(SECRET, setupFor?.proxy.token ?? "");
    expect(claims).toMatchObject({ kind: "machine", sandboxId: w.paired.machineId, agentId: f.agent.id });
    expect(setupFor?.proxy.token).not.toContain(GH_TOKEN);

    const upstream = fakeUpstream();
    const auth = (token: string) => `Basic ${Buffer.from(`agentes:${token}`).toString("base64")}`;
    const call = (path: string, token: string, init: { method?: string; body?: Uint8Array; query?: string } = {}) =>
      handleGitProxy(
        { db: f.db, secret: SECRET, connectors: w.connectors, upstream },
        new Request(`${PUBLIC_URL}/api/git/${f.org.id}/${w.connection.id}/${path}${init.query ?? ""}`, {
          method: init.method ?? "GET",
          headers: { authorization: auth(token) },
          body: init.body,
        }),
        { orgId: f.org.id, connectionId: w.connection.id, path },
      );
    const token = setupFor?.proxy.token as string;
    const refs = () => call("acme/app.git/info/refs", token, { query: "?service=git-upload-pack" });
    expect((await refs()).status).toBe(200);

    // Only the agent's repositories.
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app"]);
    expect((await refs()).status).toBe(200);
    const other = await call("acme/other.git/info/refs", token, { query: "?service=git-upload-pack" });
    expect(other.status).toBe(403);

    // Pushes only to agentes/dev/…: main is refused here and never reaches GitHub.
    const push = (ref: string) =>
      call("acme/app.git/git-receive-pack", token, {
        method: "POST",
        body: new Uint8Array(Buffer.from(`${pkt(`${ZERO_OID} ${"b".repeat(40)} ${ref}\0report-status\n`)}0000`)),
      });
    expect(await (await push("refs/heads/main")).text()).toContain("agents push only to branches agentes/dev/");
    expect(upstream.calls.some((u) => u.endsWith("git-receive-pack"))).toBe(false);
    const [refused] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "git.push_refused")));
    expect(refused).toBeTruthy();

    // A token not issued to a machine (no `kind`) is refused.
    const noKind = issueGitToken(SECRET, {
      orgId: f.org.id,
      agentId: f.agent.id,
      sandboxId: w.paired.machineId,
      gen: claims?.gen ?? 0,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    expect((await call("acme/app.git/info/refs", noKind, { query: "?service=git-upload-pack" })).status).toBe(401);

    // The agent moved off the machine: revoked at once; back on it, it works again; the machine deleted: revoked.
    const deps = { db: f.db, pubsub: f.pubsub, publicUrl: PUBLIC_URL };
    await setAgentComputerTarget(deps, f.owner.id, f.org.id, f.agent.id, null);
    expect((await refs()).status).toBe(401);
    await setAgentComputerTarget(deps, f.owner.id, f.org.id, f.agent.id, w.paired.machineId);
    expect((await refs()).status).toBe(200);
    await deleteMachine(deps, f.owner.id, f.org.id, w.paired.machineId);
    expect((await refs()).status).toBe(401);
  });

  test("git_clone needs only github:git.read: the runner clones into the agent's folder through the proxy", async () => {
    const w = await world();
    const source = createGitToolSource({
      sandbox: { db: f.db, machines: { hub: w.hub }, git: w.git } as never,
      connectors: w.connectors,
      pubsub: f.pubsub,
    });
    const ctx = await runCtx();
    const clone = (await source.tools(ctx)).find((t) => t.name === "git_clone");
    expect(clone?.scope).toBe("github:git.read");
    const out = await clone?.execute({ repo: "https://github.com/acme/app.git" }, ctx);
    expect(out?.isError).toBeFalsy();
    expect(out?.content).toContain(`Cloned acme/app into ${FOLDER}/repos/acme/app (branch main at abc1234)`);
    expect(out?.content).toContain("agentes/dev/<topic>");
    const [sync] = w.runner.syncs();
    expect(sync).toMatchObject({
      op: "git.sync",
      agent: { id: f.agent.id, handle: "dev" },
      repos: [{ repo: "acme/app", dir: "repos/acme/app", clone: true }],
      author: { email: "dev@agents.agentes.test" },
      stream: true,
    });
    expect(sync?.timeoutSeconds).toBeGreaterThanOrEqual(1800);
    expect(requestTimeoutMs(sync as never)).toBeGreaterThan(1800_000);
    expect(verifyGitToken(SECRET, sync?.proxy.token ?? "")?.kind).toBe("machine");
    // Nothing GitHub's reaches the machine.
    expect(JSON.stringify(w.runner.sent)).not.toContain(GH_TOKEN);

    // A failed clone (refused by the proxy, offline) says why.
    w.answers.fn = (req) => [
      {
        repo: req.repos[0]?.repo ?? "",
        dir: "repos/acme/app",
        status: "failed",
        message: "fatal: 403 isn't one of dev's",
      },
    ];
    const failed = await clone?.execute({ repo: "acme/app" }, ctx);
    expect(failed).toMatchObject({ isError: true });
    expect(failed?.content).toContain("403");
    // Paths stay in the folder.
    expect((await clone?.execute({ repo: "acme/app", dir: "../x" }, ctx))?.isError).toBe(true);
  });

  test("an older runner is told to update; no git access, no clone", async () => {
    const w = await world({ protocol: GIT_PROTOCOL - 1 });
    const source = createGitToolSource({
      sandbox: { db: f.db, machines: { hub: w.hub }, git: w.git } as never,
      connectors: w.connectors,
    });
    const ctx = await runCtx();
    const clone = (await source.tools(ctx)).find((t) => t.name === "git_clone");
    const out = await clone?.execute({ repo: "acme/app" }, ctx);
    expect(out?.isError).toBe(true);
    expect(out?.content).toContain("too old to clone");
    expect(w.runner.syncs()).toHaveLength(0);
    expect(
      await prepareAgentCode(w.machineDeps, {
        orgId: f.org.id,
        agentId: f.agent.id,
        threadRootId: null,
        trigger: "hi",
        messages: [],
        session: { machineId: w.paired.machineId, cwd: "" },
      }),
    ).toBeNull();
  });

  test("before a chat turn: checkouts updated, the turn starts in the repository it is about, # Your code", async () => {
    const w = await world();
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app", "acme/web", "acme/infra"]);
    w.answers.fn = (req) => {
      const out: GitSyncRepo[] = req.repos.map((r) =>
        r.repo === "acme/infra"
          ? { repo: r.repo, dir: r.dir, status: "missing" }
          : r.repo === "acme/web"
            ? {
                repo: r.repo,
                dir: r.dir,
                path: `${FOLDER}/${r.dir}`,
                status: "failed",
                head: "def5678",
                defaultBranch: "main",
                message: "network unreachable",
              }
            : { repo: r.repo, dir: r.dir, path: `${FOLDER}/${r.dir}`, status: "updated", defaultBranch: "main" },
      );
      // A checkout cloned earlier but no longer granted: on disk, never offered.
      out.push({ repo: "beta/old", dir: "repos/beta/old", path: `${FOLDER}/repos/beta/old`, status: "updated" });
      return out;
    };
    const turn = (trigger: string) => ({
      orgId: f.org.id,
      agentId: f.agent.id,
      threadRootId: null,
      trigger,
      messages: [{ content: "earlier" }],
      session: { machineId: w.paired.machineId, cwd: "" },
    });
    const named = await prepareAgentCode(w.machineDeps, turn("o build do Web quebrou, olha acme/web"));
    expect(named?.cwd).toBe("repos/acme/web");
    const [sync] = w.runner.syncs();
    expect(sync).toMatchObject({
      existing: true,
      repos: [
        { repo: "acme/app", dir: "repos/acme/app", clone: false },
        { repo: "acme/web", dir: "repos/acme/web", clone: false },
        { repo: "acme/infra", dir: "repos/acme/infra", clone: false },
      ],
    });
    expect(sync?.timeoutSeconds).toBeLessThanOrEqual(30);
    expect(named?.prompt).toBe(
      [
        "# Your code",
        `acme/app is checked out at ${FOLDER}/repos/acme/app (default branch main, updated before this turn).`,
        `acme/web is checked out at ${FOLDER}/repos/acme/web (default branch main; it couldn't be updated before this turn: network unreachable).`,
        `You start in ${FOLDER}/repos/acme/web.`,
        "Read it freely; to change code, create a branch agentes/dev/<topic> there, push it (git push -u origin agentes/dev/<topic>) and open a PR with open_pull_request.",
        "Not cloned yet: acme/infra. To work on one, call git_clone first; it needs no approval.",
      ].join("\n"),
    );
    expect(named?.prompt).not.toContain("beta/old");
    // Nothing named: the agent's first repository.
    expect((await prepareAgentCode(w.machineDeps, turn("bom dia")))?.cwd).toBe("repos/acme/app");

    // A mission turn (its own folder), or a runner that fails: nothing, the turn goes on as before.
    expect(
      await prepareAgentCode(w.machineDeps, { ...turn("x"), session: { machineId: w.paired.machineId, cwd: "m/1" } }),
    ).toBeNull();
    w.answers.fn = () => {
      throw new Error("boom");
    };
    expect(await prepareAgentCode(w.machineDeps, turn("x"))).toBeNull();
  });
});

describe("prompt text and permissions", () => {
  test("the repository named last wins; bare names count when they are words", () => {
    const repos = ["acme/app", "acme/web"];
    expect(namedRepo(repos, ["fix the web login", "about acme/app"])).toBe("acme/web");
    expect(namedRepo(repos, ["nothing here", "acme/app please"])).toBe("acme/app");
    expect(namedRepo(repos, ["webhooks and apps"])).toBeNull();
    expect(namedRepo(repos, ["see acme/web and acme/app"])).toBe("acme/web");
  });

  test("# Your code with nothing cloned yet, and the whole-account hint", () => {
    expect(codePrompt({ handle: "dev", checkouts: [], notCloned: [] })).toBe("");
    expect(codePrompt({ handle: "dev", checkouts: [], notCloned: ["acme/app"] })).toBe(
      "# Your code\nNot cloned yet: acme/app. To work on one, call git_clone first; it needs no approval.",
    );
    expect(repositoriesPrompt(["acme/*"])).toContain(
      "search the repositories of acme first (search_code) and pick the one that fits; ask only if it stays unclear",
    );
  });

  test("a brain outside missions may clone and fetch into its folder; pushes to main stay denied", () => {
    const scope = { cwd: `${FOLDER}/repos/acme/app`, folders: [`${FOLDER}/repos/acme/app`, FOLDER] };
    const ask = (command: string) =>
      JSON.parse(runPermissionPrompt({ tool_name: "Bash", input: { command }, scope }, { canRun: false })) as {
        behavior: string;
      };
    expect(ask("git clone https://github.com/acme/web ../web").behavior).toBe("allow");
    expect(ask("git pull --ff-only").behavior).toBe("allow");
    expect(ask("git push origin main").behavior).toBe("deny");
    expect(ask("git clone https://github.com/acme/web /tmp/web").behavior).toBe("deny");
  });

  test("a refused command says why and what to do instead, so the agent doesn't resend it", () => {
    const scope = { cwd: `${FOLDER}/repos/acme/app`, folders: [`${FOLDER}/repos/acme/app`, FOLDER] };
    const ask = (command: string) =>
      JSON.parse(runPermissionPrompt({ tool_name: "Bash", input: { command }, scope }, { canRun: true })) as {
        behavior: string;
        message?: string;
      };
    const heredoc = ask("git checkout -b fix && cat > src/a.test.ts <<'EOF'\ntest()\nEOF");
    expect(heredoc.behavior).toBe("deny");
    expect(heredoc.message).toContain("because it can't be read plainly");
    expect(heredoc.message).toContain("Edit and Write tools");
    expect(ask("echo hi > /etc/hosts").message).toContain("because it writes outside the mission folder");
    expect(ask("git checkout -b fix").behavior).toBe("allow");
  });
});
