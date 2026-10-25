import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DESKTOP_SIZE } from "@agenteschat/adapters/machine-protocol";
import {
  LOOK_DIR,
  LOOK_MARKER,
  LOOK_SCRIPT,
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

/** The look's script as the runner runs it (as the agent there), in `home`; null when it didn't end within 5 s. */
function apply(home: string, theme: "orchis" | "stock" = "stock", cut = 0) {
  const { argv, input } = lookCommand(home, theme);
  const run = spawnSync(argv[0] as string, argv.slice(1), {
    env: { PATH: "/usr/bin:/bin" },
    input: input.slice(0, input.length - cut),
    timeout: 5000,
  });
  return run.status;
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(full, base) : [path.relative(base, full)];
  });
}

test("the dock: the mark's apps menu, Files and Terminal, then the windows; floating at the bottom center", () => {
  const home = "/home/ag-01a142cb";
  const panel = textOf(home, "stock", `${XFCONF}/xfce4-panel.xml`);
  const plugins = [...panel.matchAll(/<property name="plugin-(\d+)" type="string" value="([a-z]+)">/g)].map(
    ([, id, name]) => `${name}-${id}`,
  );
  expect(plugins).toEqual(["applicationsmenu-1", "separator-2", "launcher-3", "launcher-4", "tasklist-5"]);
  expect(panel).toContain(`<property name="button-icon" type="string" value="${home}/.local/share/agentes/mark.png"/>`);
  expect(panel).toContain(`value="p=0;x=${DESKTOP_SIZE.width / 2};y=${DESKTOP_SIZE.height - 31}"`);
  expect(panel).toContain('<property name="show-labels" type="bool" value="false"/>');
  // The panel's own launchers carry the names an agent reads on the dock's buttons (ADR 0062).
  expect(textOf(home, "stock", ".config/xfce4/panel/launcher-3/files.desktop")).toContain("Name=Files\nExec=thunar\n");
  expect(textOf(home, "stock", ".config/xfce4/panel/launcher-4/terminal.desktop")).toContain(
    "Name=Terminal\nExec=xfce4-terminal\n",
  );
  // Maximized windows stop above it: it floats, so it reserves no room itself. New windows open centered.
  const wm = textOf(home, "stock", `${XFCONF}/xfwm4.xml`);
  expect(wm).toContain('<property name="margin_bottom" type="int" value="60"/>');
  expect(wm).toContain('<property name="placement_mode" type="string" value="center"/>');
  expect(wm).toContain('<property name="placement_ratio" type="int" value="100"/>');
  expect(textOf(home, "stock", ".config/gtk-3.0/gtk.css")).toContain(".xfce4-panel.background {");
});

test("the rest: one workspace, the wallpaper 1:1, no desktop icons, the theme the computer has, the menu, the terminal", () => {
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
  // XFCE's own menu in a layout of ours: nothing above Terminal Emulator, nothing after the merged submenus.
  const menu = textOf(home, "stock", ".config/menus/xfce-applications.menu");
  expect(menu).toContain('<MergeFile type="parent"/>');
  expect(
    menu
      .slice(menu.indexOf("<Layout>"), menu.indexOf("</Layout>"))
      .trim()
      .split(/\s*\n\s*/),
  ).toEqual([
    "<Layout>",
    "<Filename>xfce4-terminal-emulator.desktop</Filename>",
    "<Filename>xfce4-file-manager.desktop</Filename>",
    "<Separator/>",
    "<Menuname>Settings</Menuname>",
    "<Separator/>",
    '<Merge type="all"/>',
  ]);
  // The terminal's 16 colors too: the shell's prompt prints in them.
  const palette = /name="color-palette" type="string" value="([^"]+)"/.exec(
    textOf(home, "stock", `${XFCONF}/xfce4-terminal.xml`),
  )?.[1];
  expect(palette?.split(";")).toHaveLength(16);
  // A home path is an attribute's text, whatever it holds.
  const odd = '/srv/a&b "c"/.agentes/home';
  expect(textOf(odd, "stock", `${XFCONF}/xfce4-desktop.xml`)).toContain(
    'value="/srv/a&amp;b &quot;c&quot;/.agentes/home/.local/share/agentes/wallpaper.png"',
  );
});

test("the images ship as committed (their base64 text is the PNGs): the wallpaper the desktop's size, the mark the dock's icon size", () => {
  const wallpaper = fileOf("/h", "stock", ".local/share/agentes/wallpaper.png");
  const mark = fileOf("/h", "stock", ".local/share/agentes/mark.png");
  expect(wallpaper.equals(readFileSync(path.join(ASSETS, "desktop-wallpaper.png")))).toBe(true);
  expect(mark.equals(readFileSync(path.join(ASSETS, "desktop-mark.png")))).toBe(true);
  // Shown 1:1: a desktop of another size needs the wallpaper rendered again (docs/design/desktop/render.sh).
  expect(pngSize(wallpaper)).toEqual({ ...DESKTOP_SIZE });
  expect(pngSize(mark)).toEqual({ width: 32, height: 32 });
});

