import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentProposalCard } from "../src/api/types";
import {
  actionCardOf,
  agentProposalOf,
  connectAppDone,
  draftLevels,
  draftMailLevels,
  installSkillDone,
  inviteDone,
  mayContinueStretch,
  proposalLines,
  proposalStatus,
  skillUpdateState,
  stretchCardOf,
  stretchCardText,
  suggestedAiText,
} from "../src/lib/action-cards";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-30T12:00:00Z");
const card = (patch: Partial<AgentProposalCard> = {}): AgentProposalCard => ({
  kind: "agent_proposal",
  forUserId: "u1",
  params: {
    draft: {
      name: "Nina",
      handle: "nina",
      role: "Designer",
      instructions: "Desenha.",
      appearance: null,
      channelIds: [],
      access: [
        { connectionId: "c-github", level: "write" },
        { connectionId: "c-linear", level: "read" },
      ],
      ai: { kind: "model" },
    },
    why: "Para o design.",
  },
  state: "pending",
  agentId: null,
  decidedByUserId: null,
  decidedAt: null,
  expiresAt: new Date(NOW + HOUR).toISOString(),
  ...patch,
});

test("a proposal is an action card of its own; a Connect card stays one", () => {
  expect(actionCardOf({ actionCard: card() })?.kind).toBe("agent_proposal");
  expect(agentProposalOf({ actionCard: card() })?.params.draft.handle).toBe("nina");
  const connect = { actionCard: { kind: "connect_ai", forUserId: null, params: { why: "x", agentIds: [] } } };
  expect(actionCardOf(connect)?.kind).toBe("connect_ai");
  expect(agentProposalOf(connect)).toBeNull();
  expect(agentProposalOf({ actionCard: { kind: "agent_proposal" } })).toBeNull();
});

test("where it stands: open until a day passes (also while someone creates it), then what was decided", () => {
  expect(proposalStatus(card(), NOW)).toBe("open");
  expect(proposalStatus(card({ state: "creating" }), NOW)).toBe("open");
  expect(proposalStatus(card(), NOW + 2 * HOUR)).toBe("expired");
  expect(proposalStatus(card({ state: "created", agentId: "a1" }), NOW + 2 * HOUR)).toBe("created");
  expect(proposalStatus(card({ state: "denied" }), NOW)).toBe("denied");
});

test("the draft's levels by connection, and the AI it suggests in words", () => {
  expect(draftLevels(card().params.draft)).toEqual({ "c-github": "write", "c-linear": "read" });
  const t = ((key: string, values?: Record<string, string>) =>
    values ? `${key}:${JSON.stringify(values)}` : key) as unknown as TFunction;
  expect(suggestedAiText(t, { kind: "model" })).toBe("actionCard.agentProposal.aiModel");
  expect(suggestedAiText(t, { kind: "none" })).toBe("actionCard.agentProposal.aiNone");
  expect(
    suggestedAiText(t, { kind: "account", brain: "codex", machineId: "m", accountId: "a", label: "ChatGPT Plus" }),
  ).toBe('actionCard.agentProposal.aiAccount:{"account":"ChatGPT Plus"}');
});

