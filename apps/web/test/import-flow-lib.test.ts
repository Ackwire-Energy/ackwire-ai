import { describe, expect, test } from "bun:test";
import type { ApiClient, ImportInput, ImportItemResult, MigrationBundle } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { ImportError } from "@/lib/import";
import {
  applyInChunks,
  blockedItems,
  bundleOrigin,
  githubRoot,
  isGithubLink,
  NOT_GITHUB,
  PER_APPLY,
  picksOf,
  retryable,
  sliceBundle,
} from "@/lib/import-flow";

const bundle = (over: Partial<MigrationBundle> = {}): MigrationBundle => ({
  format: "agenteschat.bundle",
  version: 1,
  source: { app: "openclaw", ref: "openclaw:pinch", name: "Pinch", files: [] },
  agents: [],
  skills: [],
  channels: [],
  routines: [],
  notes: [],
  todo: [],
  leftOut: [],
  ...over,
});
const agent = (key: string) => ({
  key,
  name: key,
  handle: key,
  role: "",
  instructions: "",
  model: null,
  appearance: {},
  skills: [],
});
const item = (id: string, action: ImportItemResult["action"] = "create"): ImportItemResult => {
  const [kind, key] = id.split(":") as [ImportItemResult["kind"], string];
  return { kind, key, label: key, action };
};

describe("where a bundle came from", () => {
  test("a parsed app, our own export, a reply to the export request, an app we don't know", () => {
    const from = (app: string, ref: string) => bundleOrigin(bundle({ source: { app, ref, name: "x", files: [] } }));
    expect(bundleOrigin(bundle())).toEqual({ card: "openclaw", app: "OpenClaw" });
    expect(from("openbotrun", "grok-bot")).toEqual({ card: "openbotrun", app: "OpenBot.run" });
    expect(from("agenteschat", "agenteschat:org-1")).toEqual({ card: "agenteschat", app: "agentes.chat" });
    // The two most used apps that answer the request have cards of their own; the others share Outro app's.
    expect(from("agenteschat", "grok-bot:my-bots")).toEqual({ card: "grok-bot", app: "Grok Bot" });
    expect(from("agenteschat", "chatgpt-dots:my-dot")).toEqual({ card: "chatgpt-dots", app: "ChatGPT dots" });
    expect(from("agenteschat", "claude:projects")).toEqual({ card: "other", app: "Claude" });
    // OpenBot is still read, without a card of its own.
    expect(from("openbot", "tenant")).toEqual({ card: "other", app: "OpenBot" });
    expect(from("agenteschat", "viktor")).toEqual({ card: "other", app: null });
    expect(from("cli", "x")).toEqual({ card: "other", app: null });
  });

  test("Tentar de novo only where the network or the server failed", () => {
    const down = new ApiError(503, "unavailable", "down");
    expect(retryable({ from: "files", step: "plan", cause: down })).toBe(true);
    expect(retryable({ from: "link", step: "read", cause: new TypeError("Failed to fetch") })).toBe(true);
    // A bad link, files no app wrote, a file that couldn't be read (picked again), the server refusing.
    expect(retryable({ from: "link", step: "read", cause: new ApiError(400, "invalid_request", "404") })).toBe(false);
    expect(retryable({ from: "link", step: "read", cause: NOT_GITHUB })).toBe(false);
    expect(retryable({ from: "files", step: "parse", cause: new ImportError("unknown") })).toBe(false);
    expect(retryable({ from: "files", step: "read", cause: new Error("NotReadableError") })).toBe(false);
    expect(retryable({ from: "paste", step: "plan", cause: new ApiError(413, "import.too_large", "big") })).toBe(false);
  });

  test("only the links the server reads count as GitHub links", () => {
    expect(isGithubLink("https://github.com/acme/agents/tree/main/team")).toBe(true);
    expect(isGithubLink("https://raw.githubusercontent.com/acme/agents/main/agents.yaml")).toBe(true);
    expect(isGithubLink("http://github.com/acme/agents")).toBe(false);
    expect(isGithubLink("https://gitlab.com/acme/agents")).toBe(false);
    expect(isGithubLink("https://github.com.evil.example/acme")).toBe(false);
    expect(isGithubLink("github.com/acme/agents")).toBe(false);
  });

  test("a GitHub link names the import after its folder or file, and after the repository, never a branch", () => {
    expect(githubRoot("https://github.com/acme/agents")).toBe("agents");
    expect(githubRoot("https://github.com/acme/agents/tree/main")).toBe("agents");
    expect(githubRoot("https://github.com/acme/agents/tree/main/team")).toBe("team");
    expect(githubRoot("https://github.com/acme/agents/blob/main/team/CLAW.md")).toBe("CLAW.md");
    expect(githubRoot("https://raw.githubusercontent.com/acme/agents/main/agents.yaml")).toBe("agents.yaml");
    expect(githubRoot("https://github.com/acme/time%20de%20vendas/tree/dev")).toBe("time de vendas");
  });
});

