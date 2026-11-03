import { AGENT_BROWSER_SHA256, AGENT_BROWSER_VERSION, agentBrowserUrl } from "@agenteschat/adapters/machine-protocol";
import { TERM_SH } from "@agenteschat/setup/src/term-sh";
import { DEFAULT_AGENT_UID_RANGE, SYSTEM_RUNNER_HOME } from "./config";

/** Quotes a value for POSIX sh (single quotes; a `'` becomes `'\''`). */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The Bun a system-mode runner runs on, and any runner whose computer has no
 * Bun with `Bun.Terminal` (1.3.5 or newer), which screens and terminals
 * need: the one the repo builds and tests with (`packageManager` in
 * package.json, kept equal by a test).
 */
export const RUNNER_BUN_VERSION = "1.4.4";
/** SHA-256 (hex) of each `bun-<target>.zip` of `RUNNER_BUN_VERSION`, checked before it is installed. */
export const RUNNER_BUN_SHA256 = {
  "linux-x64": "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c",
  "linux-x64-baseline": "e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76",
  "linux-aarch64": "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e",
  "darwin-x64-baseline": "d4a155adfbfd09155eb3ba05c9e3a544f39297d7a68616d3c7759f67ab5c47dc",
  "darwin-aarch64": "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510",
} as const;

/**
 * Debian/Ubuntu packages for the agents' screens (`--system --desktop`),
 * installed without recommends: those would add a screen locker nobody can
 * unlock, more daemons, and a set of folders in every agent's home.
 */
export const DESKTOP_APT_PACKAGES = [
  "tigervnc-standalone-server",
  "xauth",
  "dbus-x11",
  "xfce4-session",
  "xfwm4",
  "xfce4-panel",
  "xfdesktop4",
  "xfce4-settings",
  "thunar",
  "xfce4-terminal",
  "adwaita-icon-theme",
  "elementary-xfce-icon-theme",
  "fonts-noto-core",
] as const;

/**
 * The desktops' theme (ADR 0058 §15), installed after `DESKTOP_APT_PACKAGES` where apt has it (Debian 12 and
 * 13, Ubuntu 24.04 with universe; not Ubuntu 22.04): without it the desktops keep GTK's and xfwm4's own. Orchis
 * draws its window buttons from SVG files, so gdk-pixbuf's SVG loader comes with it.
 */
export const DESKTOP_LOOK_APT_PACKAGES = ["orchis-gtk-theme", "librsvg2-common"] as const;

/**
 * Chinese, Japanese and Korean for what the agents' desktops show (their browser among them): without it that
 * text is empty boxes. Installed after the theme where apt has it, on its own since Ubuntu 22.04 has no Orchis
 * (about 91 MB on Debian 13 and Ubuntu 24.04).
 */
export const DESKTOP_CJK_APT_PACKAGES = ["fonts-noto-cjk"] as const;

/**
 * The desktops' dock (ADR 0058 §15), each app's windows on its own launcher, installed after the fonts in an apt
 * call of its own, where apt has it: Debian 13 (0.4.3, about 0.5 MB with nothing else to bring) and Ubuntu 25.04
 * or newer (universe); not Debian 12 or Ubuntu 22.04 and 24.04, whose desktops keep the panel's own launchers and
 * window buttons.
 */
export const DESKTOP_DOCK_APT_PACKAGES = ["xfce4-docklike-plugin"] as const;

/**
 * What system mode's isolation runs (`--system`): `nft` for the loopback guard, which won't start without it, and
 * `ss` for the bind check.
 */
export const ISOLATION_APT_PACKAGES = ["nftables", "iproute2"] as const;

/** System mode: the runner and its Bun (root's, readable by the agents' users), and the command on the PATH. */
export const SYSTEM_RUNNER_DIR = "/opt/agentes-runner";
export const SYSTEM_LAUNCHER = "/usr/local/bin/agentes-runner";
/** System mode on x86_64: `agent-browser-<version>`, root's, for every agent's user to run. */
export const SYSTEM_BROWSER_DIR = `${SYSTEM_RUNNER_DIR}/browser`;

/** Where Google Chrome stable's Linux package (`google-chrome-stable`) installs it. */
export const GOOGLE_CHROME_LINUX = "/opt/google/chrome/chrome";

/**
 * Google's apt repository for Chrome, set up as the `google-chrome-stable` package's own postinst sets it up
 * (Chrome 156): the same files with the same contents, so the package's setup and its daily check rewrite them as
 * they are, and apt never sees the repository twice with two keyrings (an error).
 */
export const GOOGLE_APT = {
  key: "https://dl.google.com/linux/linux_signing_key.pub",
  /** Google's Linux package signing key (`gpg --show-keys`, checked 2026-11-03): any other key is refused. */
  fingerprint: "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796",
  keyring: "/usr/share/keyrings/google-chrome.gpg",
  sources: "/etc/apt/sources.list.d/google-chrome.sources",
  uri: "https://dl.google.com/linux/chrome-stable/deb/",
  /** Unattended upgrades take Chrome's updates too (written only when the installer installed Chrome). */
  unattended: "/etc/apt/apt.conf.d/52agentes-google-chrome",
  /** `--desktop`: hides Chrome's own menu entry, so the agents' menus don't offer a second Chrome on the default profile. */
  desktopEntry: "/usr/local/share/applications/google-chrome.desktop",
} as const;

