import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tailscaleFrom } from "../src/control/local-server";
import { desktopEn } from "../src/i18n/keys.en";
import { desktopPtBR } from "../src/i18n/keys.pt-BR";

const COVER = join(import.meta.dir, "../src/cover");
const read = (file: string) => readFileSync(file, "utf8");

test("the cover names only fonts its own page loads (it doesn't load the app's styles)", () => {
  const sheets = [...read(join(COVER, "main.ts")).matchAll(/^import "([^"]+\.css)";$/gm)].map((m) =>
    read(Bun.resolveSync(m[1] as string, COVER)),
  );
  const loaded = sheets.flatMap((css) =>
    [...css.matchAll(/@font-face\s*{[^}]*?font-family:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
  );
  const named = [...read(join(COVER, "cover.css")).matchAll(/font(?:-family)?:([^;]+);/g)].flatMap((m) =>
    [...(m[1] as string).matchAll(/"([^"]+)"/g)].map((q) => q[1]),
  );
  expect(named.length).toBeGreaterThan(0);
  for (const family of named) expect(loaded).toContain(family);
});

test("Tailscale off over the server here: a Mac opens its app, Windows its icon by the clock, Linux the terminal", () => {
  expect((["mac", "windows", "linux"] as const).map(tailscaleFrom)).toEqual(["app", "tray", "terminal"]);
  // What follows "Connect Tailscale on this PC to open agentes.chat.": no sudo on Windows, the command on Linux.
  for (const { cover } of [desktopEn, desktopPtBR]) {
    expect(cover.tailnetTray).not.toMatch(/sudo|terminal/);
    expect(cover.tailnetUp).toContain("sudo tailscale up");
  }
});
