import { DESKTOP_SIZE } from "@agenteschat/adapters/machine-protocol";
import { base64 } from "./assets/embed" with { type: "macro" };
import { xmlEscape } from "./xml";

/**
 * The agents' desktops' own look (ADR 0058 §15): the agentes.chat wallpaper and a dock floating at the bottom
 * center (the mark opens the apps menu, then Files and Terminal, then a button for each open window), one
 * workspace, no top panel and no desktop icons, Orchis's light theme where it is installed.
 *
 * - It is XFCE's own settings, written into the desktop session's HOME only (the agent's own home in system
 *   mode, `<agent folder>/.agentes/home` otherwise), by the agent's own process (`LOOK_SCRIPT`): never the
 *   computer's settings, so a self-hosted computer's own desktop stays as it is.
 * - Versioned: the HOME's marker names the look written there. A desktop gets it at its first start, and
 *   again once when the version (or the theme the computer has) changes; what a person changes in between
 *   stays until then.
 * - The dock is the panel's own launcher and window-button plugins, which the agent's desktop use reads
 *   (ADR 0062): a dock plugin that runs in a process of its own isn't on the accessibility bus.
 */

/** Bumped whenever what `lookFiles` writes changes. */
export const LOOK_VERSION = 1;

/** Orchis's light theme (GTK and xfwm4), else GTK's Adwaita and xfwm4's Default. */
export type LookTheme = "orchis" | "stock";

const ORCHIS = "/usr/share/themes/Orchis-Light/xfwm4/themerc";
/** Orchis's window buttons are SVG files: without gdk-pixbuf's SVG loader, windows would have no close button. */
const SVG_LOADERS = ["x86_64-linux-gnu", "aarch64-linux-gnu"].flatMap((triplet) =>
  ["libpixbufloader_svg.so", "libpixbufloader-svg.so"].map(
    (file) => `/usr/lib/${triplet}/gdk-pixbuf-2.0/2.10.0/loaders/${file}`,
  ),
);

export const lookTheme = (exists: (path: string) => boolean): LookTheme =>
  exists(ORCHIS) && SVG_LOADERS.some(exists) ? "orchis" : "stock";

/** What the marker says: the look's version and theme. */
export const lookId = (theme: LookTheme) => `${LOOK_VERSION}:${theme}`;

/** The look's own files and its marker, under HOME. */
export const LOOK_DIR = ".local/share/agentes";
export const LOOK_MARKER = `${LOOK_DIR}/look`;

/** 1280×900, the exact desktop size: shown 1:1, its logo centered on the dock's line below maximized windows. */
const WALLPAPER = Buffer.from(base64("desktop-wallpaper.png"), "base64");
/** The favicon at the dock's icon size: the same mark as the wallpaper's logo. */
const MARK = Buffer.from(base64("desktop-mark.png"), "base64");

/** The ink of the sky's agents (the wallpaper's logo): the dock's lines and its window bars. */
const INK = "4, 32, 63";

/**
 * The dock: floating (p=0) with its center 31 px above the bottom, so it stays centered as windows come and go.
 * It reserves no room of its own: xfwm4's margin_bottom keeps maximized windows 60 px above the bottom. Plugin
 * ids name their widgets (`#separator-2` in gtk.css) and the launchers' folders (`launcher-3`).
 */
const panel = (home: string) => `<?xml version="1.0" encoding="UTF-8"?>

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
        <value type="int" value="1"/>
        <value type="int" value="2"/>
        <value type="int" value="3"/>
        <value type="int" value="4"/>
        <value type="int" value="5"/>
        <value type="int" value="6"/>
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
    <property name="plugin-3" type="string" value="launcher">
      <property name="items" type="array">
        <value type="string" value="files.desktop"/>
      </property>
    </property>
    <property name="plugin-4" type="string" value="launcher">
      <property name="items" type="array">
        <value type="string" value="terminal.desktop"/>
      </property>
    </property>
    <property name="plugin-5" type="string" value="separator">
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-6" type="string" value="tasklist">
      <property name="show-labels" type="bool" value="false"/>
      <property name="grouping" type="bool" value="false"/>
      <property name="include-all-workspaces" type="bool" value="false"/>
      <property name="show-handle" type="bool" value="false"/>
      <property name="flat-buttons" type="bool" value="true"/>
      <property name="window-scrolling" type="bool" value="false"/>
      <property name="sort-order" type="uint" value="0"/>
    </property>
  </property>
</channel>
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

/** vblank_mode off as desktop-session.ts's PREPARE keeps it; no shadow around the dock's square window. */
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

const TERMINAL = `<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfce4-terminal" version="1.0">
  <property name="color-use-theme" type="bool" value="false"/>
  <property name="color-background" type="string" value="#1c1c1b"/>
  <property name="color-foreground" type="string" value="#efefec"/>
  <property name="color-cursor-use-default" type="bool" value="false"/>
  <property name="color-cursor" type="string" value="#5aa8ff"/>
  <property name="color-bold-use-default" type="bool" value="true"/>
