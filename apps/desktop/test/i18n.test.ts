import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { LOCALES } from "@agenteschat/i18n/locale";
import { checkLocale } from "@agenteschat/i18n/testing";
import identical from "../../../packages/i18n/test/identical.json";
import { leaves as entries } from "../../../packages/i18n/test/leaves";
import { filesNamingMakers } from "../../../packages/i18n/test/maker-words";
import { unplainLeaves } from "../../../packages/i18n/test/plain-marks";
import { misplaced, staleLines } from "../../../packages/i18n/test/setups";
import {
  createDesktopI18n,
  DESKTOP_STRINGS,
  desktopStrings,
  loadDesktopI18n,
  pickLocale,
  switchDesktopLocale,
  withDesktopKeys,
} from "../src/i18n";
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

describe("desktop strings", () => {
  test("every language against English: keys, plural forms, placeholders, tags (ADR 0122)", () => {
    for (const { code, ready } of LOCALES.filter((l) => l.code !== "en")) {
      const same = (identical.desktop as Record<string, string[]>)[code] ?? [];
      const problems = checkLocale({ source: desktopEn, target: DESKTOP_STRINGS[code], code, ready, identical: same });
      expect({ code, problems }).toEqual({ code, problems: [] });
    }
    // A language with nothing yet reads English, its device names too.
    expect(desktopStrings("ja").device.windows).toBe(desktopEn.device.windows);
  });

  test("no empty strings and no internal names in the UI", () => {
    for (const s of [...values(desktopPtBR), ...values(desktopEn)]) {
      expect(s.trim().length).toBeGreaterThan(0);
      expect(s).not.toMatch(/\b(runner|MCP|protocol|protocolo|sidecar|Tauri|PGlite)\b/i);
    }
  });

  test("no semicolon, no em dash", () => {
    expect([desktopEn, desktopPtBR].flatMap((tree) => unplainLeaves(tree))).toEqual([]);
  });

  test("words true in every setup", () => {
    const desktop = (tree: object) => entries(tree).map(([k, v]): [string, string] => [`desktop.${k}`, String(v)]);
    const en = desktop(desktopEn);
    const pt = desktop(desktopPtBR);
    expect([...misplaced(en, "en"), ...misplaced(pt, "pt-BR")]).toEqual([]);
    const keys = [...en, ...pt].map(([k]) => k);
    expect(staleLines(keys, "desktop.")).toEqual([]);
  });

  test("Claude and ChatGPT, not their makers, in what the app shows", () => {
    const app = join(import.meta.dir, "..");
    expect(filesNamingMakers([join(app, "src")]).map((f) => relative(app, f))).toEqual([]);
  });

  test("a path to a setting stays on one line: no-break spaces around its ›", () => {
    for (const tree of [desktopPtBR, desktopEn]) {
      const paths = values(tree).filter((s) => s.includes("›"));
      expect(paths.length).toBeGreaterThanOrEqual(1);
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
    expect(pt.t("desktop.orgCount", { count: 1 })).toBe("1 workspace");
    expect(pt.t("desktop.orgCount", { count: 2 })).toBe("2 workspaces");
    const en = createDesktopI18n("en");
    expect(en.t("desktop.tray.now")).toBe("Now");
  });

  test("the Mac lists only ready languages as the app's", async () => {
    const plist = await Bun.file(join(import.meta.dir, "../src-tauri/Info.plist")).text();
    const listed = plist.match(/<key>CFBundleLocalizations<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
    expect([...listed.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1])).toEqual(
      LOCALES.filter((l) => l.ready).map((l) => l.code),
    );
  });

  test("the Mac's permission prompts in every language, each file in the bundle", async () => {
    const tauri = join(import.meta.dir, "../src-tauri");
    const plist = await Bun.file(join(tauri, "Info.plist")).text();
    const prompts = [...plist.matchAll(/<key>(NS\w+UsageDescription)<\/key>/g)].map((m) => m[1]).sort();
    expect(prompts.length).toBe(5);
    const config = await Bun.file(join(tauri, "tauri.macos.conf.json")).json();
    const files: Record<string, string> = config.bundle.macOS.files;
    for (const { code } of LOCALES.filter((l) => l.ready && l.code !== "en")) {
      const path = `locales/${code}.lproj/InfoPlist.strings`;
      expect({ code, mapped: files[`Resources/${code}.lproj/InfoPlist.strings`] }).toEqual({ code, mapped: path });
      const strings = [...(await Bun.file(join(tauri, path)).text()).matchAll(/^"(\w+)" = "([^"]+)";$/gm)];
      expect({ code, keys: strings.map((m) => m[1]).sort() }).toEqual({ code, keys: prompts });
    }
  });

  test("the Windows installer has our words in each language it lists", async () => {
    const tauri = join(import.meta.dir, "../src-tauri");
    const config = await Bun.file(join(tauri, "tauri.windows.conf.json")).json();
    const nsi = await Bun.file(join(tauri, "installer/installer.nsi")).text();
    const lines = [...nsi.matchAll(/^LangString (\w+) \$\{LANG_(\w+)\} "[^"]+"$/gm)];
    const keysOf = (lang: string) =>
      lines
        .filter((m) => m[2] === lang)
        .map((m) => m[1])
        .sort();
    const listed: string[] = config.bundle.windows.nsis.languages;
    // A LangString for a language the config leaves out fails makensis (its LANG_ constant is undefined).
    expect([...new Set(lines.map((m) => m[2]))].sort()).toEqual(listed.map((l) => l.toUpperCase()).sort());
    const english = keysOf("ENGLISH");
    expect(english.length).toBe(11);
    for (const lang of listed) expect({ lang, keys: keysOf(lang.toUpperCase()) }).toEqual({ lang, keys: english });
  });

  test("a window loads only its language and English, and the next one when picked", async () => {
    const i18n = await loadDesktopI18n("pt-BR", "windows");
    expect(i18n.t("desktop.place.here")).toBe("Neste PC");
    expect(Object.keys(i18n.store.data).sort()).toEqual(["en", "pt-BR"]);
    switchDesktopLocale(i18n, "ja", "windows");
    await new Promise<void>((done) => i18n.on("languageChanged", () => done()));
    expect(Object.keys(i18n.store.data).sort()).toEqual(["en", "ja", "pt-BR"]);
    expect(i18n.t("desktop.tray.now")).toBe("現在");
  });

  test("this computer's name fills {{device}} everywhere, by system and language", () => {
    expect(createDesktopI18n("pt-BR", "mac").t("desktop.tray.calmBody")).toBe(
      "Os agentes usam este Mac quando precisam.",
    );
    expect(createDesktopI18n("pt-BR", "windows").t("desktop.place.here")).toBe("Neste PC");
    expect(createDesktopI18n("pt-BR", "linux").t("desktop.link.chipHere")).toBe("Este computador");
    expect(createDesktopI18n("en", "linux").t("desktop.connect.httpRefused", { host: "192.168.1.20:3000" })).toBe(
      "192.168.1.20:3000 doesn't use a secure connection (https), and only servers on this computer may go without one. Use its https address or its Tailscale one.",
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
      "cover.otherServer",
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
      "prefs.general.behavior",
      "prefs.general.launchTitle",
      "prefs.general.notifySiteTitle",
      "prefs.general.notifySiteDesc",
      "prefs.general.menuBarTitle",
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
    expect(pickLocale(["xx-XX"])).toBe("en");
  });
});