/**
 * The installer served at `GET /api/machines/install.sh`:
 *
 *   curl -fsSL <publicUrl>/api/machines/install.sh | sh -s -- [--dir DIR] [--no-exec] [--name NAME] [--no-service]
 *
 * Picks the runtime, downloads the runner bundle from
 * `<publicUrl>/runner/agentes-runner.mjs`, writes a launcher in
 * `~/.agentes-runner/bin`, connects this computer with a device code
 * (`agentes-runner pair` prints a code and a link and waits for someone to
 * confirm it on the site, ADR 0036 §5) and installs the service. A home
 * that is already connected keeps its connection (running it again updates
 * the runner).
 *
 * The runtime is a Bun with `Bun.Terminal`, which the agents' screens and
 * terminals need (ADR 0058): the computer's own, else `RUNNER_BUN_VERSION`
 * fetched into `~/.agentes-runner/runtime` and checked against
 * `RUNNER_BUN_SHA256`. Only when that can't be had (another platform, no
 * unzip, no download) Node.js 22+ or an older Bun, and it says what that
 * runner lacks.
 *
 * `--system` (Linux, root) installs the runner for the whole computer, each
 * agent as its own OS user: `ISOLATION_APT_PACKAGES` (without apt it names
 * them), the pinned Bun and the bundle in
 * `SYSTEM_RUNNER_DIR`, on x86_64 the pinned `agent-browser` in
 * `SYSTEM_BROWSER_DIR` (checked against its SHA-256, so no agent downloads it
 * at its browser's first use; one that can't be fetched is left to that first
 * use, warned about), Google Chrome stable from Google's apt repository
 * (`GOOGLE_APT`, its key checked against its fingerprint) when the computer
 * has none, kept up to date by its package updates, the launcher at
 * `SYSTEM_LAUNCHER`, the home
 * `SYSTEM_RUNNER_HOME` (0700) and the root unit (`service install --system`).
 * With `--no-pair` it doesn't connect, with `--no-start` it starts nothing,
 * `--desktop` adds `DESKTOP_APT_PACKAGES` (then `DESKTOP_LOOK_APT_PACKAGES`,
 * `DESKTOP_CJK_APT_PACKAGES` and `DESKTOP_DOCK_APT_PACKAGES`, each in an apt call
 * of its own, where apt has them), and `--agent-uid-range` sets the
 * agents' uids (default `DEFAULT_AGENT_UID_RANGE`). Everything runs from
 * `main`, so a download cut short runs nothing.
 *
 * `--runner-sha256 HEX` (any mode) installs the bundle only when it has that
 * SHA-256: whoever runs the installer for a fleet pins the runner it vouches
 * for, so a root runner never runs whatever the server happens to serve.
 *
 * `--server URL` is where this computer reaches the server, when that isn't
 * the address the script names (the server's own machine, say, reaching it at
 * `http://127.0.0.1:3000` while people use a tailnet name). With `--system`,
 * or alone on a Mac (agents working as the person there), `--host-token-file
 * PATH` makes this the server's own computer: the service runs `agentes-runner
 * host` with the server's `HOST_COMPUTER_TOKEN` from that file instead of
 * pairing, with `--no-exec` passed on. A computer already connected (its
 * home has a token) is refused: its service would be replaced.
 *
 * `--enroll-file FILE` (any mode) connects with a code issued for this
 * computer instead (`agentes-runner pair --enroll-file`, ADR 0056 §10),
 * connected before or not.
 */
