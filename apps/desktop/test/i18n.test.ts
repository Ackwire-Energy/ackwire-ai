import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { filesNamingMakers } from "../../../packages/i18n/test/maker-words";
import { createDesktopI18n, pickLocale, withDesktopKeys } from "../src/i18n";
import { desktopEn } from "../src/i18n/keys.en";
import { desktopPtBR } from "../src/i18n/keys.pt-BR";

/** Every leaf path of a strings tree. */
function leaves(tree: object, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    v && typeof v === "object" ? leaves(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}
function values(tree: object): string[] {
  return Object.values(tree).flatMap((v) => (v && typeof v === "object" ? values(v as object) : [String(v)]));
}
const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe("desktop strings", () => {
  test("pt-BR and en have the same keys", () => {
    expect(leaves(desktopEn).sort()).toEqual(leaves(desktopPtBR).sort());
  });

  test("the same placeholders in both languages", () => {
    const get = (tree: object, path: string) =>
      path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], tree) as string;
    for (const path of leaves(desktopPtBR)) {
      expect({ path, vars: vars(get(desktopEn, path)) }).toEqual({ path, vars: vars(get(desktopPtBR, path)) });
    }
  });

  test("no empty strings and no internal names in the UI", () => {
    for (const s of [...values(desktopPtBR), ...values(desktopEn)]) {
      expect(s.trim().length).toBeGreaterThan(0);
      expect(s).not.toMatch(/\b(runner|MCP|protocol|protocolo|sidecar|Tauri|PGlite)\b/i);
    }
  });

  test("Claude and ChatGPT, not their makers, in what the app shows", () => {
    const app = join(import.meta.dir, "..");
    expect(filesNamingMakers([join(app, "src")]).map((f) => relative(app, f))).toEqual([]);
  });

  test("a path to a setting stays on one line: no-break spaces around its ›", () => {
    for (const tree of [desktopPtBR, desktopEn]) {
      const paths = values(tree).filter((s) => s.includes("›"));
      expect(paths.length).toBeGreaterThanOrEqual(2);
      for (const s of paths)
        expect({ s, alone: s.split("\u00a0›\u00a0").join("").includes("›") }).toEqual({ s, alone: false });
    }
  });

  test("merged under desktop.* next to the shared strings", () => {
    const res = withDesktopKeys({ "pt-BR": { translation: { a: "1" } }, en: { translation: { a: "2" } } });
    expect(res.en?.translation?.desktop).toBe(desktopEn);
    expect(res["pt-BR"]?.translation?.a).toBe("1");
  });

  test("translates with plurals in both languages", () => {
    const pt = createDesktopI18n("pt-BR");
    expect(pt.t("desktop.orgCount", { count: 1 })).toBe("1 organização");
    expect(pt.t("desktop.orgCount", { count: 2 })).toBe("2 organizações");
    const en = createDesktopI18n("en");
    expect(en.t("desktop.tray.now")).toBe("Now");
  });

  test("this computer's name fills {{device}} everywhere, by system and language", () => {
    expect(createDesktopI18n("pt-BR", "mac").t("desktop.tray.calmBody")).toBe(
      "Os agentes usam este Mac quando precisam.",
    );
    expect(createDesktopI18n("pt-BR", "windows").t("desktop.own.here")).toBe("Rodar o agentes.chat neste PC");
    expect(createDesktopI18n("pt-BR", "linux").t("desktop.link.chipHere")).toBe("Este computador");
    expect(createDesktopI18n("en", "linux").t("desktop.connect.httpRefused", { host: "192.168.1.20:3000" })).toBe(
      "192.168.1.20:3000 uses plain http, which only works on this computer. Use its Tailscale address or one with https.",
    );
    for (const s of [...values(desktopPtBR), ...values(desktopEn)]) {
      // "this Mac" always through {{device}}, so Windows and Linux read right.
      expect(s).not.toMatch(/\b(this|este|neste|deste) Mac\b/i);
    }
  });

  test("what the app shows in the Cloud names no computer", () => {
    const get = (tree: object, path: string) =>
      path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], tree);
    const cloudKeys = [
      ...leaves(desktopEn.first).map((k) => `first.${k}`),
      "servers.title",
      "servers.lead",
      "servers.cloud",
      "servers.cloudSub",
      "servers.open",
      "servers.openNow",
      "servers.add",
      "servers.manage",
      "servers.remove",
      "servers.removeTitle",
      "servers.removeBody",
      "tray.open",
      "tray.prefs",
      "tray.quit",
      "tray.label",
      "tray.waiting_one",
      "tray.waiting_other",
      "tray.nothingWaiting",
      "tray.unreachable",
      "cover.offline",
      "cover.unreachable",
      "link.question",
      "link.questionSignIn",
      "link.questionClaim",
      "link.leave",
      "link.connect",
      "link.continue",
      "link.checking",
      "link.notALink",
      "prefs.nav.general",
      "prefs.nav.servers",
      "prefs.nav.updates",
      "prefs.general.title",
      "prefs.general.lead",
      "prefs.general.behavior",
      "prefs.general.launchTitle",
      "prefs.general.notifySiteTitle",
      "prefs.general.notifySiteDesc",
      "prefs.general.dockTitle",
      "prefs.general.dockDesc",
      "prefs.general.menuBarTitle",
      "prefs.general.menuBarDesc",
      ...leaves(desktopEn.prefs.updates).map((k) => `prefs.updates.${k}`),
    ];
    for (const tree of [desktopEn, desktopPtBR]) {
      for (const key of cloudKeys) {
        const text = get(tree, key);
        expect({ key, text: typeof text }).toEqual({ key, text: "string" });
        expect({ key, text }).not.toEqual({
          key,
          text: expect.stringMatching(/\{\{device\}\}|\bMac\b|\bPC\b|computer|computador/i),
        });
      }
    }
  });

  test("picks the Mac's language", () => {
    expect(pickLocale(["pt-PT"])).toBe("pt-BR");
    expect(pickLocale(["en-GB", "pt-BR"])).toBe("en");
    expect(pickLocale(["fr-FR"])).toBe("pt-BR");
  });
});
