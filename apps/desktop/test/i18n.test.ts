import { describe, expect, test } from "bun:test";
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
      expect(s).not.toMatch(/\b(runner|MCP|protocol|protocolo|sidecar|Tauri)\b/i);
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

  test("picks the Mac's language", () => {
    expect(pickLocale(["pt-PT"])).toBe("pt-BR");
    expect(pickLocale(["en-GB", "pt-BR"])).toBe("en");
    expect(pickLocale(["fr-FR"])).toBe("pt-BR");
  });
});