export function installScript(publicUrl: string): string {
  const server = shQuote(publicUrl.trim().replace(/\/+$/, ""));
  const uids = DEFAULT_AGENT_UID_RANGE.join("-");
  const shaCases = Object.entries(RUNNER_BUN_SHA256)
    .map(([target, sha]) => `    ${target}) BUN_SHA256=${shQuote(sha)} ;;`)
    .join("\n");
  return `#!/bin/sh
# agentes.chat runner installer: connects this computer to your organization.
# Usage: curl -fsSL <server>/api/machines/install.sh | sh -s -- [--dir DIR] [--no-exec] [--name NAME] [--no-service] [--enroll-file FILE]
# On a Linux server, as root, the runner for the whole computer with each agent as its own user:
#        curl -fsSL <server>/api/machines/install.sh | sh -s -- --system [--desktop] [--no-pair] [--no-start] [--agent-uid-range FIRST-LAST] [--enroll-file FILE]
set -eu

SERVER=${server}
BUN_VERSION=${shQuote(RUNNER_BUN_VERSION)}
ISOLATION_PACKAGES=${shQuote(ISOLATION_APT_PACKAGES.join(" "))}
DESKTOP_PACKAGES=${shQuote(DESKTOP_APT_PACKAGES.join(" "))}
LOOK_PACKAGES=${shQuote(DESKTOP_LOOK_APT_PACKAGES.join(" "))}
CJK_PACKAGES=${shQuote(DESKTOP_CJK_APT_PACKAGES.join(" "))}
DOCK_PACKAGES=${shQuote(DESKTOP_DOCK_APT_PACKAGES.join(" "))}
AB_VERSION=${shQuote(AGENT_BROWSER_VERSION)}
AB_SHA256=${shQuote(AGENT_BROWSER_SHA256["linux-x64"])}
AB_URL=${shQuote(agentBrowserUrl("linux-x64"))}
CHROME_EXE=${shQuote(GOOGLE_CHROME_LINUX)}
CHROME_KEY_URL=${shQuote(GOOGLE_APT.key)}
CHROME_KEY_FPR=${shQuote(GOOGLE_APT.fingerprint)}
CHROME_KEYRING=${shQuote(GOOGLE_APT.keyring)}
CHROME_SOURCES=${shQuote(GOOGLE_APT.sources)}
CHROME_URI=${shQuote(GOOGLE_APT.uri)}
CHROME_UNATTENDED=${shQuote(GOOGLE_APT.unattended)}
CHROME_DESKTOP=${shQuote(GOOGLE_APT.desktopEntry)}

DIR=""
NAME=""
NO_EXEC=0
NO_SERVICE=0
SYSTEM=0
DESKTOP=0
NO_PAIR=0
NO_START=0
UID_RANGE=""
RUNNER_SHA256=""
HOST_TOKEN_FILE=""
SERVER_FLAG=""
ENROLL_FILE=""

${TERM_SH}
die() {
  t_fail "$*"
  exit 1
}
need_value() { [ "$2" -ge 2 ] || die "$1 needs a value"; }
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\\\\\''/g")"; }
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d ' ' -f 1
}

usage() {
  printf '%s\\n' "Usage: sh install.sh [--dir DIR] [--no-exec] [--name NAME] [--no-service] [--enroll-file FILE]" \\
    "       sh install.sh --system [--desktop] [--no-pair] [--no-start] [--agent-uid-range FIRST-LAST] [--enroll-file FILE]" \\
    "" \\
    "  --system           Linux, as root: the runner for the whole computer, each agent as its own user" \\
    "  --desktop          with --system: also the packages for the agents' screens" \\
    "  --no-pair          with --system: don't connect it to the server now" \\
    "  --no-start         with --system: install or update without starting or restarting the service" \\
    "  --agent-uid-range  with --system: the uids agent users get (default ${uids})" \\
    "  --runner-sha256    install the runner only if its download has this SHA-256 (64 hex digits)" \\
    "  --server           where this computer reaches the server, if not at $SERVER" \\
    "  --host-token-file  with --system (alone on a Mac): this server's own computer, with HOST_COMPUTER_TOKEN from this file" \\
    "  --enroll-file      connect with the code issued for this computer in FILE (removed once read), connected before or not"
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "curl or wget is needed to download the runner" >&2
    return 1
  fi
}

# The frame from here on, its runner commands drawing in it (AGENTES_FRAME=1): what the refusals above leave out.
start_frame() {
  t_intro "connect this computer"
  AGENTES_FRAME=1
  export AGENTES_FRAME
}

# Downloads the runner to $BUNDLE and writes $LAUNCHER (home $RUNNER_HOME, runtime $RUNTIME).
get_runner() {
  t_run "Downloading the runner from $SERVER" download "$SERVER/runner/agentes-runner.mjs" "$BUNDLE.download" || {
    t_tail "$T_LOG"
    die "download failed"
  }
  if [ -n "$RUNNER_SHA256" ] && [ "$(sha256 "$BUNDLE.download")" != "$RUNNER_SHA256" ]; then
    rm -f "$BUNDLE.download"
    die "the runner download didn't match --runner-sha256, so it was not installed"
  fi
  chmod 644 "$BUNDLE.download"
  mv -f "$BUNDLE.download" "$BUNDLE"
  {
    printf '#!/bin/sh\\n'
    printf 'AGENTES_RUNNER_HOME=%s\\n' "$(quote "$RUNNER_HOME")"
    printf 'export AGENTES_RUNNER_HOME\\n'
    printf 'exec %s %s "$@"\\n' "$(quote "$RUNTIME")" "$(quote "$BUNDLE")"
  } > "$LAUNCHER.new"
  chmod 755 "$LAUNCHER.new"
  mv -f "$LAUNCHER.new" "$LAUNCHER"
  t_step "The runner, from $SERVER"
}

# Connects this computer, unless it already is (and no code was issued for it) or --no-pair.
connect() {
  if [ -z "$ENROLL_FILE" ] && [ -f "$RUNNER_HOME/config.json" ] && grep -q '"token"' "$RUNNER_HOME/config.json" 2>/dev/null; then
    t_step "This computer is already connected (runner updated). To connect it again:"
    t_cmd "$LAUNCHER pair --server $SERVER"
  elif [ "$NO_PAIR" -eq 0 ]; then
    # Prints a code and a link, and waits until someone confirms it on the site (an issued code needs nobody).
    set -- pair --server "$SERVER"
    if [ -n "$ENROLL_FILE" ]; then set -- "$@" --enroll-file "$ENROLL_FILE"; fi
    if [ -n "$DIR" ]; then set -- "$@" --dir "$DIR"; fi
    if [ -n "$NAME" ]; then set -- "$@" --name "$NAME"; fi
    if [ "$NO_EXEC" -eq 1 ]; then set -- "$@" --no-exec; fi
    t_gap
    # Ctrl-C at the code reaches pair too, which says Canceled and exits 130. Caught here, so the installer waits
    # for those last lines (dash would stop at once, under them), then ends as canceled, not failed.
    trap : INT
    PAIRED=0
    "$LAUNCHER" "$@" || PAIRED=$?
    trap - INT
    if [ "$PAIRED" -eq 130 ]; then exit 130; fi
    [ "$PAIRED" -eq 0 ] || die "connecting this computer failed"
  fi
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive
  export DEBIAN_FRONTEND
  # A fresh server may be updating itself: wait for its lock instead of failing.
  apt-get -qq -o DPkg::Lock::Timeout=600 update || true
  apt-get -qq -o DPkg::Lock::Timeout=600 install -y --no-install-recommends "$@"
}

# $PACKAGES, then with --desktop the screens' theme, CJK fonts and dock, each in an apt call of its own:
# apt lacks some of them on some releases, and those are named in $NOT_INSTALLED.
apt_packages() {
  NOT_INSTALLED=''
  # shellcheck disable=SC2086
  apt_install $PACKAGES || return
  if [ "$DESKTOP" -eq 1 ]; then
    # shellcheck disable=SC2086
    apt-get -qq -o DPkg::Lock::Timeout=600 install -y --no-install-recommends $LOOK_PACKAGES ||
      NOT_INSTALLED="$NOT_INSTALLED look"
    # shellcheck disable=SC2086
    apt-get -qq -o DPkg::Lock::Timeout=600 install -y --no-install-recommends $CJK_PACKAGES ||
      NOT_INSTALLED="$NOT_INSTALLED cjk"
    # shellcheck disable=SC2086
    apt-get -qq -o DPkg::Lock::Timeout=600 install -y --no-install-recommends $DOCK_PACKAGES ||
      NOT_INSTALLED="$NOT_INSTALLED dock"
  fi
}

# What keeps the agents apart, and with --desktop the packages for their screens.
system_packages() {
  PACKAGES="$ISOLATION_PACKAGES" WHAT="the agents' isolation"
  if [ "$DESKTOP" -eq 1 ]; then
    PACKAGES="$PACKAGES $DESKTOP_PACKAGES" WHAT="the agents' isolation and screens"
  fi
  if command -v apt-get >/dev/null 2>&1; then
    t_run "Installing the packages for $WHAT" apt_packages || {
      t_tail "$T_LOG"
      die "installing the packages for $WHAT failed"
    }
    t_step "The packages for $WHAT"
    case $NOT_INSTALLED in *look*) t_warn "The agents' screens keep the stock theme: apt has no $LOOK_PACKAGES here" ;; esac
    case $NOT_INSTALLED in
      *cjk*) t_warn "The agents' screens show Chinese, Japanese and Korean text as boxes: apt has no $CJK_PACKAGES here" ;;
    esac
    case $NOT_INSTALLED in *dock*) t_warn "The agents' screens keep the panel's own dock: apt has no $DOCK_PACKAGES here" ;; esac
  else
    t_warn "For $WHAT, install these packages (Debian names) with this computer's package manager: $PACKAGES"
  fi
}

unpack() {
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$1" -d "$2"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m zipfile -e "$1" "$2"
  elif [ "$(id -u)" -eq 0 ] && command -v apt-get >/dev/null 2>&1; then
    apt_install unzip && unzip -q -o "$1" -d "$2"
  else
    return 1
  fi
}

# A Bun with Bun.Terminal (1.3.5 or newer): the agents' screens and the terminal need it.
has_terminal() { [ -x "$1" ] && "$1" -e 'process.exit("Terminal" in Bun ? 0 : 1)' >/dev/null 2>&1; }

# The pinned Bun at $1, kept when it is there at that version, checked against its SHA-256 before it is
# installed. Fails with WHY set where there's no pinned build or it can't be fetched or run here.
fetch_bun() {
  WHY=""
  if [ "$("$1" --version 2>/dev/null || true)" = "$BUN_VERSION" ]; then return 0; fi
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64|Linux-amd64)
      BUN_TARGET=linux-x64
      # Bun's default x64 build needs AVX2.
      grep -qw avx2 /proc/cpuinfo 2>/dev/null || BUN_TARGET=linux-x64-baseline ;;
    Linux-aarch64|Linux-arm64) BUN_TARGET=linux-aarch64 ;;
    Darwin-x86_64) BUN_TARGET=darwin-x64-baseline ;;
    Darwin-arm64) BUN_TARGET=darwin-aarch64 ;;
    *) WHY="there is no build of it for $(uname -s) on $(uname -m)"; return 1 ;;
  esac
  case "$BUN_TARGET" in
${shaCases}
  esac
  WORK=$(mktemp -d) || { WHY="no temporary folder for it"; return 1; }
  if ! t_run "Downloading Bun $BUN_VERSION" download "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$BUN_TARGET.zip" "$WORK/bun.zip"; then
    WHY="the download failed"
  elif [ "$(sha256 "$WORK/bun.zip")" != "$BUN_SHA256" ]; then
    WHY="the download didn't match its checksum, so it was not installed"
  elif ! unpack "$WORK/bun.zip" "$WORK"; then
    WHY="unpacking it needs unzip or python3"
  elif cp "$WORK/bun-$BUN_TARGET/bun" "$1.new" && chmod 755 "$1.new" &&
    [ "$("$1.new" --version 2>/dev/null || true)" = "$BUN_VERSION" ]; then
    mv -f "$1.new" "$1"
  else
    WHY="it doesn't run on this computer"
  fi
  rm -rf "$WORK" "$1.new"
  [ -z "$WHY" ]
}

# The pinned Bun in $SYSTEM_DIR/bin; never one from the PATH, which root would then run.
get_bun() {
  RUNTIME="$SYSTEM_DIR/bin/bun"
  fetch_bun "$RUNTIME" || die "no Bun $BUN_VERSION for the runner: $WHY"
  t_step "Bun $BUN_VERSION (SHA-256 checked)"
}

# In $1, every $2-<version> but $3 and the one installed last before it (a runner not restarted yet may still run
# that one), and whatever an interrupted install left (.$2-*).
prune() {
  KEEP=$(ls -1dt "$1/$2"-* 2>/dev/null | grep -vxF "$3" | head -n 1)
  for OLD in "$1/$2"-* "$1/.$2"-*; do
    case "$OLD" in "$3" | "$KEEP" | "$1/$2-*" | "$1/.$2-*") ;; *) rm -rf "$OLD" ;; esac
  done
}

# What of the agents' browser couldn't be installed here, each agent's runner installs at its browser's first use,
# so the install goes on; only a download that isn't the pinned one stops it.
browser_later() {
  t_tail "$T_LOG"
  t_warn "$1: each agent installs what's missing at its browser's first use"
}

# The agents' agent-browser in $BROWSER_DIR, for every agent's user to run and root alone to write, checked against
# its SHA-256 before it is installed, so no agent downloads it at its browser's first use. One already there at that
# checksum is kept. Only on x86_64, the build pinned here.
get_browser() {
  case "$(uname -m)" in x86_64 | amd64) ;; *) return 0 ;; esac
  mkdir -p "$BROWSER_DIR"
  chown 0:0 "$BROWSER_DIR"
  chmod 755 "$BROWSER_DIR"
  AB="$BROWSER_DIR/agent-browser-$AB_VERSION"
  if [ ! -f "$AB" ] || [ "$(sha256 "$AB")" != "$AB_SHA256" ]; then
    TMP="$BROWSER_DIR/.agent-browser-$AB_VERSION.download"
    t_run "Downloading agent-browser $AB_VERSION" download "$AB_URL" "$TMP" || {
      rm -f "$TMP"
      browser_later "Downloading agent-browser $AB_VERSION failed"
      return 0
    }
    if [ "$(sha256 "$TMP")" != "$AB_SHA256" ]; then
      rm -f "$TMP"
      die "the agent-browser download didn't match its checksum, so it was not installed"
    fi
    chmod 755 "$TMP"
    mv -f "$TMP" "$AB"
  fi
  prune "$BROWSER_DIR" agent-browser "$AB"
  t_step "agent-browser $AB_VERSION (SHA-256 checked)"
}

# Google's key for its apt repository into $CHROME_KEYRING, refused unless its fingerprint is the one pinned here
# (BAD_KEY=1): apt then checks every package from that repository against it.
chrome_key() {
  command -v gpg >/dev/null 2>&1 || apt_install gpg || return 1
  KEY_DIR=$(mktemp -d) || return 1
  download "$CHROME_KEY_URL" "$KEY_DIR/key.asc" || { rm -rf "$KEY_DIR"; return 1; }
  FPR=$(GNUPGHOME="$KEY_DIR" gpg --batch --show-keys --with-colons "$KEY_DIR/key.asc" 2>/dev/null |
    sed -n 's/^fpr:*\\([0-9A-F]*\\):.*/\\1/p' | head -n 1)
  if [ "$FPR" != "$CHROME_KEY_FPR" ]; then
    rm -rf "$KEY_DIR"
    BAD_KEY=1
    return 1
  fi
  mkdir -p "$(dirname "$CHROME_KEYRING")"
  KEY_RC=0
  GNUPGHOME="$KEY_DIR" gpg --batch --yes --dearmor -o "$CHROME_KEYRING.new" "$KEY_DIR/key.asc" &&
    chmod 644 "$CHROME_KEYRING.new" && mv -f "$CHROME_KEYRING.new" "$CHROME_KEYRING" || KEY_RC=1
  rm -rf "$KEY_DIR"
  return "$KEY_RC"
}

# Google Chrome stable from Google's apt repository, set up as its own package sets it up, so the computer's package
# updates keep it current (unattended upgrades included). Its sandbox helper never runs as root for the agents' users:
# Chrome sandboxes with user namespaces (which --system's Debian has), and dpkg keeps that mode across upgrades. The
# package makes itself the default web browser: the computer's own choice is put back.
install_chrome() {
  chrome_key || return 1
  SANDBOX="$(dirname "$CHROME_EXE")/chrome-sandbox"
  dpkg-statoverride --list "$SANDBOX" >/dev/null 2>&1 || dpkg-statoverride --add root root 0755 "$SANDBOX" || return 1
  ARCH=$(dpkg --print-architecture) || return 1
  mkdir -p "$(dirname "$CHROME_SOURCES")"
  printf '%s\\n' '### THIS FILE IS AUTOMATICALLY CONFIGURED ###' '# Changes to this file will not be preserved.' \\
    '# This file will not be recreated if removed.' 'X-Repolib-Name: Google Chrome' 'Types: deb' "URIs: $CHROME_URI" \\
    'Suites: stable' 'Components: main' "Architectures: $ARCH" "Signed-By: $CHROME_KEYRING" > "$CHROME_SOURCES"
  chmod 644 "$CHROME_SOURCES"
  WWW=$(update-alternatives --query x-www-browser 2>/dev/null | sed -n 's/^Value: //p')
  GNOME_WWW=$(update-alternatives --query gnome-www-browser 2>/dev/null | sed -n 's/^Value: //p')
  apt_install google-chrome-stable || return 1
  if [ -n "$WWW" ]; then update-alternatives --set x-www-browser "$WWW" || true; fi
  if [ -n "$GNOME_WWW" ]; then update-alternatives --set gnome-www-browser "$GNOME_WWW" || true; fi
  mkdir -p "$(dirname "$CHROME_UNATTENDED")"
  printf '%s\\n' 'Unattended-Upgrade::Origins-Pattern { "origin=Google LLC,codename=stable"; };' > "$CHROME_UNATTENDED"
  chmod 644 "$CHROME_UNATTENDED"
}

chrome_version() { "$CHROME_EXE" --version 2>/dev/null | sed -n 's/^Google Chrome \\([0-9.]*\\).*/\\1/p'; }

# The agents' browser is the computer's Google Chrome: installed when it has none (with apt), never pinned. A key that
# isn't Google's stops the install; anything else only says so, and each agent says so when it needs its browser.
get_chrome() {
  if [ -x "$CHROME_EXE" ]; then
    V=$(chrome_version)
    t_step "Google Chrome\${V:+ $V}, updated by this computer's own updates"
  elif ! command -v apt-get >/dev/null 2>&1; then
    t_warn "The agents' browser needs Google Chrome: install it (google.com/chrome) with this computer's package manager"
    return 0
  else
    BAD_KEY=0
    if ! t_run "Installing Google Chrome from Google's apt repository" install_chrome; then
      [ "$BAD_KEY" -eq 0 ] || die "Google's apt key didn't match its fingerprint, so Google Chrome was not installed"
      t_tail "$T_LOG"
      t_warn "Installing Google Chrome failed: run this installer again. Until then the agents say Chrome isn't installed"
      return 0
    fi
    V=$(chrome_version)
    t_step "Google Chrome\${V:+ $V}, updated with this computer's packages"
  fi
  if [ "$DESKTOP" -eq 1 ]; then
    mkdir -p "$(dirname "$CHROME_DESKTOP")"
    printf '%s\\n' '[Desktop Entry]' 'Type=Application' 'Name=Google Chrome' 'Exec=/usr/bin/google-chrome-stable' \\
      'NoDisplay=true' > "$CHROME_DESKTOP"
    chmod 644 "$CHROME_DESKTOP"
  fi
}

# Chrome for Testing, which runners before Google Chrome used: removed once the runner restarted without it.
forget_testing_chrome() { rm -rf "$BROWSER_DIR"/chrome-* "$BROWSER_DIR"/.chrome-*; }

# This server's computer replaces the service a connected runner in $RUNNER_HOME runs as (the root unit,
# or the launchd agent's label), which would leave that connection's server without this computer.
not_connected_for_host() {
  if [ -n "$HOST_TOKEN_FILE" ] && [ -f "$RUNNER_HOME/config.json" ] && grep -q '"token"' "$RUNNER_HOME/config.json" 2>/dev/null; then
    die "this computer is already connected to agentes.chat as a computer, so it can't also be this server's own"
  fi
}

# The end of the frame: the command, by its name, then Done.
finish() {
  t_gap
  t_info "The agentes-runner command is $LAUNCHER. To check this computer's connection:"
  t_cmd "$1 status"
  t_gap
  t_end Done
}

install_system() {
  [ "$(id -u)" -eq 0 ] ||
    die "--system installs the runner for the whole computer: run it as root (curl -fsSL $SERVER/api/machines/install.sh | sudo sh -s -- --system)"
  [ "$(uname -s)" = Linux ] || die "--system is for Linux"
  # Each agent's slice keeps it off the others' browser ports with systemd's BPF programs: without them no agent's
  # process starts.
  systemctl --version 2>/dev/null | grep -q '+BPF_FRAMEWORK' ||
    die "--system needs systemd built with BPF_FRAMEWORK (systemctl --version shows +BPF_FRAMEWORK), as on Debian 13; Ubuntu's isn't, so agents can't work on this computer as users of their own"
  SYSTEM_DIR=${shQuote(SYSTEM_RUNNER_DIR)}
  BROWSER_DIR=${shQuote(SYSTEM_BROWSER_DIR)}
  RUNNER_HOME=${shQuote(SYSTEM_RUNNER_HOME)}
  not_connected_for_host
  start_frame
  system_packages
  BUNDLE="$SYSTEM_DIR/agentes-runner.mjs"
  LAUNCHER=${shQuote(SYSTEM_LAUNCHER)}
  mkdir -p "$SYSTEM_DIR/bin" "$RUNNER_HOME" "$(dirname "$LAUNCHER")"
  # Folders someone else made earlier would let them swap what root runs.
  chown 0:0 "$SYSTEM_DIR" "$SYSTEM_DIR/bin" "$RUNNER_HOME"
  chmod 755 "$SYSTEM_DIR" "$SYSTEM_DIR/bin"
  chmod 700 "$RUNNER_HOME"
  get_bun
  get_browser
  get_chrome
  get_runner
  set -- service install --system --no-start
  if [ -n "$UID_RANGE" ]; then set -- "$@" --agent-uid-range "$UID_RANGE"; fi
  "$LAUNCHER" "$@" || die "installing the service failed"
  if [ -n "$HOST_TOKEN_FILE" ]; then
    # Only root reads the token.
    chmod 600 "$HOST_TOKEN_FILE"
    set -- service install --host --server "$SERVER" --token-file "$HOST_TOKEN_FILE"
    if [ "$NO_START" -eq 1 ]; then set -- "$@" --no-start; fi
    if [ "$NO_EXEC" -eq 1 ]; then set -- "$@" --no-exec; fi
    "$LAUNCHER" "$@" || die "installing this server's computer failed"
  else
    connect
    if [ "$NO_START" -eq 0 ]; then "$LAUNCHER" service install --system || die "starting the service failed"; fi
  fi
  if [ "$NO_START" -eq 0 ]; then forget_testing_chrome; fi
  finish agentes-runner
}

install_user() {
  RUNNER_HOME="\${AGENTES_RUNNER_HOME:-$HOME/.agentes-runner}"
  BUNDLE="$RUNNER_HOME/agentes-runner.mjs"
  LAUNCHER="$RUNNER_HOME/bin/agentes-runner"
  if [ -f "$RUNNER_HOME/config.json" ] && grep -q '"managedBy": *"desktop"' "$RUNNER_HOME/config.json" 2>/dev/null; then
    die "this computer is connected by the agentes app, so manage it there (or set AGENTES_RUNNER_HOME to another folder)"
  fi
  not_connected_for_host
  start_frame
  mkdir -p "$RUNNER_HOME/bin" "$RUNNER_HOME/runtime"
  chmod 700 "$RUNNER_HOME"

  # This computer's Bun when it has Bun.Terminal, else the pinned one; Node.js 22+ (or an older Bun)
  # only when there is neither, since a runner there gets no screens and no terminal.
  RUNTIME=""
  for CANDIDATE in "$(command -v bun 2>/dev/null || true)" "$HOME/.bun/bin/bun"; do
    if [ -n "$CANDIDATE" ] && has_terminal "$CANDIDATE"; then
      RUNTIME=$CANDIDATE
      t_step "Bun $("$RUNTIME" --version 2>/dev/null || true) ($RUNTIME)"
      break
    fi
  done
  if [ -z "$RUNTIME" ]; then
    if fetch_bun "$RUNNER_HOME/runtime/bun"; then
      RUNTIME="$RUNNER_HOME/runtime/bun"
      t_step "Bun $BUN_VERSION (SHA-256 checked)"
    else
      t_warn "No Bun $BUN_VERSION: $WHY."
    fi
  fi
  if [ -z "$RUNTIME" ]; then
    if command -v node >/dev/null 2>&1; then
      NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v//; s/\\..*//')
      case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
      if [ "$NODE_MAJOR" -ge 22 ]; then RUNTIME=$(command -v node); fi
    fi
    if [ -z "$RUNTIME" ] && command -v bun >/dev/null 2>&1; then RUNTIME=$(command -v bun); fi
    if [ -z "$RUNTIME" ] && [ -x "$HOME/.bun/bin/bun" ]; then RUNTIME="$HOME/.bun/bin/bun"; fi
    if [ -n "$RUNTIME" ]; then
      t_warn "The runner runs on $RUNTIME, so agents get no screens and no terminal on this computer: those need Bun 1.3.5 or newer."
    fi
  fi
  if [ -z "$RUNTIME" ]; then
    T_FD=2
    t_say "$C_FAIL$M_FAIL$C_OFF" "$C_BOLD" "The runner needs Bun 1.3.5 or newer, or Node.js 22 or newer. Install one, then run this again:"
    t_cmd "curl -fsSL https://bun.sh/install | bash" "Bun:  "
    t_cmd "brew install node" "macOS:"
    t_cmd "https://nodejs.org/en/download (or: curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22)" "Linux:"
    t_stop
    exit 1
  fi

  get_runner
  if [ -n "$HOST_TOKEN_FILE" ]; then
    chmod 600 "$HOST_TOKEN_FILE"
    set -- service install --host --server "$SERVER" --token-file "$HOST_TOKEN_FILE"
    if [ "$NO_EXEC" -eq 1 ]; then set -- "$@" --no-exec; fi
    "$LAUNCHER" "$@" || die "installing this server's computer failed"
    finish "$LAUNCHER"
    return 0
  fi
  connect

  SERVICE=0
  if [ "$NO_SERVICE" -eq 0 ]; then
    if [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
      SERVICE=1
    elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
      SERVICE=1
    fi
  fi

  if [ "$SERVICE" -eq 1 ]; then
    if ! "$LAUNCHER" service install; then
      t_warn "Couldn't install the service. Start the runner yourself:"
      t_cmd "$LAUNCHER start"
    fi
  else
    t_gap
    t_info "Start the runner (keep it running, for example in tmux):"
    t_cmd "$LAUNCHER start"
  fi

  t_gap
  t_info "To use the agentes-runner command, add it to your PATH:"
  t_cmd "export PATH=\\"$RUNNER_HOME/bin:\\$PATH\\""
  t_gap
  t_end Done
}

main() {
  t_init 1
  # The waits' output (t_run): kept for a failure's last lines, removed when the installer exits.
  T_LOGS=$(mktemp -d 2>/dev/null) || T_LOGS=''
  if [ -n "$T_LOGS" ]; then trap 'rm -rf "$T_LOGS"' EXIT; fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) need_value "$1" $#; DIR="$2"; shift 2 ;;
      --dir=*) DIR="\${1#--dir=}"; shift ;;
      --name) need_value "$1" $#; NAME="$2"; shift 2 ;;
      --name=*) NAME="\${1#--name=}"; shift ;;
      --no-exec) NO_EXEC=1; shift ;;
      --no-service) NO_SERVICE=1; shift ;;
      --system) SYSTEM=1; shift ;;
      --desktop) DESKTOP=1; shift ;;
      --no-pair) NO_PAIR=1; shift ;;
      --no-start) NO_START=1; shift ;;
      --agent-uid-range) need_value "$1" $#; UID_RANGE="$2"; shift 2 ;;
      --agent-uid-range=*) UID_RANGE="\${1#--agent-uid-range=}"; shift ;;
      --runner-sha256) need_value "$1" $#; RUNNER_SHA256="$2"; shift 2 ;;
      --server) need_value "$1" $#; SERVER_FLAG="$2"; shift 2 ;;
      --server=*) SERVER_FLAG="\${1#--server=}"; shift ;;
      --host-token-file) need_value "$1" $#; HOST_TOKEN_FILE="$2"; shift 2 ;;
      --host-token-file=*) HOST_TOKEN_FILE="\${1#--host-token-file=}"; shift ;;
      --runner-sha256=*) RUNNER_SHA256="\${1#--runner-sha256=}"; shift ;;
      --enroll-file) need_value "$1" $#; ENROLL_FILE="$2"; shift 2 ;;
      --enroll-file=*) ENROLL_FILE="\${1#--enroll-file=}"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  # Listed, not a range: shells may sort ranges by locale, letting capitals in.
  case "$RUNNER_SHA256" in
    *[!0123456789abcdef]*) die "--runner-sha256 takes the bundle's SHA-256 as 64 lowercase hex digits" ;;
  esac
  [ -z "$RUNNER_SHA256" ] || [ \${#RUNNER_SHA256} -eq 64 ] ||
    die "--runner-sha256 takes the bundle's SHA-256 as 64 lowercase hex digits"
  if [ -n "$SERVER_FLAG" ]; then
    SERVER=$(printf '%s' "$SERVER_FLAG" | sed 's:/*$::')
    case "$SERVER" in
      http://*|https://*) ;;
      *) die "--server takes the server's address, like http://127.0.0.1:3000" ;;
    esac
  fi
  [ -z "$HOST_TOKEN_FILE" ] || [ -r "$HOST_TOKEN_FILE" ] || die "--host-token-file: can't read $HOST_TOKEN_FILE"
  [ -z "$ENROLL_FILE" ] || [ "$NO_PAIR" -eq 0 ] || die "--enroll-file connects this computer, so it doesn't go with --no-pair"
  [ -z "$ENROLL_FILE" ] || [ -z "$HOST_TOKEN_FILE" ] ||
    die "--enroll-file doesn't go with --host-token-file: this server's own computer connects with its token"
  # On a Mac this server's computer runs as the person (agents in folders of their own), so it needs no --system.
  MAC_HOST=0
  if [ -n "$HOST_TOKEN_FILE" ] && [ "$(uname -s)" = Darwin ]; then MAC_HOST=1; fi
  if [ "$SYSTEM" -eq 1 ]; then
    [ "$NO_SERVICE" -eq 0 ] || die "--system always installs the service (to leave it stopped, use --no-start)"
    [ -z "$DIR" ] || die "--dir doesn't go with --system: each agent works in its own user's home"
    install_system
  elif [ "$DESKTOP" -eq 1 ] || [ "$NO_PAIR" -eq 1 ] || [ "$NO_START" -eq 1 ] || [ -n "$UID_RANGE" ] ||
    { [ -n "$HOST_TOKEN_FILE" ] && [ "$MAC_HOST" -eq 0 ]; }; then
    die "--desktop, --no-pair, --no-start, --agent-uid-range and --host-token-file go with --system (on a Mac, --host-token-file goes alone)"
  else
    [ "$MAC_HOST" -eq 0 ] || [ "$NO_SERVICE" -eq 0 ] ||
      die "--host-token-file installs the service: it's how this Mac keeps up with the server"
    install_user
  fi
}

main "$@"
`;
}
