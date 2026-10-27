import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import type { AiStatus } from "@agenteschat/client";
import { isInviteToken } from "../../src/features/auth/links";
import {
  askLineOf,
  type CrewMember,
  DEFAULT_TEAM,
  emailsFrom,
  firstAskOf,
  HOST,
  IMPORT_BRAND,
  IMPORT_ROWS,
  introducesAt,
  inviteEach,
  joiningLeft,
  nextStep,
  OPTIONAL,
  PRESET_ROWS,
  PRESETS,
  type Preset,
  prevStep,
  progressAt,
  STEPS,
  stepText,
  zoneCity,
  zoneLabel,
} from "../../src/features/onboarding/logic";
import { translator } from "./fixtures";

test("the phone's steps: no computer step; import, the AI and people are optional; the strip fills to the end", () => {
  expect([...STEPS]).toEqual(["workspace", "context", "import", "agents", "ai", "team", "done"]);
  expect([...OPTIONAL].sort()).toEqual(["ai", "import", "team"]);
  expect(progressAt("workspace")).toBe(0);
  expect(progressAt("done")).toBe(1);
  expect(progressAt("agents")).toBeCloseTo(3 / 6, 5);
  expect(nextStep("agents")).toBe("ai");
  expect(prevStep("team")).toBe("ai");
  expect(nextStep("team")).toBe("done");
  expect(prevStep("workspace")).toBeNull();
  expect(prevStep("done")).toBeNull();
  expect(prevStep("context")).toBe("workspace");
});

test("each host says hi only the first time it appears", () => {
  expect(HOST.workspace).toBe("ada");
  expect(introducesAt("workspace")).toBe(true);
  expect(introducesAt("context")).toBe(true);
  expect(introducesAt("agents")).toBe(false);
  expect(introducesAt("ai")).toBe(false);
  expect(introducesAt("team")).toBe(false);
});

test("e-mails typed or pasted: lower-cased, no repeats, the wrong ones kept apart", () => {
  expect(emailsFrom("Rafael@Acme.com, bia@acme.com;rafael@acme.com nope", ["bia@acme.com"])).toEqual({
    valid: ["rafael@acme.com"],
    invalid: ["nope"],
  });
  expect(emailsFrom("   ")).toEqual({ valid: [], invalid: [] });
});

test("the time zone reads as its city; invitation tokens only url-safe", () => {
  expect(zoneCity("America/Sao_Paulo")).toBe("Sao Paulo");
  // Its name in the person's language where the engine has one, else the city.
  expect(zoneLabel("America/Sao_Paulo", "pt-BR")).toMatch(/Brasília|Sao Paulo/);
  expect(zoneLabel("Not/A_Zone", "pt-BR")).toBe("A Zone");
  expect(isInviteToken("a".repeat(43))).toBe(true);
  expect(isInviteToken("../etc")).toBe(false);
  expect(isInviteToken(undefined)).toBe(false);
});

test("the import step names the three most used apps, in the web's order, each by its logo", async () => {
  expect(IMPORT_ROWS.map((r) => IMPORT_BRAND[r])).toEqual(["Grok Bot", "ChatGPT dots", "OpenBot.run"]);
  const brands = new URL("../../assets/images/brands/", import.meta.url).pathname;
  const web = (name: string) => Bun.file(new URL(`../../../web/public/brands/${name}`, import.meta.url).pathname);
  // Each mark is the web's SVG (a dark one where the maker has one), rendered for the phone at 96 px (the PNG
  // header's width and height). No other import logo is left in the folder (Gemini's mark there is the AI
  // pickers').
  const rendered: [phone: string, web: string][] = [
    ["chatgpt-dots.png", "chatgpt-dots.svg"],
    ["grok-bot-dark.png", "grok-bot-dark.svg"],
    ["grok-bot.png", "grok-bot.svg"],
    ["openbotrun.png", "openbotrun.svg"],
  ];
  const pngs = readdirSync(brands).filter((f) => f.endsWith(".png") && f !== "gemini.png");
  expect(pngs.sort()).toEqual(rendered.map(([png]) => png));
  for (const [png, svg] of rendered) {
    expect(await web(svg).exists()).toBe(true);
    const header = new DataView(await Bun.file(brands + png).arrayBuffer());
    expect([png, header.getUint32(16), header.getUint32(20)]).toEqual([png, 96, 96]);
  }
});

test("the team as the web has it: Theo first, everyone chosen, Ada already here and not counted", () => {
  expect([...PRESETS]).toEqual(["theo", "ada", "lia", "atlas"]);
  expect([...DEFAULT_TEAM]).toEqual([...PRESETS]);
  // The phone's own rows: Ada first ("I'm already here"), then the others in the team's order.
  expect([...PRESET_ROWS]).toEqual(["ada", "theo", "lia", "atlas"]);
  const all = new Set<Preset>(DEFAULT_TEAM);
  expect(joiningLeft(all, {})).toBe(3);
  expect(joiningLeft(all, { theo: "a1", ada: "a2" })).toBe(2);
  expect(joiningLeft(new Set<Preset>(["ada"]), {})).toBe(0);
});

