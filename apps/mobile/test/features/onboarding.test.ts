import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { type AiStatus, ApiError } from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
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
  noComputerOf,
  OPTIONAL,
  PRESET_LOOK,
  PRESET_ROWS,
  PRESETS,
  type Preset,
  phoneStepOf,
  presetsMade,
  prevStep,
  progressAt,
  resumeOf,
  STEPS,
  serverStepOf,
  setUpElsewhere,
  stepFailedText,
  stepText,
  stepToSave,
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

test("the server keeps the web's steps: the phone's AI is part of its agents, and the web's computer resumes there", () => {
  expect(STEPS.map(serverStepOf)).toEqual(["workspace", "context", "import", "agents", "agents", "team", "done"]);
  expect(phoneStepOf("computer")).toBe("agents");
  for (const step of ["workspace", "context", "import", "agents", "team", "done"] as const)
    expect(phoneStepOf(step)).toBe(step);
});

test("each step reached is saved, as the server counts them; one no further than it has saves nothing", () => {
  // Creating the workspace passed the first step: the context step is where it is.
  expect(stepToSave("import", 1)).toBe("import");
  // The phone's AI step is the server's agents: reached with the agents, nothing more to save.
  expect(stepToSave("agents", 2)).toBe("agents");
  expect(stepToSave("ai", 4)).toBeNull();
  expect(stepToSave("team", 4)).toBe("team");
  expect(stepToSave("done", 5)).toBe("done");
  // Back and on again: already saved.
  expect(stepToSave("context", 4)).toBeNull();
});

test("a resume opens the workspace where the server has it, with the team made there, never the first step", async () => {
  const t = await translator("pt-BR");
  const saved = { orgId: "o", generalChannelId: "g", step: "computer" as const };
  const theo = { id: "t", name: "Theo", handle: "theo", appearance: PRESET_LOOK.theo };
  const ada = { id: "a", name: "Ada", handle: "ada", appearance: PRESET_LOOK.ada };
  // Made on the web, Theo and Ada; an imported agent isn't a preset.
  const r = resumeOf(t, saved, [theo, ada, { id: "m", name: "Morgan", handle: "lead" }]);
  expect(r).toEqual({
    created: { orgId: "o", generalChannelId: "g" },
    ids: { theo: "t", ada: "a" },
    handles: { theo: "theo", ada: "ada" },
    chosen: new Set(["ada", "theo"]),
    // The web's computer step (after its agents): the phone has none, so its agents.
    reached: 4,
    step: "agents",
  });
  // No team yet: the picks stay as they are.
  expect(resumeOf(t, { ...saved, step: "import" }, []).chosen).toBeNull();
  // A create cut short before the look was saved: still Ada, not made again.
  expect(presetsMade(t, [{ id: "x", name: "Ada", handle: "ada", appearance: null }]).ids).toEqual({ ada: "x" });
});

test("a resume never opens behind what the workspace shows was passed, whatever step an older app saved", async () => {
  const t = await translator("pt-BR");
  const saved = { orgId: "o", generalChannelId: "g", step: "import" as const };
  const theo = { id: "t", name: "Theo", handle: "theo", appearance: PRESET_LOOK.theo };
  const ada = { id: "a", name: "Ada", handle: "ada", appearance: PRESET_LOOK.ada };
  // The team made and the import in, while the server still says the import: the web's computer step, its agents here.
  expect(resumeOf(t, saved, [theo, ada], true)).toMatchObject({ reached: 4, step: "agents" });
  // An import picked and never applied, or a create cut short before the guide: where it was, to be made whole.
  expect(resumeOf(t, saved, [theo, ada], false)).toMatchObject({ reached: 2, step: "import" });
  expect(resumeOf(t, { ...saved, step: "agents" }, [theo], false)).toMatchObject({ reached: 3, step: "agents" });
});