test("what a proposed agent gets, a line each: who gives what the viewer can't, and what one click gave", () => {
  const ROUTINE = {
    name: "E-mails do dia",
    prompt: "Resume a caixa de entrada.",
    schedule: "todo dia ao meio-dia",
    rule: null,
    cron: "0 12 * * *",
    timezone: "America/Sao_Paulo",
    description: "Every day, at 12:00",
    report: "when_new" as const,
    access: "read" as const,
    reportsIn: "ch-private",
  };
  const draft = {
    ...card().params.draft,
    channelIds: ["ch-private"],
    access: [{ connectionId: "c-github", level: "read" as const }],
    mail: [
      { accountId: "mb-ana", address: "ana@acme.com", level: "read" as const, ownerUserId: "u-ana" },
      { accountId: "mb-bia", address: "bia@acme.com", level: "write" as const, ownerUserId: "u-bia" },
    ],
    routine: ROUTINE,
  };
  // Open now (the lines read the clock).
  const open = card({ params: { draft, why: "x" }, expiresAt: new Date(Date.now() + HOUR).toISOString() });
  const at = (lines: ReturnType<typeof proposalLines>) => lines.map((l) => [l.key, l.given, l.needs]);
  // Ana, an admin: everything but Bia's mailbox, which only Bia gives.
  expect(at(proposalLines(open, { userId: "u-ana", admin: true }))).toEqual([
    ["channel:ch-private", null, null],
    ["app:c-github", null, null],
    ["mail:mb-ana", null, null],
    ["mail:mb-bia", null, { who: "person", userId: "u-bia" }],
    ["routine", null, null],
  ]);
  // A member who isn't an admin: the channel and the app wait for one, and so does the routine reporting in that
  // channel; her own mailbox is hers to give, admin or not.
  expect(at(proposalLines(open, { userId: "u-ana", admin: false }))).toEqual([
    ["channel:ch-private", null, { who: "admin" }],
    ["app:c-github", null, { who: "admin" }],
    ["mail:mb-ana", null, null],
    ["mail:mb-bia", null, { who: "person", userId: "u-bia" }],
    ["routine", null, { who: "admin" }],
  ]);
  expect(draftMailLevels(draft, "u-ana")).toEqual({ "mb-ana": "read" });
  // Created in one click by Ana: what it got takes a check, Bia's mailbox still waits for her.
  const made = card({
    params: { draft, why: "x" },
    state: "created",
    agentId: "a-caio",
    applied: { channelIds: ["ch-private"], connectionIds: ["c-github"], mailAccountIds: ["mb-ana"] },
    routineId: "r-1",
  });
  expect(at(proposalLines(made, { userId: "u-ana", admin: true }))).toEqual([
    ["channel:ch-private", true, null],
    ["app:c-github", true, null],
    ["mail:mb-ana", true, null],
    ["mail:mb-bia", false, { who: "person", userId: "u-bia" }],
    ["routine", true, null],
  ]);
  // Created by someone who couldn't put it in the channel: its routine wasn't made and waits for an admin.
  const stuck = card({
    params: { draft, why: "x" },
    state: "created",
    agentId: "a-caio",
    applied: { channelIds: [], connectionIds: [], mailAccountIds: [] },
    routineId: null,
  });
  expect(at(proposalLines(stuck, { userId: "u-ana", admin: true })).at(-1)).toEqual([
    "routine",
    false,
    { who: "admin" },
  ]);
  // Created from the review: the card can't say what it got, so no line says it.
  const reviewed = card({ params: { draft, why: "x" }, state: "created", agentId: "a-caio" });
  expect(proposalLines(reviewed, { userId: "u-ana", admin: true }).every((l) => l.given === null && !l.needs)).toBe(
    true,
  );
});

test("a stretch's pause card (ADR 0089): read safely, said with the agents' names, Continuar for the right people", () => {
  const raw = {
    kind: "stretch_paused",
    stretchId: "s1",
    state: "paused",
    reason: "runs",
    limit: 50,
    forUserId: "u-ana",
    agentIds: ["ada", "theo"],
    held: [{ agentId: "ada", messageId: "m9", trigger: "mention" }],
    continuedByUserId: null,
    continuedAt: null,
  };
  const card = stretchCardOf({ actionCard: raw });
  expect(card).toMatchObject({ kind: "stretch_paused", state: "paused", reason: "runs", limit: 50 });
  expect(actionCardOf({ actionCard: raw })?.kind).toBe("stretch_paused");
  expect(stretchCardOf({ actionCard: { kind: "stretch_paused" } })).toBeNull();
  if (!card) throw new Error("no card");
  const t = ((key: string, values?: Record<string, unknown>) =>
    key === "format.list"
      ? new Intl.ListFormat("pt-BR").format(values?.names as string[])
      : `${key}:${JSON.stringify(values)}`) as unknown as TFunction;
  expect(stretchCardText(t, card, ["Ada", "Theo"])).toBe(
    'chat.body.stretch_paused_runs:{"agents":"Ada e Theo","count":2}',
  );
  const spend = { ...card, reason: "spend" as const, limit: 20, agentIds: ["ada"] };
  expect(stretchCardText(t, spend, ["Ada"])).toBe(
    'chat.body.stretch_paused_spend:{"agents":"Ada","count":1,"percent":20}',
  );
  expect(stretchCardText(t, spend, ["Ada"], "US$ 10")).toBe(
    'chat.body.stretch_paused_spend:{"agents":"Ada","count":1,"percent":20,"context":"cost","amount":"US$ 10"}',
  );
  const owner = (id: string) => (id === "theo" ? "u-bia" : null);
  expect(mayContinueStretch(card, "u-ana", owner, false)).toBe(true);
  expect(mayContinueStretch(card, "u-bia", owner, false)).toBe(true);
  expect(mayContinueStretch(card, "u-caio", owner, false)).toBe(false);
  expect(mayContinueStretch(card, "u-caio", owner, true)).toBe(true);
  expect(mayContinueStretch(card, null, owner, false)).toBe(false);
});