const crewOf = (...keys: Preset[]): CrewMember[] =>
  keys.map((key) => ({ key, id: `id-${key}`, handle: key, name: `${key.charAt(0).toUpperCase()}${key.slice(1)}` }));

test("Done's first message: Theo offers it (no browser counted on), else Lia, else Ada", async () => {
  const en = await translator("en");
  expect(firstAskOf(en, crewOf("theo", "ada", "lia"))).toEqual({
    asker: "theo",
    text: "@theo Plan our first week: what should each of us do first?",
  });
  expect(firstAskOf(en, crewOf("ada", "lia"))?.asker).toBe("lia");
  expect(firstAskOf(en, crewOf("ada"))?.text).toBe("@ada What could you build or automate for us first?");
  expect(firstAskOf(en, [])).toBeNull();
});

test("the line under the first message: whether the agent it names can start, or that no agent has an AI", async () => {
  const en = await translator("en");
  const theo = { id: "id-theo", name: "Theo" };
  const status = (state: AiStatus["agents"][number]["state"], any = state !== "no_ai"): AiStatus => ({
    any,
    agents: [{ agentId: "id-theo", state }],
  });
  const line = (over: Partial<Parameters<typeof askLineOf>[1]>) =>
    askLineOf(en, { text: "@theo plan", mentioned: theo, status: undefined, computer: "Acme's computer", ...over });
  expect(line({ status: status("ready") })).toEqual({
    state: "ready",
    icon: "check",
    text: "Theo starts right away, in #general.",
  });
  expect(line({ status: status("waiting") })?.text).toBe("Theo starts as soon as Acme's computer is back.");
  expect(line({ status: status("no_ai") })?.text).toBe("No AI connected yet: Theo answers once you connect one.");
  // Nobody named: only that no agent has an AI, else nothing.
  expect(line({ mentioned: undefined, status: status("no_ai", false) })?.text).toBe(
    "No AI connected yet: your agents answer once you connect one.",
  );
  expect(line({ mentioned: undefined, status: status("ready") })).toBeNull();
  // No text, or the status not in yet: nothing to say.
  expect(line({ text: "  ", status: status("ready") })).toBeNull();
  expect(line({})).toBeNull();
});

test("each step's question and its one line: the phone's own where it can't do what the web does, none on Team", async () => {
  const en = await translator("en");
  const team = new Set<Preset>(["ada", "theo", "lia"]);
  const acme = { org: "Acme", chosen: team, aiSaved: false };
  expect(stepText(en, "workspace", acme)).toEqual([
    "What's your workspace called?",
    "It's where the team and the agents talk.",
  ]);
  // The phone can't import: it says where to, never the web's file and folder lead.
  expect(stepText(en, "import", acme)).toEqual([
    "Already using agents in another app?",
    "Bring them from the web, in Settings\u00a0›\u00a0Import and export.",
  ]);
  expect(stepText(en, "agents", acme)).toEqual(["Keep this team?", "Check who else joins."]);
  expect(stepText(en, "ai", acme)).toEqual([
    "Which AI will they use?",
    "Sign in with your AI plan: no API key needed.",
  ]);
  expect(stepText(en, "ai", { ...acme, aiSaved: true })[1]).toBe("Saved. Every agent without a plan thinks with it.");
  // The link and the emails say how; their own notes say what happens.
  expect(stepText(en, "team", acme)).toEqual(["Who else works with you?"]);
  expect(stepText(en, "done", { ...acme, chosen: new Set<Preset>(["ada"]) })).toEqual([
    "Welcome to Acme",
    "Ada is already in #general.",
  ]);
  // In the team's order, as the web's welcome; then the invitations emailed, if any.
  expect(stepText(en, "done", acme)[1]).toBe("Theo, Ada and Lia are already in #general.");
  expect(stepText(en, "done", { ...acme, invited: 2 })[1]).toBe(
    "Theo, Ada and Lia are already in #general. We emailed 2 invitations.",
  );
  const pt = await translator("pt-BR");
  expect(stepText(pt, "done", acme)).toEqual(["Boas-vindas à Acme", "Theo, Ada e Lia já estão no #general."]);
  expect(stepText(pt, "done", { ...acme, chosen: new Set<Preset>() })[1]).toBe(
    "O #general está pronto. Crie um agente quando quiser.",
  );
  expect(stepText(pt, "import", acme)[1]).toBe("Traga pela web, em Configurações\u00a0›\u00a0Importar e exportar.");
});

test("invitations: each is sent once, and the ones that failed are what is left to send again", async () => {
  const sent: string[] = [];
  const failed = await inviteEach(["ana@acme.com", "bia@acme", "caio@acme.com"], async (email) => {
    sent.push(email);
    if (!email.endsWith(".com")) throw new Error("invalid");
  });
  expect(sent).toEqual(["ana@acme.com", "bia@acme", "caio@acme.com"]);
  expect(failed).toEqual(["bia@acme"]);
  expect(await inviteEach(["ana@acme.com"], async () => undefined)).toEqual([]);
});
