import { expect, test } from "bun:test";
import { isInviteToken } from "../../src/features/auth/links";
import {
  emailsFrom,
  HOST,
  introducesAt,
  inviteEach,
  nextStep,
  OPTIONAL,
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

test("the import step shows each app's official logo: the files the web app ships", async () => {
  const phone = (name: string) => Bun.file(new URL(`../../assets/images/brands/${name}`, import.meta.url).pathname);
  const web = (name: string) => Bun.file(new URL(`../../../web/public/brands/${name}`, import.meta.url).pathname);
  // OpenBot has no vector logo: its raster, byte for byte.
  expect(Buffer.from(await phone("openbot.png").arrayBuffer())).toEqual(
    Buffer.from(await web("openbot.png").arrayBuffer()),
  );
  // OpenMausBot's SVG, rendered for the phone at 96 px (the PNG header's width and height).
  expect(await web("openmausbot.svg").exists()).toBe(true);
  const png = new DataView(await phone("openmausbot.png").arrayBuffer());
  expect([png.getUint32(16), png.getUint32(20)]).toEqual([96, 96]);
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
  expect(stepText(en, "done", acme)[1]).toBe("Ada, Theo and Lia are already in #general.");
  const pt = await translator("pt-BR");
  expect(stepText(pt, "done", acme)).toEqual(["Boas-vindas à Acme", "Ada, Theo e Lia já estão no #general."]);
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
