import { createHash } from "node:crypto";
import path from "node:path";
import { type AgentScope, DESKTOP_SIZE } from "@agenteschat/adapters/machine-protocol";
import MARK_BASE64 from "./assets/desktop-mark.png.b64" with { type: "text" };
import WALLPAPER_BASE64 from "./assets/desktop-wallpaper.png.b64" with { type: "text" };
import { shQuote } from "./install-script";
import { xmlEscape } from "./xml";

/**
 * The agents' desktops' own look (ADR 0058 §15): the agentes.chat wallpaper and a dock floating at the bottom
 * center (the mark, which opens the apps menu, then Browser, Files and Terminal), one workspace, no top panel and
 * no desktop icons, Orchis's light theme where it is installed.
 *
 * - It is XFCE's own settings, written into the desktop session's HOME only (the agent's own home in system
 *   mode, `<agent folder>/.agentes/home` otherwise), by the agent's own process (`LOOK_SCRIPT`): never the
 *   computer's settings, so a self-hosted computer's own desktop stays as it is.
 * - Versioned: the HOME's marker names the look written there. A desktop gets it at its first start, and again
 *   once when anything it writes changes (its version, the theme or dock the computer has, the HOME's own path,
 *   the agent's name, how Browser reaches the runner); what a person changes in between stays until then.
 * - The dock is xfce4-docklike-plugin where it is installed, so an app's windows show on its own launcher; else
 *   the panel's own launchers, then a button for each window. Desktop use (ADR 0062) reads the panel's own
 *   plugins only: docklike runs in a process of its own, outside what the agent reads of the screen.
 * - Browser, Files and Terminal are desktop entries of the look's own (`agentes-*.desktop`), on the dock and at
 *   the top of the apps menu, in place of XFCE's generic Terminal Emulator and File Manager. Their names are only
 *   English: the desktop session runs in `C.UTF-8` (`desktop-session.ts`), where a translated name never shows.
 * - The terminal's prompt and title show the agent's name, where bash's own show its system user and the
 *   computer's hostname.
 */

/** Bumped whenever what `lookFiles` writes changes. */
export const LOOK_VERSION = 3;

/** Orchis's light theme (GTK and xfwm4), else GTK's Adwaita and xfwm4's Default. */
export type LookTheme = "orchis" | "stock";

/** xfce4-docklike-plugin, else the panel's own launchers and window buttons. */
export type LookDock = "docklike" | "panel";

const TRIPLETS = ["x86_64-linux-gnu", "aarch64-linux-gnu"];
const ORCHIS = "/usr/share/themes/Orchis-Light/xfwm4/themerc";
/** Orchis's window buttons are SVG files: without gdk-pixbuf's SVG loader, windows would have no close button. */
const SVG_LOADERS = TRIPLETS.flatMap((triplet) =>
  ["libpixbufloader_svg.so", "libpixbufloader-svg.so"].map(
    (file) => `/usr/lib/${triplet}/gdk-pixbuf-2.0/2.10.0/loaders/${file}`,
  ),
);
const DOCKLIKE = "/usr/share/xfce4/panel/plugins/docklike.desktop";
const DOCKLIKE_MODULES = TRIPLETS.map((triplet) => `/usr/lib/${triplet}/xfce4/panel/plugins/libdocklike.so`);

export const lookTheme = (exists: (path: string) => boolean): LookTheme =>
  exists(ORCHIS) && SVG_LOADERS.some(exists) ? "orchis" : "stock";

export const lookDock = (exists: (path: string) => boolean): LookDock =>
  exists(DOCKLIKE) && DOCKLIKE_MODULES.some(exists) ? "docklike" : "panel";

/** What a desktop's look depends on besides its HOME. */
export interface LookOptions {
  theme: LookTheme;
  dock: LookDock;
  /** The terminal's prompt and title show its name. */
  agent: Pick<AgentScope, "name" | "handle">;
  /** The session's shell (`SHELL`): the prompt is bash's, so any other shell keeps its own. */
  shell: string;
  /** What Browser runs: this runner's `desktop-browser` with the desktop's socket (`desktop-browser.ts`). */
  browser: string[];
}

/** The agent's name as its desktop shows it: the name viewers see, the terminal's prompt. */
export const desktopName = (agent: Pick<AgentScope, "name" | "handle">) =>
  (agent.name || agent.handle)
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, 60) || "agent";

