import { expect, test } from "bun:test";
import { createFakeProvider, type FakeReply } from "@agenteschat/providers/testing";
import cases from "../eval/behavior-cases.json";
import { deterministicChecks } from "../eval/behavior-checks";
import { CONNECTORS } from "../eval/behavior-fakes";
import { type BehaviorCase, runCase } from "../eval/behavior-run";

// The behavior eval's harness, driven by the fake provider: the case goes through the
// real engine path (no network). The eval itself (real model) is manual: `bun run eval:behavior`.

const all = cases as unknown as BehaviorCase[];
const byId = (id: string) => all.find((c) => c.id === id) as BehaviorCase;

test("every case is well formed: known presets, connectors and tools", () => {
  const known = new Set([
    ...Object.values(CONNECTORS).flatMap((tools) => tools.map((t) => t.name)),
    "list_issues",
    "create_issue",
    "update_issue",
    "comment_issue",
    "search_context",
    "ask_user",
    "ask_agent",
    "list_routines",
    "update_routine",
    "create_routine",
    "propose_mission",
    "add_agent_to_channel",
    "update_thread",
    "hand_off",
  ]);
  const ids = new Set<string>();
  for (const c of all) {
    expect(ids.has(c.id), c.id).toBe(false);
    ids.add(c.id);
    expect(c.expect.behavior.length, c.id).toBeGreaterThan(20);
    if (c.agent.preset) expect(["dev", "ops", "qa", "pm"]).toContain(c.agent.preset);
    for (const id of c.connectors ?? []) expect(Object.keys(CONNECTORS)).toContain(id);
    const tools = [
      ...Object.keys(c.fixtures ?? {}),
      ...(c.expect.mustCall ?? []).flatMap((g) => g.split("|")),
      ...(c.expect.mustNotExecute ?? []),
      ...(c.expect.mustNotCall ?? []),
      ...(c.expect.approval ?? []),
    ];
    for (const t of tools) expect(known.has(t), `${c.id}: ${t}`).toBe(true);
  }
});

/** A scripted model: one reply per call, in order. */
const script = (replies: FakeReply[]) => createFakeProvider((_req, n) => replies[n - 1] ?? { chunks: ["(done)"] });

test("a case runs through the real engine: prompt, fake connector tools, transcript", async () => {
  const provider = script([
    {
      chunks: [],
      toolUses: [{ name: "github_search_code", input: { query: "subscription_completed repo:lumen/app" } }],
    },
    {
      chunks: [],
      toolUses: [
        {
          name: "github_get_file_contents",
          input: { owner: "lumen", repo: "app", path: "src/review/review-prompt.ts" },
        },
      ],
    },
    { chunks: ["O pedido dispara em src/review/review-prompt.ts:40 no subscription_completed. Abro um PR que move."] },
  ]);
  const c = byId("dev-review-prompt-subscription");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 6 });

  // The engine's prompt: the preset's instructions, the org context, the granted tools.
  expect(run.system).toContain("Ada (@ada)");
  expect(run.system).toContain("Lumen é um app");
  expect(run.system).toContain("`github_get_file_contents`");
  expect(run.system).toContain("Investiga primeiro");
  const request = provider.calls[0]?.request;
  expect(request?.tools?.map((t) => t.name)).toContain("github_merge_pull_request");
  expect(provider.calls[0]?.apiKey).toBe("sk-ant-fake-key-1234");

  expect(run.calls.map((t) => [t.name, t.executed])).toEqual([
    ["github_search_code", true],
    ["github_get_file_contents", true],
  ]);
  expect(run.calls[1]?.result).toContain("StoreReview.requestReview()");
  expect(run.turns).toHaveLength(3);
  expect(run.reply).toContain("review-prompt.ts:40");
  expect(run.status).toEqual(["done"]);
  expect(run.costNanoUsd).toBeGreaterThan(0);
  expect(deterministicChecks(c.expect, run).filter((k) => !k.pass)).toEqual([]);
});

test("a sensitive call becomes an approval request and never runs", async () => {
  const provider = script([
    {
      chunks: [],
      toolUses: [{ name: "github_merge_pull_request", input: { owner: "lumen", repo: "api", pullNumber: 70 } }],
    },
  ]);
  const c = byId("dev-merge-pr-sensitive");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 4 });
  expect(run.approvals).toEqual(["github_merge_pull_request"]);
  expect(run.calls).toMatchObject([{ name: "github_merge_pull_request", executed: false }]);
  expect(run.status).toEqual(["waiting_approval"]);
  const checks = deterministicChecks(c.expect, run);
  expect(checks.find((k) => k.id === "no_sensitive_action")?.pass).toBe(true);
  expect(checks.find((k) => k.id === "requested_approval")?.pass).toBe(true);
});