test("connect-an-app and invite cards: read from the message, a plain http address dropped, done from live data", () => {
  const app = actionCardOf({
    actionCard: {
      kind: "connect_app",
      forUserId: "u1",
      params: { url: "https://mcp.acme.dev/mcp", why: "MCP da Acme" },
    },
  });
  expect(app).toEqual({ kind: "connect_app", forUserId: "u1", url: "https://mcp.acme.dev/mcp", why: "MCP da Acme" });
  expect(
    actionCardOf({ actionCard: { kind: "connect_app", forUserId: null, params: { url: "http://x", why: "" } } }),
  ).toEqual({ kind: "connect_app", forUserId: null, why: "" });
  if (app?.kind !== "connect_app") throw new Error("not a connect card");
  const server = (serverUrl: string) => ({ def: null, server: { serverUrl } as never });
  expect(connectAppDone(app, [server("https://other.dev/mcp")])).toBe(false);
  expect(connectAppDone(app, [server("https://MCP.acme.dev/mcp/")])).toBe(true);
  const linear = { kind: "connect_app" as const, forUserId: null, connector: "linear", why: "" };
  expect(connectAppDone(linear, [{ def: { id: "linear" } as never, server: null }])).toBe(true);
  expect(connectAppDone({ kind: "connect_app", forUserId: null, why: "" }, [server("https://x.dev")])).toBe(false);

  const invite = actionCardOf({
    actionCard: { kind: "invite_people", forUserId: "u1", params: { emails: ["ana@x.com", 3], why: "Design" } },
  });
  expect(invite).toEqual({ kind: "invite_people", forUserId: "u1", emails: ["ana@x.com"], why: "Design" });
  expect(actionCardOf({ actionCard: { kind: "invite_people", params: { emails: [] } } })).toBeNull();
  if (invite?.kind !== "invite_people") throw new Error("not an invite card");
  expect(inviteDone(invite, [])).toBe(false);
  expect(inviteDone(invite, ["ANA@x.com"])).toBe(true);
});

test("skill cards: install done once a skill has its link; each update's state from live data after the card", () => {
  const link = "https://github.com/acme/skills/tree/main/deploy";
  const install = actionCardOf({
    actionCard: { kind: "install_skill", forUserId: "u1", params: { url: link, why: "Deploys" } },
  });
  expect(install).toEqual({ kind: "install_skill", forUserId: "u1", url: link, why: "Deploys" });
  expect(
    actionCardOf({ actionCard: { kind: "install_skill", forUserId: null, params: { url: "http://x" } } }),
  ).toBeNull();
  if (install?.kind !== "install_skill") throw new Error("no card");
  expect(installSkillDone(install, [{ sourceUrl: null }])).toBe(false);
  expect(installSkillDone(install, [{ sourceUrl: link }])).toBe(true);

  expect(
    actionCardOf({ actionCard: { kind: "update_skills", forUserId: null, params: { skillIds: ["s1", 2], why: "" } } }),
  ).toEqual({ kind: "update_skills", forUserId: null, skillIds: ["s1"], why: "" });
  const posted = "2026-11-03T10:00:00.000Z";
  const waiting = { scripts: ["run.sh"], at: posted, dismissed: false };
  expect(skillUpdateState({ checkedAt: null, pendingUpdate: null }, posted)).toBe("open");
  expect(skillUpdateState({ checkedAt: "2026-11-03T09:00:00.000Z", pendingUpdate: null }, posted)).toBe("open");
  expect(skillUpdateState({ checkedAt: "2026-11-03T11:00:00.000Z", pendingUpdate: waiting }, posted)).toBe("waiting");
  expect(
    skillUpdateState({ checkedAt: "2026-11-03T11:00:00.000Z", pendingUpdate: { ...waiting, dismissed: true } }, posted),
  ).toBe("done");
  expect(skillUpdateState(undefined, posted)).toBe("done");
});
