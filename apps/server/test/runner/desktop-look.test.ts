import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DESKTOP_SIZE } from "@agenteschat/adapters/machine-protocol";
import {
  LOOK_DIR,
  LOOK_MARKER,
  LOOK_VERSION,
  lookCommand,
  lookFiles,
  lookId,
  lookTheme,
} from "../../runner/desktop-look";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const ASSETS = path.join(import.meta.dir, "..", "..", "runner", "assets");
const XFCONF = ".config/xfce4/xfconf/xfce-perchannel-xml";

const fileOf = (home: string, theme: "orchis" | "stock", name: string) => {
  const found = lookFiles(home, theme).find((f) => f.path === name);
  if (!found) throw new Error(`no ${name}`);
  return found.data;
};
const textOf = (home: string, theme: "orchis" | "stock", name: string) => fileOf(home, theme, name).toString();

/** A PNG's size from its header (IHDR). */
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/** The look's script as the runner runs it (as the agent there), in `home`. */
function apply(home: string, theme: "orchis" | "stock" = "stock") {
  const run = Bun.spawnSync(lookCommand(home, theme), { env: { PATH: "/usr/bin:/bin" } });
  return run.exitCode;
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(full, base) : [path.relative(base, full)];
  });
}

test("the dock: the mark's apps menu, Files and Terminal, a gap, then the windows; floating at the bottom center", () => {
  const home = "/home/ag-01a142cb";
  const panel = textOf(home, "stock", `${XFCONF}/xfce4-panel.xml`);
  const plugins = [...panel.matchAll(/<property name="plugin-(\d+)" type="string" value="([a-z]+)">/g)].map(
    ([, id, name]) => `${name}-${id}`,
  );
  expect(plugins).toEqual([
    "applicationsmenu-1",
    "separator-2",
    "launcher-3",
    "launcher-4",
    "separator-5",
    "tasklist-6",
  ]);
  expect(panel).toContain(`<property name="button-icon" type="string" value="${home}/.local/share/agentes/mark.png"/>`);
  expect(panel).toContain(`value="p=0;x=${DESKTOP_SIZE.width / 2};y=${DESKTOP_SIZE.height - 31}"`);
  expect(panel).toContain('<property name="show-labels" type="bool" value="false"/>');
  // The panel's own launchers carry the names an agent reads on the dock's buttons (ADR 0062).
  expect(textOf(home, "stock", ".config/xfce4/panel/launcher-3/files.desktop")).toContain("Name=Files\nExec=thunar\n");
  expect(textOf(home, "stock", ".config/xfce4/panel/launcher-4/terminal.desktop")).toContain(
    "Name=Terminal\nExec=xfce4-terminal\n",
  );
  // Maximized windows stop above it: it floats, so it reserves no room itself.
  expect(textOf(home, "stock", `${XFCONF}/xfwm4.xml`)).toContain(
    '<property name="margin_bottom" type="int" value="60"/>',
  );
  expect(textOf(home, "stock", ".config/gtk-3.0/gtk.css")).toContain(".xfce4-panel.background {");
});

test("the rest: one workspace, the wallpaper 1:1, no desktop icons, the theme the computer has, Log Out out of the menu", () => {
  const home = "/srv/work/dev-01a142cb/.agentes/home";
  const desktop = textOf(home, "stock", `${XFCONF}/xfce4-desktop.xml`);
  expect(desktop).toContain(
    `<property name="last-image" type="string" value="${home}/.local/share/agentes/wallpaper.png"/>`,
  );
  expect(desktop).toContain('<property name="image-style" type="int" value="5"/>');
  expect(desktop).toMatch(/name="desktop-icons" type="empty">\n {4}<property name="style" type="int" value="0"\/>/);
  for (const theme of ["orchis", "stock"] as const) {
    const wm = textOf(home, theme, `${XFCONF}/xfwm4.xml`);
    expect(wm).toContain('<property name="vblank_mode" type="string" value="off"/>');
    expect(wm).toContain('<property name="workspace_count" type="int" value="1"/>');
    expect(wm).toContain(
      `<property name="theme" type="string" value="${theme === "orchis" ? "Orchis-Light" : "Default"}"/>`,
    );
    const gtk = theme === "orchis" ? "Orchis-Light" : "Adwaita";
    expect(textOf(home, theme, `${XFCONF}/xsettings.xml`)).toContain(
      `<property name="ThemeName" type="string" value="${gtk}"/>`,
    );
  }
  for (const entry of ["xfce4-session-logout", "xfce4-web-browser", "xfce4-mail-reader"]) {
    expect(textOf(home, "stock", `.local/share/applications/${entry}.desktop`)).toContain("Hidden=true");
  }
  // A home path is an attribute's text, whatever it holds.
  const odd = '/srv/a&b "c"/.agentes/home';
  expect(textOf(odd, "stock", `${XFCONF}/xfce4-desktop.xml`)).toContain(
    'value="/srv/a&amp;b &quot;c&quot;/.agentes/home/.local/share/agentes/wallpaper.png"',
  );
});

