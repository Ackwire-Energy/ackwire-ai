import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serverText } from "@agenteschat/i18n";
import { HELP, type HelpBlock } from "@agenteschat/i18n/help";
import type { AppLocale } from "@agenteschat/i18n/locale";
import { desktopStrings } from "../src/i18n";

const REPO = join(import.meta.dir, "..", "..", "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const lines = (b: HelpBlock): string[] => (typeof b === "string" ? [b] : "list" in b ? b.list : [b.code]);

/** The folders the app keeps, as the code names them: a guide to deleting them names each one exactly. */
const FOLDERS = [".agentes", ".agentes-runner", "Ackwire AI erased", "chat.agentes.desktop", "Ackwire AI.plist"];

describe("the help page on starting over and uninstalling", () => {
  test("the folders it names are the ones the code keeps", () => {
    const local = read("apps/desktop/src-tauri/src/local_server.rs");
    expect(local).toContain('const FOLDER: &str = ".agentes";');
    expect(local).toContain('home.join(format!("Ackwire AI erased {date}"))');
    expect(read("apps/desktop/src-tauri/src/runners.rs")).toContain('home.join(".agentes-runner").join("orgs")');
    expect(JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).identifier).toBe("chat.agentes.desktop");
    // The login item is named after the app (`migrate_login_item` in lib.rs).
    expect(JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).productName).toBe("Ackwire AI");
    const selfHosting = read("SELF_HOSTING.md");
    expect(FOLDERS.filter((f) => !selfHosting.includes(f))).toEqual([]);
    // A terminal install keeps running as its own service after the app quits.
    const trash = selfHosting.slice(selfHosting.indexOf("**The Trash removes nothing.**"));
    expect(trash.slice(0, trash.indexOf("\n- "))).toContain("service uninstall");
  });

  for (const [code, pages] of Object.entries(HELP)) {
    test(`${code}: names the app's own buttons and menus, and every folder`, () => {
      const linesOf = (id: string) =>
        pages["run-on-your-computer"]?.sections.find((s) => s.id === id)?.blocks.flatMap(lines) ?? [];
      const section = pages["run-on-your-computer"]?.sections.find((s) => s.id === "uninstall");
      const text = linesOf("uninstall").join("\n");
      const d = desktopStrings(code as AppLocale);
      // Erase deletes the agents' homes for that server instead of moving them.
      expect(linesOf("uninstall").find((l) => l.includes(`**${d.server.erase}**`))).toContain("`.agentes-runner`");
      // Deleting an account belongs with signing in, and restoring it takes the screen's button.
      const restore = `**${serverText(code as AppLocale, "accountDeleting.restore")}**`;
      expect(text).not.toContain(restore);
      expect(linesOf("password").join("\n")).toContain(restore);
      const prefs = d.windowTitle.prefs;
      const names = [
        `**${prefs} › ${d.prefs.nav.servers}**`,
        `**${d.server.erase}**`,
        `**${prefs} › ${d.prefs.nav.general}**`,
        `**${d.prefs.general.launchTitle}**`,
        `**${d.tray.quit}**`,
        `**${d.tray.quitTitle}**`,
        `**${d.tray.quitConfirm}**`,
        ...FOLDERS.map((f) => `\`${f}`),
      ];
      expect({ code, missing: names.filter((n) => !text.includes(n)) }).toEqual({ code, missing: [] });
      // How an erased one comes back: its dated folder renamed to the data folder's own name.
      const paragraphs = section?.blocks.filter((b): b is string => typeof b === "string") ?? [];
      expect(paragraphs.filter((l) => l.includes("`Ackwire AI erased`") && l.includes("`.agentes`"))).toHaveLength(1);
      // Quitting comes before any deleting.
      const steps = section?.blocks.find((b): b is { list: string[] } => typeof b === "object" && "list" in b);
      expect(steps?.list.findIndex((l) => l.includes(`**${d.tray.quit}**`))).toBe(1);
      // The menu bar icon can be hidden on a Mac; the app menu's Quit (menus.rs) is always there.
      expect(steps?.list[1]).toContain("⌘Q");
      // Folders whose name starts with a dot are hidden in Finder until shown.
      expect(steps?.list.find((l) => l.includes("`.agentes`"))).toContain("⇧⌘.");
    });
  }
});