/** The look's own files and its marker, under HOME. */
export const LOOK_DIR = ".local/share/agentes";
export const LOOK_MARKER = `${LOOK_DIR}/look`;

/** The agent's Chrome on its desktop has this window class (`browser.ts`), so the dock shows it on Browser. */
export const BROWSER_WM_CLASS = "agentes-browser";
/** The icon theme's web browser (a globe), with the theme's Files and Terminal icons. */
export const BROWSER_ICON = "org.xfce.webbrowser";
/**
 * The window that says why Browser didn't open (`desktop-browser.ts`) has a class of its own: with Browser's, a
 * click on Browser would only bring that window up, where it should try again.
 */
export const NOTE_WM_CLASS = "agentes-note";
export const NOTE_ICON = "dialog-warning";

/**
 * 1280×900, the exact desktop size: shown 1:1, its logo centered on the dock's line below maximized windows. The
 * images are base64 text (`assets/*.png.b64`, written next to the PNGs by docs/design/desktop/render.sh): Bun's
 * text loader inlines them in the one-file runner, and would mangle a PNG's bytes.
 */
const WALLPAPER = Buffer.from(WALLPAPER_BASE64, "base64");
/** The favicon at the dock's icon size: the same mark as the wallpaper's logo. */
const MARK = Buffer.from(MARK_BASE64, "base64");

/** The ink of the sky's agents (the wallpaper's logo): the dock's lines and its window bars. */
const INK = "4, 32, 63";

/** Browser, Files and Terminal, in the dock's and the menu's order. */
interface DockApp {
  /** Its desktop id, without `.desktop`. */
  id: string;
  name: string;
  exec: string;
  icon: string;
  /** Its windows' WM_CLASS: the dock shows them on its launcher. */
  wmClass: string;
  /** Browser's window is Chrome's, never its command's own: a startup notice would spin until it timed out. */
  notify: boolean;
}

/**
 * One argument of a desktop entry's Exec, as the Desktop Entry spec quotes it: as it is when it has no reserved
 * character, else in double quotes with `"`, `` ` ``, `$` and `\` escaped; then the string's own escape of `\`,
 * and `%` doubled, since it starts a field code.
 */