test("the images ship as committed: the wallpaper the desktop's exact size, the mark the dock's icon size", () => {
  const wallpaper = fileOf("/h", "stock", ".local/share/agentes/wallpaper.png");
  const mark = fileOf("/h", "stock", ".local/share/agentes/mark.png");
  expect(wallpaper.equals(readFileSync(path.join(ASSETS, "desktop-wallpaper.png")))).toBe(true);
  expect(mark.equals(readFileSync(path.join(ASSETS, "desktop-mark.png")))).toBe(true);
  // Shown 1:1: a desktop of another size needs the wallpaper rendered again (docs/design/desktop/render.sh).
  expect(pngSize(wallpaper)).toEqual({ ...DESKTOP_SIZE });
  expect(pngSize(mark)).toEqual({ width: 32, height: 32 });
});

test("the theme: Orchis only with its xfwm4 theme and gdk-pixbuf's SVG loader (its window buttons are SVG)", () => {
  const theme = "/usr/share/themes/Orchis-Light/xfwm4/themerc";
  const loader = "/usr/lib/aarch64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/libpixbufloader-svg.so";
  const has = (...files: string[]) => lookTheme((f) => files.includes(f));
  expect(has(theme, loader)).toBe("orchis");
  expect(has(theme)).toBe("stock");
  expect(has(loader)).toBe("stock");
  expect(lookId("orchis")).toBe(`${LOOK_VERSION}:orchis`);
});

test("applied: a new home gets every file and the marker; the same look again keeps what a person changed", () => {
  const home = path.join(tempDir("look-"), "home");
  dirs.push(path.dirname(home));
  expect(apply(home)).toBe(0);
  for (const f of lookFiles(home, "stock")) {
    expect(readFileSync(path.join(home, f.path)).equals(f.data)).toBe(true);
    expect(statSync(path.join(home, f.path)).mode & 0o777).toBe(0o600);
  }
  expect(statSync(path.join(home, ".config")).mode & 0o777).toBe(0o700);
  expect(readFileSync(path.join(home, LOOK_MARKER), "utf8")).toBe(`${lookId("stock")}\n`);

  const terminal = path.join(home, XFCONF, "xfce4-terminal.xml");
  writeFileSync(terminal, "a person's own colors");
  expect(apply(home)).toBe(0);
  expect(readFileSync(terminal, "utf8")).toBe("a person's own colors");
});

test("applied again once: a home with an older look, or another theme, gets this one", () => {
  const home = path.join(tempDir("look-"), "home");
  dirs.push(path.dirname(home));
  expect(apply(home)).toBe(0);
  const wm = path.join(home, XFCONF, "xfwm4.xml");
  writeFileSync(wm, "changed");
  // Orchis installed since.
  expect(apply(home, "orchis")).toBe(0);
  expect(readFileSync(wm, "utf8")).toContain('value="Orchis-Light"');
  writeFileSync(wm, "changed");
  writeFileSync(path.join(home, LOOK_MARKER), `${LOOK_VERSION - 1}:orchis\n`);
  expect(apply(home, "orchis")).toBe(0);
  expect(readFileSync(wm, "utf8")).toContain('value="Orchis-Light"');
  expect(readFileSync(path.join(home, LOOK_MARKER), "utf8")).toBe(`${lookId("orchis")}\n`);
});

test("nothing outside the HOME: relative paths only, and the script writes under HOME alone", () => {
  for (const f of lookFiles("/h", "orchis")) {
    expect(path.isAbsolute(f.path)).toBe(false);
    expect(path.normalize(f.path)).toBe(f.path);
    expect(f.path.split("/")).not.toContain("..");
  }
  const root = tempDir("look-");
  dirs.push(root);
  const home = path.join(root, "home");
  expect(apply(home)).toBe(0);
  expect(filesUnder(root).every((f) => f.startsWith(`home${path.sep}`))).toBe(true);
  expect(filesUnder(root)).toHaveLength(lookFiles(home, "stock").length + 1);
});

test("a file it can't write stops the script before the marker: the next start tries again", () => {
  const home = path.join(tempDir("look-"), "home");
  dirs.push(path.dirname(home));
  expect(apply(home)).toBe(0);
  writeFileSync(path.join(home, LOOK_MARKER), "0:stock\n");
  // A folder where the wallpaper's new file goes: writing it fails, for root too.
  mkdirSync(path.join(home, LOOK_DIR, "wallpaper.png.new"));
  expect(apply(home)).not.toBe(0);
  expect(readFileSync(path.join(home, LOOK_MARKER), "utf8")).toBe("0:stock\n");
});
