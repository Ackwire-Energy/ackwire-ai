import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { isInviteToken } from "../../src/features/auth/links";
import { stepFailedText, zoneCity, zoneLabel } from "../../src/features/onboarding/logic";
import { translator } from "./fixtures";

test("the time zone reads as its city; invitation tokens only url-safe", () => {
  expect(zoneCity("America/Sao_Paulo")).toBe("Sao Paulo");
  // Its name in the person's language where the engine has one, else the city.
  expect(zoneLabel("America/Sao_Paulo", "pt-BR")).toMatch(/Brasília|Sao Paulo/);
  expect(zoneLabel("Not/A_Zone", "pt-BR")).toBe("A Zone");
  expect(isInviteToken("a".repeat(43))).toBe(true);
  expect(isInviteToken("../etc")).toBe(false);
  expect(isInviteToken(undefined)).toBe(false);
});

test("the import logos are the web's marks, each rendered for the phone at 96 px", async () => {
  const brands = new URL("../../assets/images/brands/", import.meta.url).pathname;
  const web = (name: string) => Bun.file(new URL(`../../../web/public/brands/${name}`, import.meta.url).pathname);
  // Each mark is the web's SVG (a dark one where the maker has one), rendered for the phone at 96 px (the PNG
  // header's width and height). No other import logo is left in the folder (Gemini's mark there is the AI
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

test("Continuar is one call: the workspace with its zones, finished, then its right hand's DM from the open's answer (#1)", () => {
  const flow = readFileSync(join(import.meta.dir, "../../src/features/onboarding/OnboardingFlow.tsx"), "utf8");
  expect(flow).toContain("createWorkspace(api, {");
  expect(flow).toContain("timezone: zone, memberTimezone: zone");
  // Nothing after it asks the server again: no zone, finish or agents of their own, no lists read before the DM opens.
  expect(flow).not.toMatch(/orgs\.(updateMe|saveOnboarding)|agents\.list|refetchType/);
  expect(flow).toContain("if (now) qc.setQueryData(keys.me, now);");
  expect(flow).toContain("if (dm?.dm) addDm(qc, orgId, dm.dm);");
  // An older self-hosted server's open says no DM: its list is read again, never waited for.
  expect(flow).toContain("else if (dm) void qc.invalidateQueries({ queryKey: keys.dms(orgId) });");
});