export const execArg = (arg: string) =>
  (/^[\w@+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/["`$\\]/g, "\\$&")}"`)
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "%%");

const dockApps = (browser: string[]): DockApp[] => [
  {
    id: "agentes-browser",
    name: "Browser",
    exec: browser.map(execArg).join(" "),
    icon: BROWSER_ICON,
    wmClass: BROWSER_WM_CLASS,
    notify: false,
  },
  {
    id: "agentes-files",
    name: "Files",
    exec: "thunar",
    icon: "org.xfce.thunar",
    wmClass: "Thunar",
    notify: true,
  },
  {
    id: "agentes-terminal",
    name: "Terminal",
    exec: "xfce4-terminal",
    icon: "org.xfce.terminalemulator",
    wmClass: "Xfce4-terminal",
    notify: true,
  },
];

/** Top level only (X-Xfce-Toplevel): none of the menu's categories lists them a second time. */
const desktopEntry = (app: DockApp) =>
  [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${app.name}`,
    `Exec=${app.exec}`,
    `Icon=${app.icon}`,
    `StartupWMClass=${app.wmClass}`,
    `StartupNotify=${app.notify}`,
    "Categories=X-Xfce-Toplevel;",
    "",
  ].join("\n");

/** The note's entry, out of the menu: docklike shows the note's window with its icon. Opened, it is Browser's command. */
const noteEntry = (browser: DockApp) =>
  [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${browser.name}`,
    `Exec=${browser.exec}`,
    `Icon=${NOTE_ICON}`,
    `StartupWMClass=${NOTE_WM_CLASS}`,
    "StartupNotify=false",
    "NoDisplay=true",
    "",
  ].join("\n");

/**
 * Plugin ids: they name their widgets (`#separator-2` in gtk.css), the panel's launchers' folders (`launcher-3`)
 * and docklike's settings (`docklike-7.rc`). Files and Terminal keep the ids they had before Browser came, so a
 * desktop that had the earlier look reuses their folders.
 */
const LAUNCHERS = [
  { plugin: 6, file: "browser.desktop" },
  { plugin: 3, file: "files.desktop" },
  { plugin: 4, file: "terminal.desktop" },
];
const TASKLIST = 5;
const DOCKLIKE_PLUGIN = 7;

const launcherPlugin = ({ plugin, file }: (typeof LAUNCHERS)[number]) =>
  `    <property name="plugin-${plugin}" type="string" value="launcher">
      <property name="items" type="array">
        <value type="string" value="${file}"/>
      </property>
    </property>
`;

/** The panel's own: a launcher each, then a button for each window, flat, no labels. */
const PANEL_PLUGINS = `${LAUNCHERS.map(launcherPlugin).join("")}    <property name="plugin-${TASKLIST}" type="string" value="tasklist">
      <property name="show-labels" type="bool" value="false"/>
      <property name="grouping" type="bool" value="false"/>
      <property name="include-all-workspaces" type="bool" value="false"/>
      <property name="show-handle" type="bool" value="false"/>
      <property name="flat-buttons" type="bool" value="true"/>
      <property name="window-scrolling" type="bool" value="false"/>
      <property name="sort-order" type="uint" value="0"/>
    </property>
`;

/**
 * The dock: floating (p=0) with its center 31 px above the bottom, so it stays centered as windows come and go.
 * It reserves no room of its own: xfwm4's margin_bottom keeps maximized windows 60 px above the bottom. No gap
 * before the windows: a separator there would also stand in the empty dock, off its center.
 */
const panel = (home: string, dock: LookDock) => {
  const ids = dock === "docklike" ? [1, 2, DOCKLIKE_PLUGIN] : [1, 2, ...LAUNCHERS.map((l) => l.plugin), TASKLIST];
  const own =
    dock === "docklike"
      ? `    <property name="plugin-${DOCKLIKE_PLUGIN}" type="string" value="docklike"/>\n`
      : PANEL_PLUGINS;
  return `<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="dark-mode" type="bool" value="false"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=0;x=${DESKTOP_SIZE.width / 2};y=${DESKTOP_SIZE.height - 31}"/>
      <property name="length" type="uint" value="1"/>
      <property name="length-adjust" type="bool" value="true"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="size" type="uint" value="48"/>
      <property name="icon-size" type="uint" value="32"/>
      <property name="plugin-ids" type="array">
${ids.map((id) => `        <value type="int" value="${id}"/>`).join("\n")}
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="applicationsmenu">
      <property name="button-icon" type="string" value="${xmlEscape(`${home}/${LOOK_DIR}/mark.png`)}"/>
      <property name="show-button-title" type="bool" value="false"/>
    </property>
    <property name="plugin-2" type="string" value="separator">
      <property name="style" type="uint" value="1"/>
    </property>
${own}  </property>
</channel>
`;
};

/**
 * docklike's own settings: Browser, Files and Terminal pinned; a click on one with windows brings them up (or
 * down), a middle click opens another (1; 0 would close them all); icons at the mark's 32 px; under an app with
 * windows a short bar (style 2) at the bottom (orientation 1: the automatic one finds no edge on a floating panel
 * and draws none), in the sky's ink, solid under the active window's app.
 */
const dockSettings = (apps: DockApp[]) => `[user]
pinned=${apps.map((app) => `${app.id};`).join("")}
forceIconSize=true
iconSize=32
noWindowsListIfSingle=true
showPreviews=false
middleButtonBehavior=1
indicatorOrientation=1
indicatorStyle=2
inactiveIndicatorStyle=2
indicatorColorFromTheme=false
indicatorColor=rgb(${INK})
inactiveColor=rgba(${INK}, 0.65)
`;

/** One workspace, the wallpaper zoomed (an image of the screen's size: 1:1) over the bottom band's tone, no icons. */
const backdrop = (home: string) => `<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfce4-desktop" version="1.0">
  <property name="last-settings-migration-version" type="uint" value="1"/>
  <property name="backdrop" type="empty">
    <property name="single-workspace-mode" type="bool" value="true"/>
    <property name="single-workspace-number" type="int" value="0"/>
    <property name="screen0" type="empty">
      <property name="monitorVNC-0" type="empty">
        <property name="workspace0" type="empty">
          <property name="color-style" type="int" value="0"/>
          <property name="rgba1" type="array">
            <value type="double" value="0.811765"/>
            <value type="double" value="0.901961"/>
            <value type="double" value="1.000000"/>
            <value type="double" value="1.000000"/>
          </property>
          <property name="image-style" type="int" value="5"/>
          <property name="last-image" type="string" value="${xmlEscape(`${home}/${LOOK_DIR}/wallpaper.png`)}"/>
        </property>
      </property>
    </property>
  </property>
  <property name="desktop-icons" type="empty">
    <property name="style" type="int" value="0"/>
  </property>
</channel>
`;

/**
 * vblank_mode off as desktop-session.ts's PREPARE keeps it; no shadow around the dock's square window. New windows
 * centered: xfwm4 centers only those under `placement_ratio` percent of the screen and fits the rest into corners.
 */
const windowManager = (theme: LookTheme) => `<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="vblank_mode" type="string" value="off"/>
    <property name="theme" type="string" value="${theme === "orchis" ? "Orchis-Light" : "Default"}"/>
    <property name="title_font" type="string" value="Noto Sans Bold 10"/>
    <property name="title_alignment" type="string" value="center"/>
    <property name="button_layout" type="string" value="|HMC"/>
    <property name="workspace_count" type="int" value="1"/>
    <property name="placement_mode" type="string" value="center"/>
    <property name="placement_ratio" type="int" value="100"/>
    <property name="show_dock_shadow" type="bool" value="false"/>
    <property name="show_frame_shadow" type="bool" value="true"/>
    <property name="show_popup_shadow" type="bool" value="true"/>
    <property name="tile_on_move" type="bool" value="true"/>
    <property name="margin_bottom" type="int" value="60"/>
  </property>
</channel>
`;

/** Grayscale antialiasing: subpixel colors only add noise to what viewers receive. */
const settings = (theme: LookTheme) => `<?xml version="1.0" encoding="UTF-8"?>

<channel name="xsettings" version="1.0">
  <property name="Net" type="empty">
    <property name="ThemeName" type="string" value="${theme === "orchis" ? "Orchis-Light" : "Adwaita"}"/>
    <property name="IconThemeName" type="string" value="elementary-xfce"/>
  </property>
  <property name="Xft" type="empty">
    <property name="Antialias" type="int" value="1"/>
    <property name="Hinting" type="int" value="1"/>
    <property name="HintStyle" type="string" value="hintslight"/>
    <property name="RGBA" type="string" value="none"/>
  </property>
  <property name="Gtk" type="empty">
    <property name="FontName" type="string" value="Noto Sans 10"/>
    <property name="MonospaceFontName" type="string" value="Noto Mono 10"/>
    <property name="CursorThemeName" type="string" value="Adwaita"/>
    <property name="DecorationLayout" type="string" value="menu:minimize,maximize,close"/>
  </property>
</channel>
`;

/** The prompt's own startup file, under HOME. */
const BASHRC = `${LOOK_DIR}/bashrc`;

/**
 * The design system's dark tokens, also for the 16 colors programs print in (the shell's prompt among them). With
 * bash, each new terminal runs it on the look's own startup file (`BASHRC`).
 */
const terminal = (home: string, bash: string | null) => `<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfce4-terminal" version="1.0">
  <property name="color-use-theme" type="bool" value="false"/>
  <property name="color-background" type="string" value="#1c1c1b"/>
  <property name="color-foreground" type="string" value="#efefec"/>
  <property name="color-cursor-use-default" type="bool" value="false"/>
  <property name="color-cursor" type="string" value="#5aa8ff"/>
  <property name="color-bold-use-default" type="bool" value="true"/>
  <property name="color-palette" type="string" value="#242423;#f08a80;#5fc48a;#e0a84a;#5aa8ff;#c9a2f5;#6cc7d6;#d6d6d2;#71716c;#f5a69e;#7fd3a2;#ebbd6a;#8cc3ff;#d9bdfa;#92d8e3;#efefec"/>
${
  bash
    ? `  <property name="run-custom-command" type="bool" value="true"/>
  <property name="custom-command" type="string" value="${xmlEscape(`${shQuote(bash)} --rcfile ${shQuote(`${home}/${BASHRC}`)}`)}"/>
`
    : ""
}</channel>
`;

/**
 * `~/.bashrc` first (`--rcfile` reads this file in its place; Debian's and Ubuntu's bash still read
 * `/etc/bash.bashrc` before it), then the agent's name, green, in the prompt and in the window's title. The prompt
 * names it through a variable it expands, never in its own text, so no character of the name runs anything or
 * takes a prompt escape.
 */
const bashrc = (name: string) =>
  [
    "# The desktop's Terminal: the shell's own setup, then the agent's name in the prompt and the window's title.",
    "[ -r ~/.bashrc ] && . ~/.bashrc",
    `AGENTES_NAME=${shQuote(name)}`,
    "shopt -s promptvars",
    String.raw`PS1='\[\e]0;$AGENTES_NAME: \w\a\]\[\e[1;32m\]$AGENTES_NAME\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '`,
    "",
  ].join("\n");

const GTK_CSS = `/* The dock: the design system's glass, rounded, with a hairline that still shows on the sky's pale band. */
.xfce4-panel.background {
  background-color: rgba(255, 255, 255, 0.88);
  background-image: none;
  border: 1px solid rgba(${INK}, 0.18);
  border-radius: 16px;
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.9);
}

/* docklike draws in a window of its own process, inside the dock: the dock's glass there, not a second frame. */
#XfcePanelWindowWrapper.xfce4-panel.background {
  border: none;
  border-radius: 0;
  box-shadow: none;
}

.xfce4-panel.background button {
  background-image: none;
  background-color: transparent;
  border: none;
  border-radius: 10px;
  box-shadow: none;
  margin: 4px 2px;
  padding: 0;
}

.xfce4-panel.background button:hover {
  background-color: rgba(${INK}, 0.07);
}

.xfce4-panel.background button:active,
.xfce4-panel.background button:checked,
.xfce4-panel.background button.active_group {
  background-color: rgba(${INK}, 0.11);
}

#separator-2 {
  color: rgba(${INK}, 0.16);
}

/* A minimized window's icon as bright as the others' (faded, it reads as disabled). */
.tasklist {
  -XfceTasklist-minimized-icon-lucency: 100;
}

/* A short bar under each window's icon; a longer, darker one under the active window's. */
.xfce4-panel.background .tasklist button {
  background-image: linear-gradient(rgba(${INK}, 0.65), rgba(${INK}, 0.65));
  background-size: 8px 3px;
  background-repeat: no-repeat;
  background-position: 50% 100%;
}

.xfce4-panel.background .tasklist button:checked {
  background-image: linear-gradient(rgb(${INK}), rgb(${INK}));
  background-size: 16px 3px;
}
`;

/**
 * The apps menu: XFCE's own in a layout of ours. Browser, Files and Terminal first; then the menus of whatever
 * else is installed, then Settings, so no separator is left alone at the end when there are none. Thunar, its bulk
 * renamer and XFCE's own terminal leave Accessories and System, which listed them again: those menus show only
 * with something else in them. Run Program, About and Log Out are missing or hidden here.
 */
const menu = (
  apps: DockApp[],
) => `<!DOCTYPE Menu PUBLIC "-//freedesktop//DTD Menu 1.0//EN" "http://www.freedesktop.org/standards/menu-spec/1.0/menu.dtd">

<Menu>
  <Name>Xfce</Name>
  <MergeFile type="parent"/>
  <Layout>
${apps.map((app) => `    <Filename>${app.id}.desktop</Filename>`).join("\n")}
    <Separator/>
    <Merge type="all"/>
    <Menuname>Settings</Menuname>
  </Layout>
  <Menu>
    <Name>Accessories</Name>
    <Exclude>
      <Filename>thunar.desktop</Filename>
      <Filename>thunar-bulk-rename.desktop</Filename>
    </Exclude>
  </Menu>
  <Menu>
    <Name>System</Name>
    <Exclude>
      <Filename>thunar.desktop</Filename>
      <Filename>xfce4-terminal.desktop</Filename>
    </Exclude>
  </Menu>
</Menu>
`;

/**
 * Out of the apps menu: XFCE's web browser and mail reader, which open nothing here, Log Out (it ends the
 * desktop), and its generic Terminal Emulator and File Manager, which Terminal and Files replace.
 */
const HIDDEN: Record<string, string> = {
  "xfce4-web-browser": "Web Browser",
  "xfce4-mail-reader": "Mail Reader",
  "xfce4-session-logout": "Log Out",
  "xfce4-terminal-emulator": "Terminal Emulator",
  "xfce4-file-manager": "File Manager",
};
const hidden = (name: string) => `[Desktop Entry]\nType=Application\nName=${name}\nHidden=true\n`;

interface LookFile {
  /** Under HOME. */
  path: string;
  data: Buffer;
}

/** Every file of the look, by its path under HOME. */
export function lookFiles(home: string, o: LookOptions): LookFile[] {
  const xfconf = ".config/xfce4/xfconf/xfce-perchannel-xml";
  const apps = dockApps(o.browser);
  const bash = path.basename(o.shell) === "bash" ? o.shell : null;
  const dock: [string, string][] =
    o.dock === "docklike"
      ? [[`.config/xfce4/panel/docklike-${DOCKLIKE_PLUGIN}.rc`, dockSettings(apps)]]
      : LAUNCHERS.map((l, i) => [
          `.config/xfce4/panel/launcher-${l.plugin}/${l.file}`,
          desktopEntry(apps[i] as DockApp),
        ]);
  const files: [string, string | Buffer][] = [
    [`${xfconf}/xfce4-panel.xml`, panel(home, o.dock)],
    [`${xfconf}/xfce4-desktop.xml`, backdrop(home)],
    [`${xfconf}/xfwm4.xml`, windowManager(o.theme)],
    [`${xfconf}/xsettings.xml`, settings(o.theme)],
    [`${xfconf}/xfce4-terminal.xml`, terminal(home, bash)],
    ...dock,
    [".config/gtk-3.0/gtk.css", GTK_CSS],
    [".config/menus/xfce-applications.menu", menu(apps)],
    ...apps.map((app): [string, string] => [`.local/share/applications/${app.id}.desktop`, desktopEntry(app)]),
    [`.local/share/applications/${NOTE_WM_CLASS}.desktop`, noteEntry(apps[0] as DockApp)],
    ...Object.entries(HIDDEN).map(([id, name]): [string, string] => [
      `.local/share/applications/${id}.desktop`,
      hidden(name),
    ]),
    ...(bash ? [[BASHRC, bashrc(desktopName(o.agent))] as [string, string]] : []),
    [`${LOOK_DIR}/wallpaper.png`, WALLPAPER],
    [`${LOOK_DIR}/mark.png`, MARK],
  ];
  return files.map(([file, data]) => ({ path: file, data: Buffer.isBuffer(data) ? data : Buffer.from(data) }));
}

/** What the marker says: the look's version, theme and dock, and a hash of every file it writes, paths and all. */
const idOf = (o: LookOptions, files: LookFile[]) => {
  const hash = createHash("sha256");
  for (const f of files) hash.update(f.path).update("\0").update(f.data).update("\0");
  return `${LOOK_VERSION}:${o.theme}:${o.dock}:${hash.digest("hex").slice(0, 16)}`;
};

export const lookId = (home: string, o: LookOptions) => idOf(o, lookFiles(home, o));

/**
 * Run as the agent (`lookCommand`), the files on its stdin, a `<path under HOME> <base64>` line each: unless the
 * marker already names this look, each file is written (0600, its folders 0700) and renamed into place, then the
 * marker once all of them are. As the agent's own process it writes nothing the agent couldn't itself: a link the
 * agent made in its home leads only to the agent's own files. What sits at a temporary name goes first and only a
 * plain file is read as the marker, so a pipe left in the home can't hold the desktop's start.
 */
export const LOOK_SCRIPT = [
  'h=$1 v=$2 m="$1/$3" n=$4 && umask 077',
  '[ -f "$m" ] && [ "$(cat "$m")" = "$v" ] && exit 0',
  'while [ "$n" -gt 0 ] && read -r p b; do f="$h/$p" && mkdir -p "$(dirname "$f")" && rm -f "$f.new" && printf %s "$b" | base64 -d > "$f.new" && mv -f "$f.new" "$f" || exit 1; n=$((n - 1)); done',
  '[ "$n" -eq 0 ] && mkdir -p "$(dirname "$m")" && rm -f "$m.new" && printf "%s\\n" "$v" > "$m.new" && mv -f "$m.new" "$m"',
].join("\n");

/**
 * `sh -c LOOK_SCRIPT agentes-look <HOME> <look id> <marker> <file count>`, the files as its input. Not as
 * arguments: in system mode systemd-run names the agent's scope after its command line, and the journal logs it.
 */
export function lookCommand(home: string, o: LookOptions): { argv: string[]; input: string } {
  const files = lookFiles(home, o);
  return {
    argv: ["/bin/sh", "-c", LOOK_SCRIPT, "agentes-look", home, idOf(o, files), LOOK_MARKER, String(files.length)],
    input: files.map((f) => `${f.path} ${f.data.toString("base64")}\n`).join(""),
  };
}