</channel>
`;

const GTK_CSS = `/* The dock: the design system's glass, rounded, with a hairline that still shows on the sky's pale band. */
.xfce4-panel.background {
  background-color: rgba(255, 255, 255, 0.88);
  background-image: none;
  border: 1px solid rgba(${INK}, 0.18);
  border-radius: 16px;
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.9);
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
.xfce4-panel.background button:checked {
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

const launcher = (name: string, exec: string, icon: string) =>
  `[Desktop Entry]\nType=Application\nName=${name}\nExec=${exec}\nIcon=${icon}\nStartupNotify=true\n`;
/** Out of the apps menu: a browser and a mail reader that aren't installed, and Log Out, which ends the desktop. */
const hidden = (name: string) => `[Desktop Entry]\nType=Application\nName=${name}\nHidden=true\n`;

/** Every file of the look, by its path under HOME. */
export function lookFiles(home: string, theme: LookTheme): { path: string; data: Buffer }[] {
  const xfconf = ".config/xfce4/xfconf/xfce-perchannel-xml";
  const files: [string, string | Buffer][] = [
    [`${xfconf}/xfce4-panel.xml`, panel(home)],
    [`${xfconf}/xfce4-desktop.xml`, backdrop(home)],
    [`${xfconf}/xfwm4.xml`, windowManager(theme)],
    [`${xfconf}/xsettings.xml`, settings(theme)],
    [`${xfconf}/xfce4-terminal.xml`, TERMINAL],
    [".config/xfce4/panel/launcher-3/files.desktop", launcher("Files", "thunar", "org.xfce.thunar")],
    [
      ".config/xfce4/panel/launcher-4/terminal.desktop",
      launcher("Terminal", "xfce4-terminal", "org.xfce.terminalemulator"),
    ],
    [".config/gtk-3.0/gtk.css", GTK_CSS],
    [".local/share/applications/xfce4-web-browser.desktop", hidden("Web Browser")],
    [".local/share/applications/xfce4-mail-reader.desktop", hidden("Mail Reader")],
    [".local/share/applications/xfce4-session-logout.desktop", hidden("Log Out")],
    [`${LOOK_DIR}/wallpaper.png`, WALLPAPER],
    [`${LOOK_DIR}/mark.png`, MARK],
  ];
  return files.map(([path, data]) => ({ path, data: Buffer.isBuffer(data) ? data : Buffer.from(data) }));
}

/**
 * Run as the agent (`lookCommand`): unless the marker already names this look, each file is written (0600, its
 * folders 0700) and renamed into place, then the marker. As the agent's own process it writes nothing the agent
 * couldn't itself: a link the agent made in its home leads only to the agent's own files.
 */
export const LOOK_SCRIPT = [
  'h=$1 v=$2 m="$1/$3" && shift 3 && umask 077',
  '[ "$(cat "$m" 2>/dev/null)" = "$v" ] && exit 0',
  'while [ $# -ge 2 ]; do f="$h/$1"; mkdir -p "$(dirname "$f")" && printf %s "$2" | base64 -d > "$f.new" && mv -f "$f.new" "$f" || exit 1; shift 2; done',
  'mkdir -p "$(dirname "$m")" && printf "%s\\n" "$v" > "$m"',
].join("\n");

/** `sh -c LOOK_SCRIPT agentes-look <HOME> <look id> <marker> (<path under HOME> <base64>)...` */
export function lookCommand(home: string, theme: LookTheme): string[] {
  const files = lookFiles(home, theme).flatMap((f) => [f.path, f.data.toString("base64")]);
  return ["/bin/sh", "-c", LOOK_SCRIPT, "agentes-look", home, lookId(theme), LOOK_MARKER, ...files];
}