describe("what comes", () => {
  const b = bundle({
    agents: [agent("ana"), agent("bia"), agent("cid")],
    channels: [{ key: "ops", name: "ops", topic: "", agents: [] }],
    routines: [
      {
        key: "r-ana",
        name: "R",
        agent: "ana",
        prompt: "p",
        channel: null,
        trigger: { cron: "0 9 * * *", timezone: null },
      },
      {
        key: "r-ops",
        name: "R",
        agent: "bia",
        prompt: "p",
        channel: "ops",
        trigger: { cron: "0 9 * * *", timezone: null },
      },
      {
        key: "r-cid",
        name: "R",
        agent: "cid",
        prompt: "p",
        channel: null,
        trigger: { cron: "0 9 * * *", timezone: null },
      },
    ],
    notes: [
      { key: "n-ana", agent: "ana", kind: "note", content: "x" },
      { key: "n-org", agent: null, kind: "note", content: "y" },
    ],
  });
  // cid was brought by an earlier import: what needs it comes either way.
  const items = [
    item("agent:ana"),
    item("agent:bia"),
    item("agent:cid", "unchanged"),
    item("channel:ops"),
    item("routine:r-ana"),
    item("routine:r-ops"),
    item("routine:r-cid"),
    item("note:n-ana"),
    item("note:n-org"),
  ];

  test("unchecking a new agent or channel holds back the routines and memory that need it", () => {
    const pick = new Set(["agent:bia", "routine:r-ana", "routine:r-ops", "routine:r-cid", "note:n-ana", "note:n-org"]);
    const blocked = blockedItems(b, items, pick);
    expect([...blocked]).toEqual([
      ["routine:r-ana", "agent_not_picked"],
      ["routine:r-ops", "channel_not_picked"],
      ["note:n-ana", "agent_not_picked"],
    ]);
    expect(picksOf(items, pick, blocked)).toEqual(["agent:bia", "routine:r-cid", "note:n-org"]);
  });

  test("an existing channel the agents would only now join holds back its routines when unchecked", () => {
    const joined = items.map((i) =>
      i.key === "ops" ? { ...i, action: "update" as const, reason: "exists" as const } : i,
    );
    const pick = new Set(["agent:bia", "routine:r-ops"]);
    expect([...blockedItems(b, joined, pick)]).toContainEqual(["routine:r-ops", "channel_not_picked"]);
    // One an earlier import made (an update with no note) is here either way.
    const ours = items.map((i) => (i.key === "ops" ? { ...i, action: "update" as const } : i));
    expect(blockedItems(b, ours, pick).has("routine:r-ops")).toBe(false);
  });

  test("a chunk carries its items and every agent, never the to-dos or what stays behind", () => {
    const sliced = sliceBundle(
      { ...b, todo: [{ kind: "app", label: "Gmail", agents: [] }], leftOut: [{ kind: "file", label: "x" }] },
      new Set(["agent:bia", "note:n-org"]),
    );
    // The handle a new agent gets depends on the bundle's other agents, picked or not.
    expect(sliced.agents.map((a) => a.key)).toEqual(["ana", "bia", "cid"]);
    expect(sliced.notes.map((n) => n.key)).toEqual(["n-org"]);
    expect([sliced.channels, sliced.routines, sliced.todo, sliced.leftOut]).toEqual([[], [], [], []]);
    expect(sliced.source).toEqual(b.source);
  });
});

describe("applying in chunks", () => {
  const many = bundle({
    notes: Array.from({ length: 450 }, (_, i) => ({ key: `n${i}`, agent: null, kind: "note", content: `${i}` })),
  });
  const ids = many.notes.map((n) => `note:${n.key}`);
  /** The server's answer for one chunk: every picked item made, or unchanged when made before. */
  const server = (fail?: (call: number) => boolean) => {
    const made = new Set<string>();
    const inputs: ImportInput[] = [];
    const api = {
      imports: {
        apply: async (_orgId: string, input: ImportInput) => {
          inputs.push(input);
          if (fail?.(inputs.length)) throw new Error("down");
          return {
            items: (input.pick ?? []).map((id) => {
              const result = item(id, made.has(id) ? "unchanged" : "create");
              made.add(id);
              return { ...result, targetId: `id-${id}` };
            }),
          };
        },
      },
    } as unknown as ApiClient;
    return { api, inputs };
  };

  test(`at most ${PER_APPLY} per call, in the plan's order; the report adds them up`, async () => {
    const { api, inputs } = server();
    const progress: number[] = [];
    const report = await applyInChunks(
      api,
      "org",
      { bundle: many, pick: ids, enableSkills: ["skill:x"] },
      new Map(),
      (n) => progress.push(n),
    );
    expect(inputs.map((i) => i.pick?.length)).toEqual([200, 200, 50]);
    expect(inputs.every((i) => i.dryRun === false && i.enableSkills?.[0] === "skill:x")).toBe(true);
    expect(inputs[1]?.bundle.notes.map((n) => n.key)).toEqual(ids.slice(200, 400).map((id) => id.slice(5)));
    expect(progress).toEqual([200, 400, 450]);
    expect(report.map((i) => `${i.kind}:${i.key}`)).toEqual(ids);
    expect(report.every((i) => i.action === "create")).toBe(true);
  });

  test("after a chunk fails, trying again keeps what the first try made as made", async () => {
    const { api, inputs } = server((call) => call === 2);
    const done = new Map<string, ImportItemResult>();
    const input = { bundle: many, pick: ids, enableSkills: [] };
    await expect(applyInChunks(api, "org", input, done)).rejects.toThrow("down");
    const report = await applyInChunks(api, "org", input, done);
    expect(inputs).toHaveLength(5);
    expect(report).toHaveLength(450);
    // The first 200 come back unchanged from the server on the second try: still counted as made.
    expect(report.every((i) => i.action === "create")).toBe(true);
  });
});
