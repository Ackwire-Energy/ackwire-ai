import { describe, expect, test } from "bun:test";
import {
  createDaytonaSandboxProvider,
  createFakeSandboxProvider,
  parseSplitOutput,
  SandboxGoneError,
  splitOutputScript,
  workspacePath,
} from "../src";

type Call = { url: string; method: string; headers: Headers; body: unknown };

/** A fake Daytona API + toolbox proxy (no network). */
function fakeDaytona(options: { refuseNetworkPolicy?: boolean; execResult?: (script: string) => unknown } = {}) {
  const calls: Call[] = [];
  const states = new Map<string, string>();
  let polls = 0;
  const fetch = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const raw = init.body;
    let body: unknown = raw;
    if (typeof raw === "string") body = JSON.parse(raw);
    calls.push({ url, method, headers: new Headers(init.headers), body });
    const u = new URL(url);
    if (u.host === "app.daytona.io" && u.pathname === "/api/sandbox" && method === "POST") {
      const b = body as Record<string, unknown>;
      if (options.refuseNetworkPolicy && ("networkBlockAll" in b || "domainAllowList" in b)) {
        return new Response(JSON.stringify({ message: "Network policy is not available on your tier" }), {
          status: 400,
        });
      }
      states.set("sb1", "creating");
      return Response.json({
        id: "sb1",
        state: "creating",
        cpu: 1,
        memory: 1,
        disk: 3,
        toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
      });
    }
    const m = /^\/api\/sandbox\/([^/]+)(\/start|\/stop)?$/.exec(u.pathname);
    if (u.host === "app.daytona.io" && m) {
      const id = m[1] as string;
      if (!states.has(id)) return new Response("not found", { status: 404 });
      if (m[2] === "/start") {
        states.set(id, "starting");
        return Response.json({ id, state: "starting" });
      }
      if (m[2] === "/stop") {
        states.set(id, "stopped");
        return Response.json({});
      }
      if (method === "DELETE") {
        states.delete(id);
        return Response.json({});
      }
      // Each poll moves a creating/starting sandbox on.
      polls++;
      const state = states.get(id) as string;
      if (state === "creating" || state === "starting") states.set(id, "started");
      return Response.json({
        id,
        state,
        cpu: 1,
        memory: 1,
        disk: 3,
        toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
      });
    }
    if (u.host === "proxy.app.daytona.io" && u.pathname === "/toolbox/sb1/process/execute") {
      const command = (body as { command: string }).command;
      const encoded = /echo (\S+) \| base64 -d/.exec(command)?.[1] ?? "";
      const script = Buffer.from(encoded, "base64").toString("utf8");
      return Response.json(options.execResult?.(script) ?? { exitCode: 0, result: "" });
    }
    if (u.host === "proxy.app.daytona.io" && u.pathname === "/toolbox/sb1/files/upload-v2") return Response.json({});
    if (u.host === "proxy.app.daytona.io" && u.pathname === "/toolbox/sb1/files/download") {
      return u.searchParams.get("path")?.endsWith("missing.txt")
        ? new Response("no", { status: 404 })
        : new Response("conteúdo");
    }
    if (u.host === "proxy.app.daytona.io" && u.pathname === "/toolbox/sb1/files") {
      return Response.json([
        { name: "a.py", path: "/home/daytona/workspace/a.py", isDir: false, size: 3 },
        { name: "out", path: "/home/daytona/workspace/out", isDir: true, size: 0 },
      ]);
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, calls, states, polls: () => polls };
}

const spec = {
  key: "org:dm:1",
  labels: { "agentes.org": "o1" },
  allowDomains: [],
  autoStopMinutes: 10,
  autoArchiveMinutes: 10080,
};