test("the command line: the script and a few words, the files on its input (systemd-run's scope is named after it)", () => {
  const home = "/home/ag-01a142cb";
  const { argv, input } = lookCommand(home, "orchis");
  const files = lookFiles(home, "orchis");
  expect(argv).toEqual([
    "/bin/sh",
    "-c",
    LOOK_SCRIPT,
    "agentes-look",
    home,
    lookId("orchis", home),
    LOOK_MARKER,
    String(files.length),
  ]);
  expect(input.split("\n")).toEqual([...files.map((f) => `${f.path} ${f.data.toString("base64")}`), ""]);
});

test("files that change come with a new LOOK_VERSION: desktops that have the look get it again only then", () => {
  const hash = createHash("sha256");
  for (const theme of ["orchis", "stock"] as const) {
    for (const f of lookFiles("/HOME", theme)) hash.update(f.path).update(f.data);
  }
  // Changed the look on purpose? Bump LOOK_VERSION and put the new hash here.
  expect({ version: LOOK_VERSION, files: hash.digest("hex").slice(0, 16) }).toEqual({
    version: 2,
    files: "fefc42ad3018a81e",
  });
});

test("the theme: Orchis only with its xfwm4 theme and gdk-pixbuf's SVG loader (its window buttons are SVG)", () => {
  const theme = "/usr/share/themes/Orchis-Light/xfwm4/themerc";
  const loader = "/usr/lib/aarch64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/libpixbufloader-svg.so";
  const has = (...files: string[]) => lookTheme((f) => files.includes(f));
  expect(has(theme, loader)).toBe("orchis");
  expect(has(theme)).toBe("stock");
  expect(has(loader)).toBe("stock");
  expect(lookId("orchis", "/home/ag-01a142cb")).toBe(`${LOOK_VERSION}:orchis:/home/ag-01a142cb`);
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
  expect(readFileSync(path.join(home, LOOK_MARKER), "utf8")).toBe(`${lookId("stock", home)}\n`);

  const terminal = path.join(home, XFCONF, "xfce4-terminal.xml");
  writeFileSync(terminal, "a person's own colors");
  expect(apply(home)).toBe(0);
  expect(readFileSync(terminal, "utf8")).toBe("a person's own colors");
});

test("applied again once: a home with an older look, another theme, or moved, gets this one", () => {
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
  expect(readFileSync(path.join(home, LOOK_MARKER), "utf8")).toBe(`${lookId("orchis", home)}\n`);

  // The agent renamed (single-user mode moves its folder): the settings name the images where they are now.
  const moved = path.join(path.dirname(home), "moved");
  renameSync(home, moved);
  expect(apply(moved, "orchis")).toBe(0);
  for (const name of ["xfce4-panel.xml", "xfce4-desktop.xml"]) {
    const text = readFileSync(path.join(moved, XFCONF, name), "utf8");
    expect(text).toContain(`${moved}/${LOOK_DIR}/`);
    expect(text).not.toContain(`${home}/`);
  }
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

test("a file it can't write, or files that didn't all come, stop the script before the marker: the next start tries again", () => {
  const home = path.join(tempDir("look-"), "home");
  dirs.push(path.dirname(home));
  expect(apply(home)).toBe(0);
  writeFileSync(path.join(home, LOOK_MARKER), "0:stock\n");
  // A folder where the wallpaper's new file goes: writing it fails, for root too.
  mkdirSync(path.join(home, LOOK_DIR, "wallpaper.png.new"));
  expect(apply(home)).not.toBe(0);
  expect(readFileSync(path.join(home, LOOK_MARKER), "utf8")).toBe("0:stock\n");
  // The input cut short: the last file (the mark) never came.
  const mark = fileOf(home, "stock", `${LOOK_DIR}/mark.png`).toString("base64");
  expect(apply(path.join(path.dirname(home), "other"), "stock", mark.length + 1)).not.toBe(0);
  expect(filesUnder(path.join(path.dirname(home), "other")).some((f) => f.endsWith("look"))).toBe(false);
});

test("pipes left in the home (at a file's temporary name, at the marker) never hold the script", () => {
  const home = path.join(tempDir("look-"), "home");
  dirs.push(path.dirname(home));
  const pipes = [`${home}/.config/gtk-3.0/gtk.css.new`, `${home}/${LOOK_MARKER}`];
  for (const pipe of pipes) {
    mkdirSync(path.dirname(pipe), { recursive: true });
    expect(spawnSync("mkfifo", [pipe]).status).toBe(0);
  }
  expect(apply(home)).toBe(0);
  expect(readFileSync(path.join(home, ".config/gtk-3.0/gtk.css"), "utf8")).toContain(".xfce4-panel.background");
  expect(statSync(path.join(home, LOOK_MARKER)).isFile()).toBe(true);
  expect(apply(home)).toBe(0);
});