test("a create that gives back the workspace being set up on the web: past its first steps, nothing is written over it", () => {
  const org = (step: "context" | "agents") => [
    { id: "o", name: "Acme", role: "owner" as const, onboarding: { step, generalChannelId: "g" } },
  ];
  expect(setUpElsewhere(org("agents"), "o")).toBe(true);
  // New (or still at its first step): the phone's time zone and logo go to it.
  expect(setUpElsewhere(org("context"), "o")).toBe(false);
  expect(setUpElsewhere([], "o")).toBe(false);
  expect(setUpElsewhere(undefined, "o")).toBe(false);
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
  // header's width and height). Create agent's import step shows the rest. No other import logo is left in the folder (Gemini's mark there is the AI
  // pickers', VS Code's the AI apps').
  const notImports = new Set(["gemini.png", "soniox.png", "vscode.png"]);
  const rendered: [phone: string, web: string][] = [
    ["chatgpt-dots.png", "chatgpt-dots.svg"],
    ["grok-bot-dark.png", "grok-bot-dark.svg"],
    ["grok-bot.png", "grok-bot.svg"],
    ["hermes-dark.png", "hermes-dark.svg"],
    ["hermes.png", "hermes.svg"],
    ["openbotrun.png", "openbotrun.svg"],
    ["openclaw.png", "openclaw.svg"],
    ["openmausbot.png", "openmausbot.svg"],
    ["paperclip-dark.png", "paperclip-dark.svg"],
    ["paperclip.png", "paperclip.svg"],
  ];
  const pngs = readdirSync(brands).filter((f) => f.endsWith(".png") && !notImports.has(f));
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
    "Sign in with your AI plan: no\u00a0API\u00a0key needed.",
  ]);
  expect(stepText(en, "ai", { ...acme, aiSaved: true })[1]).toBe("Saved. Every agent without a plan thinks with it.");
  // A self-hosted workspace with no computer yet: a plan has nowhere to sign in.
  expect(stepText(en, "ai", { ...acme, noComputer: true })[1]).toBe(
    "Your agents think with an API\u00a0key, or with your AI plan on a computer you connect.",
  );
  expect(stepText(en, "ai", { ...acme, noComputer: true, aiSaved: true })[1]).toBe(
    "Saved. Every agent without a plan thinks with it.",
  );
  // The link and the emails say how; their own notes say what happens.
  expect(stepText(en, "team", acme)).toEqual(["Who else works with you?"]);
  expect(stepText(en, "done", { ...acme, chosen: new Set<Preset>(["ada"]) })).toEqual([
    "Welcome to Acme",
    "Ada is already in #general.",
  ]);
  // In the team's order, as the web's welcome; then the invitations emailed, if any.
  expect(stepText(en, "done", acme)[1]).toBe("Theo, Ada, and Lia are already in #general.");
  expect(stepText(en, "done", { ...acme, invited: 2 })[1]).toBe(
    "Theo, Ada, and Lia are already in #general. We emailed 2 invitations.",
  );
  const pt = await translator("pt-BR");
  expect(stepText(pt, "done", acme)).toEqual(["Boas-vindas à Acme", "Theo, Ada e Lia já estão no #general."]);
  expect(stepText(pt, "done", { ...acme, chosen: new Set<Preset>() })[1]).toBe(
    "O #general está pronto. Crie um agente quando quiser.",
  );
  expect(stepText(pt, "import", acme)[1]).toBe("Traga pela web, em Configurações\u00a0›\u00a0Importar e exportar.");
});

test("no computer: a self-hosted workspace whose list came back empty, not one still loading, not the Cloud", () => {
  expect(noComputerOf("selfhost", [])).toBe(true);
  expect(noComputerOf("selfhost", undefined)).toBe(false);
  expect(noComputerOf("selfhost", [{ id: "m1" }])).toBe(false);
  expect(noComputerOf("cloud", [])).toBe(false);
  // Neither the setup nor the server said which edition yet.
  expect(noComputerOf(null, [])).toBe(false);
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

test("a second workspace refused while one isn't active: the facts, with no plan or way to pay (store rules)", async () => {
  const refused = new ApiError(403, "org.create_unpaid", "You already have a workspace waiting for a plan", {
    orgId: "o1",
  });
  for (const lng of ["pt-BR", "en"] as const) {
    const t = await translator(lng);
    const said = knownErrorText(t, refused, lng);
    expect(said).toBe(t("standing.createInactive"));
    expect(said).not.toMatch(/plan|pag|pay|escolh|choose/i);
  }
});

test("a step that failed says why the server refused it, else that it didn't save", async () => {
  const pt = await translator("pt-BR");
  const refused = (params?: Record<string, unknown>) =>
    new ApiError(403, "org.create_refused", "You can't create a workspace right now", params);
  expect(stepFailedText(pt, refused({ cloud: true }))).toBe(
    "Você não pode criar um workspace enquanto a sua conta ou um dos seus workspaces estiver com restrição. Para contestar, escreva para legal@agentes.chat.",
  );
  expect(stepFailedText(pt, refused())).toBe("Você não pode criar um workspace agora.");
  const inviteOnly = new ApiError(403, "org.create_invite_only", "New workspaces need an invitation for now");
  expect(stepFailedText(pt, inviteOnly)).toBe("Novos workspaces precisam de convite por enquanto.");
  expect(stepFailedText(await translator("en"), inviteOnly)).toBe("New workspaces need an invitation for now.");
  expect(stepFailedText(pt, new ApiError(500, "internal", "x"))).toBe(pt("mobile.onb.failed"));
  expect(stepFailedText(pt, new TypeError("Network request failed"))).toBe(pt("mobile.onb.failed"));
});