test("a routine run: background work on the routine's trigger, earlier messages are history, no hand_off posts nothing", async () => {
  const provider = script([
    { chunks: [], toolUses: [{ name: "sentry_search_issues", input: { query: "is:unresolved firstSeen:-1h" } }] },
    { chunks: ["Nada novo: só o LUMEN-API-3A1, estável."] },
  ]);
  const c = byId("ops-sentry-routine-nothing-new");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 4 });
  expect(run.system).toContain("This is a routine run");
  expect(run.tools).toContain("hand_off");
  // Only the trigger started a run: the earlier routine message and the agent's old reply are history.
  expect(run.status).toEqual(["done"]);
  const history = JSON.stringify(provider.calls[0]?.request.messages);
  expect(history).toContain("Sigo acompanhando LUMEN-API-3A1");
  expect(run.noReply).toBe(true);
  expect(run.reply).toBe("");
  expect(deterministicChecks(c.expect, run).filter((k) => !k.pass)).toEqual([]);
});

test("a consultation case: the agent answers another agent's question as the person behind it", async () => {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  const provider = createFakeProvider((req, n) => {
    if (n === 1) return { chunks: [], toolUses: [{ name: "list_routines", input: {} }] };
    if (n === 2) {
      const id = uuid.exec(JSON.stringify(req.messages.at(-1)?.content))?.[0] ?? "";
      return { chunks: [], toolUses: [{ name: "update_routine", input: { id, prompt: "Peça à @ada uma análise." } }] };
    }
    return { chunks: ["Ajustei a rotina: erros novos vão para a Ada analisar na issue."] };
  });
  const c = byId("ops-consulted-on-behalf-edits-routine");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 6 });
  expect(run.system).toContain("A private conversation between agents");
  expect(run.calls.map((t) => [t.name, t.executed, t.isError])).toEqual([
    ["list_routines", true, false],
    ["update_routine", true, false],
  ]);
  expect(run.triggered).toEqual([]);
  expect(deterministicChecks(c.expect, run).filter((k) => !k.pass)).toEqual([]);
});

test("act with undo: the issue is a receipt on the reply while the merge waits for approval", async () => {
  const provider = script([
    {
      chunks: [],
      toolUses: [
        { name: "create_issue", input: { title: "Preço do plano anual", assignee: "me" } },
        { name: "github_merge_pull_request", input: { owner: "lumen", repo: "api", pullNumber: 70 } },
      ],
    },
  ]);
  const c = byId("dev-organize-and-merge");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 4 });
  expect(run.system).toContain("Done right away, no approval");
  expect(run.receipts).toEqual(["issue.created"]);
  expect(run.approvals).toEqual(["github_merge_pull_request"]);
  const checks = deterministicChecks(c.expect, run);
  for (const id of ["acted_with_undo", "requested_approval", "no_sensitive_action", "no_needless_question"]) {
    expect(checks.find((k) => k.id === id)?.pass, id).toBe(true);
  }
});

test("a mission proposal carries what the agent read; one without findings is refused by the schema", async () => {
  const proposal = {
    title: "Pedido de avaliação no momento certo",
    goal: "Tirar o pedido de avaliação do subscription_completed e mostrar após a primeira meditação concluída.",
    findings: [
      {
        kind: "read",
        text: "O pedido dispara em review-prompt.ts:40, no subscription_completed.",
        refs: ["src/review/review-prompt.ts:40"],
      },
      { kind: "decision", text: "Conta como concluída a meditação até o fim ou a partir de 80%?" },
    ],
    plan: ["Tirar o gatilho do subscription_completed", "Disparar após a primeira meditação", "Teste e PR"],
  };
  const provider = script([
    { chunks: [], toolUses: [{ name: "github_search_code", input: { query: "subscription_completed" } }] },
    { chunks: [], toolUses: [{ name: "propose_mission", input: { title: "x", goal: "y", findings: [] } }] },
    { chunks: [], toolUses: [{ name: "propose_mission", input: proposal }] },
    {
      chunks: [
        "Propus a missão: o pedido dispara em review-prompt.ts:40. Falta só decidir o que conta como concluída.",
      ],
    },
  ]);
  const c = byId("dev-mission-arrives-investigated");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 6 });
  expect(run.calls.map((k) => [k.name, k.executed])).toEqual([
    ["github_search_code", true],
    ["propose_mission", false],
    ["propose_mission", true],
  ]);
  const checks = deterministicChecks(c.expect, run);
  expect(checks.find((k) => k.id === "mission_investigated")).toMatchObject({ pass: true });
  expect(checks.find((k) => k.id === "cites_evidence")?.pass).toBe(true);
});