describe("Daytona sandbox provider (REST)", () => {
  test("create: bearer key, empty env, block-all network, auto-stop/archive, never auto-delete; waits until started", async () => {
    const d = fakeDaytona();
    const p = createDaytonaSandboxProvider({ apiKey: "dtn_test", fetch: d.fetch, pollMs: 0 });
    const info = await p.create(spec);
    expect(info).toEqual({
      id: "sb1",
      state: "started",
      resources: { cpu: 1, memoryGiB: 1, diskGiB: 3 },
      network: "blocked",
    });
    const create = d.calls[0];
    expect(create?.url).toBe("https://app.daytona.io/api/sandbox");
    expect(create?.headers.get("authorization")).toBe("Bearer dtn_test");
    expect(create?.body).toEqual({
      labels: { "agentes.org": "o1" },
      env: {},
      public: false,
      autoStopInterval: 10,
      autoArchiveInterval: 10080,
      autoDeleteInterval: -1,
      networkBlockAll: true,
    });
    // The key never goes anywhere but the Authorization header.
    expect(JSON.stringify(d.calls.map((c) => [c.url, c.body]))).not.toContain("dtn_test");
  });

  test("an allowlist of domains instead of block-all; a tier that refuses it gets the org default, marked", async () => {
    const d = fakeDaytona();
    const p = createDaytonaSandboxProvider({ apiKey: "k", fetch: d.fetch, pollMs: 0, target: "eu" });
    await p.create({ ...spec, allowDomains: ["pypi.org", "files.pythonhosted.org"] });
    expect(d.calls[0]?.body).toMatchObject({ domainAllowList: "pypi.org,files.pythonhosted.org", target: "eu" });
    expect(d.calls[0]?.body).not.toHaveProperty("networkBlockAll");

    const tier = fakeDaytona({ refuseNetworkPolicy: true });
    const q = createDaytonaSandboxProvider({ apiKey: "k", fetch: tier.fetch, pollMs: 0 });
    expect((await q.create(spec)).network).toBe("provider-default");
    expect(tier.calls[1]?.body).not.toHaveProperty("networkBlockAll");
  });

  test("exec: no envs, stdout and stderr apart, exit code, timeout", async () => {
    let seen = "";
    const d = fakeDaytona({
      execResult: (script) => {
        seen = script;
        const marker = /printf '\\n%s\\n' '([^']+)'/.exec(script)?.[1] ?? "";
        return { exitCode: 2, result: `ok out\n${marker}\nboom err` };
      },
    });
    const p = createDaytonaSandboxProvider({ apiKey: "k", fetch: d.fetch, pollMs: 0 });
    await p.create(spec);
    const r = await p.exec("sb1", { command: "python3 a.py", timeoutSeconds: 30 });
    expect(r).toEqual({ exitCode: 2, stdout: "ok out", stderr: "boom err", timedOut: false });
    expect(seen).toContain("python3 a.py");
    const exec = d.calls.filter((c) => c.url.endsWith("/process/execute")).at(-1);
    expect(exec?.body).toMatchObject({ cwd: "/home/daytona/workspace", timeout: 30 });
    expect(exec?.body).not.toHaveProperty("envs");
  });

  test("files: upload raw bytes under the workspace, download, list relative; .. refused", async () => {
    const d = fakeDaytona();
    const p = createDaytonaSandboxProvider({ apiKey: "k", fetch: d.fetch, pollMs: 0 });
    await p.create(spec);
    await p.writeFile("sb1", "/workspace/out/r.md", new TextEncoder().encode("# r"));
    const up = d.calls.filter((c) => c.url.includes("/files/upload-v2")).at(-1);
    expect(new URL(up?.url ?? "").searchParams.get("path")).toBe("/home/daytona/workspace/out/r.md");
    expect(new TextDecoder().decode((await p.readFile("sb1", "x.txt")) ?? new Uint8Array())).toBe("conteúdo");
    expect(await p.readFile("sb1", "missing.txt")).toBeNull();
    expect(await p.listFiles("sb1", "")).toEqual([
      { path: "a.py", isDir: false, size: 3 },
      { path: "out", isDir: true, size: 0 },
    ]);
    await expect(p.writeFile("sb1", "../etc/passwd", new Uint8Array())).rejects.toThrow("invalid path");
  });

  test("lifecycle: start a stopped one; a deleted one is gone", async () => {
    const d = fakeDaytona();
    const p = createDaytonaSandboxProvider({ apiKey: "k", fetch: d.fetch, pollMs: 0 });
    await p.create(spec);
    await p.stop("sb1");
    expect((await p.get("sb1"))?.state).toBe("stopped");
    expect((await p.ensureStarted("sb1")).state).toBe("started");
    expect(d.calls.some((c) => c.url.endsWith("/sandbox/sb1/start") && c.method === "POST")).toBe(true);
    await p.destroy("sb1");
    expect(await p.get("sb1")).toBeNull();
    await expect(p.ensureStarted("sb1")).rejects.toBeInstanceOf(SandboxGoneError);
  });
});

describe("helpers and the fake", () => {
  test("workspace paths and split output", () => {
    expect(workspacePath("/workspace/a/./b.py")).toBe("a/b.py");
    expect(workspacePath("")).toBe("");
    expect(() => workspacePath("a/../../x")).toThrow();
    const script = splitOutputScript("echo hi", "M1");
    expect(script).toContain("2>/tmp/.agentes-stderr-M1");
    expect(parseSplitOutput("hi\nM1\nerr", "M1")).toEqual({ stdout: "hi", stderr: "err" });
    expect(parseSplitOutput("no marker", "M1")).toEqual({ stdout: "no marker", stderr: "" });
  });

  test("the fake keeps files per sandbox and records calls", async () => {
    const p = createFakeSandboxProvider();
    const a = await p.create(spec);
    await p.writeFile(a.id, "x.txt", new TextEncoder().encode("1"));
    expect((await p.listFiles(a.id, "")).map((f) => f.path)).toEqual(["x.txt"]);
    p.setState(a.id, "stopped");
    await p.ensureStarted(a.id);
    expect(p.calls.map((c) => c.op)).toEqual(["create", "write", "list", "start"]);
  });
});
