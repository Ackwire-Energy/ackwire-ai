import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectedApp, PersonalToken } from "@agenteschat/client";
import { appFacts, appMark, appsSettingsUrl, tokenFacts } from "@agenteschat/client/lib/apps";
import { appVia } from "@agenteschat/client/lib/via";
import { markOf } from "@agenteschat/ui/brand/marks";
import { visibleSections } from "../../src/features/settings/logic";
import { translator } from "./fixtures";

const NOW = new Date("2026-11-01T12:00:00Z");
const app = (over: Partial<ConnectedApp> = {}): ConnectedApp => ({
  id: "a",
  kind: "oauth",
  displayKind: "verified",
  name: "Claude",
  host: "claude.ai",
  brand: "claude",
  access: "write",
  connectedAt: "2026-10-20T12:00:00Z",
  lastUsedAt: "2026-11-01T11:30:00Z",
  ...over,
});

describe("Apps de IA on the phone (ADR 0119)", () => {
  test("everyone opens it, first, under Você", () => {
    const first = visibleSections(undefined)[0];
    expect([first?.id, first?.group, first?.href]).toEqual(["apps", "you", "/settings/apps"]);
  });

  test("each row's mark: the brand's own, the computer, or one letter that is never a mark", () => {
    const brand = appMark(app());
    expect(brand).toEqual({ kind: "brand", id: "claude" });
    expect(appMark(app({ brand: null, displayKind: "loopback" }))).toEqual({ kind: "computer" });
    const fake = appMark(app({ brand: null, displayKind: "https", name: "claude" }));
    expect(fake).toEqual({ kind: "initial", letter: "C" });
    expect(markOf(fake.kind === "initial" ? fake.letter : "")).toBeNull();
    expect(markOf("vscode")).toBe("vscode");
    expect(markOf("cursor")).toBe("cursor");
  });

  test("the line under each name, in both languages", async () => {
    const pt = await translator("pt-BR");
    const en = await translator("en");
    expect(appFacts(pt, "pt-BR", app(), NOW)).toBe("claude.ai · Conectado 20 out · Usado há 30 min");
    expect(appFacts(en, "en", app({ displayKind: "loopback", host: null, lastUsedAt: null }), NOW)).toBe(
      "on this computer · Connected Oct 20 · Never used",
    );
    const token: PersonalToken = {
      id: "t",
      name: "Blender",
      access: "read",
      createdAt: "2026-10-01T00:00:00Z",
      expiresAt: null,
      lastUsedAt: null,
    };
    expect(tokenFacts(pt, "pt-BR", token, NOW)).toBe("Sem validade · Nunca usado");
  });

  test("Conectar um app opens the web's section; the via tag reads only an app's meta", () => {
    expect(appsSettingsUrl("https://agentes.chat", "o-1")).toBe("https://agentes.chat/org/o-1/settings/apps");
    expect(appVia({ via: { kind: "app", name: " Cursor ", brand: "cursor" } })).toEqual({
      name: "Cursor",
      brand: "cursor",
    });
    expect(appVia({ via: { kind: "app", name: "" } })).toBeNull();
    expect(appVia(null)).toBeNull();
  });

  test("the screen is in the stack, pushed", () => {
    const layout = readFileSync(join(import.meta.dir, "..", "..", "app", "(app)", "_layout.tsx"), "utf8");
    expect(layout).toContain(`name="settings/apps" options={{ ...pushed, ...scrollUnder }}`);
  });
});
