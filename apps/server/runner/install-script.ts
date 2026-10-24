import { DEFAULT_AGENT_UID_RANGE, SYSTEM_RUNNER_HOME } from "./config";

/** Quotes a value for POSIX sh (single quotes; a `'` becomes `'\''`). */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The Bun a system-mode runner runs on: the one the repo builds and tests
 * with (`packageManager` in package.json, kept equal by a test). Screens and
 * terminals need Bun 1.3.5 or newer.
 */
export const RUNNER_BUN_VERSION = "1.4.4";
/** SHA-256 (hex) of each `bun-<target>.zip` of `RUNNER_BUN_VERSION`, checked before it is installed. */
export const RUNNER_BUN_SHA256 = {
  "linux-x64": "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c",
  "linux-x64-baseline": "e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76",
  "linux-aarch64": "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e",
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

/** System mode: the runner and its Bun (root's, readable by the agents' users), and the command on the PATH. */
export const SYSTEM_RUNNER_DIR = "/opt/agentes-runner";
export const SYSTEM_LAUNCHER = "/usr/local/bin/agentes-runner";

/**
 * The installer served at `GET /api/machines/install.sh`:
 *
 *   curl -fsSL <publicUrl>/api/machines/install.sh | sh -s -- [--dir DIR] [--no-exec] [--name NAME] [--no-service]
 *
 * Finds Node.js 22+ (or Bun), downloads the runner bundle from
 * `<publicUrl>/runner/agentes-runner.mjs`, writes a launcher in
 * `~/.agentes-runner/bin`, connects this computer with a device code
 * (`agentes-runner pair` prints a code and a link and waits for someone to
 * confirm it on the site, ADR 0036 §5) and installs the service. A home
 * that is already connected keeps its connection (running it again updates
 * the runner).
 *
 * `--system` (Linux, root) installs the runner for the whole computer, each
 * agent as its own OS user: the pinned Bun and the bundle in
 * `SYSTEM_RUNNER_DIR`, the launcher at `SYSTEM_LAUNCHER`, the home
 * `SYSTEM_RUNNER_HOME` (0700) and the root unit (`service install --system`).
 * With `--no-pair` it doesn't connect, with `--no-start` it starts nothing,
 * `--desktop` adds `DESKTOP_APT_PACKAGES`, and `--agent-uid-range` sets the
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
 * `--host-token-file PATH` makes this the server's own computer: the service
 * runs `agentes-runner host` with the server's `HOST_COMPUTER_TOKEN` from that
 * file instead of pairing.
 */
export function installScript(publicUrl: string): string {
  const server = shQuote(publicUrl.trim().replace(/\/+$/, ""));
  const uids = DEFAULT_AGENT_UID_RANGE.join("-");
  const shaCases = Object.entries(RUNNER_BUN_SHA256)
    .map(([target, sha]) => `    ${target}) BUN_SHA256=${shQuote(sha)} ;;`)
    .join("\n");
  return `#!/bin/sh
# agentes.chat runner installer: connects this computer to your organization.
# Usage: curl -fsSL <server>/api/machines/install.sh | sh -s -- [--dir DIR] [--no-exec] [--name NAME] [--no-service]
# On a Linux server, as root, the runner for the whole computer with each agent as its own user:
#        curl -fsSL <server>/api/machines/install.sh | sh -s -- --system [--desktop] [--no-pair] [--no-start] [--agent-uid-range FIRST-LAST]
set -eu

SERVER=${server}
BUN_VERSION=${shQuote(RUNNER_BUN_VERSION)}
DESKTOP_PACKAGES=${shQuote(DESKTOP_APT_PACKAGES.join(" "))}

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

say() { printf '%s\\n' "$*"; }
die() { printf 'agentes-runner: %s\\n' "$*" >&2; exit 1; }
need_value() { [ "$2" -ge 2 ] || die "$1 needs a value"; }
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\\\\\''/g")"; }
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d ' ' -f 1
}

usage() {
  say "Usage: sh install.sh [--dir DIR] [--no-exec] [--name NAME] [--no-service]"
  say "       sh install.sh --system [--desktop] [--no-pair] [--no-start] [--agent-uid-range FIRST-LAST]"
  say ""
  say "  --system           Linux, as root: the runner for the whole computer, each agent as its own user"
  say "  --desktop          with --system: also the packages for the agents' screens"
  say "  --no-pair          with --system: don't connect it to the server now"
  say "  --no-start         with --system: install or update without starting or restarting the service"
  say "  --agent-uid-range  with --system: the uids agent users get (default ${uids})"
  say "  --runner-sha256    install the runner only if its download has this SHA-256 (64 hex digits)"
  say "  --server           where this computer reaches the server, if not at $SERVER"
  say "  --host-token-file  with --system: this server's own computer, with HOST_COMPUTER_TOKEN from this file"
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "curl or wget is needed to download the runner"
  fi
}

# Downloads the runner to $BUNDLE and writes $LAUNCHER (home $RUNNER_HOME, runtime $RUNTIME).
get_runner() {
  say "Downloading the runner from $SERVER ..."
  download "$SERVER/runner/agentes-runner.mjs" "$BUNDLE.download" || die "download failed"
  if [ -n "$RUNNER_SHA256" ] && [ "$(sha256 "$BUNDLE.download")" != "$RUNNER_SHA256" ]; then
    rm -f "$BUNDLE.download"
    die "the runner download didn't match --runner-sha256; it was not installed"
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
}

# Connects this computer, unless it already is or --no-pair.
connect() {
  if [ -f "$RUNNER_HOME/config.json" ] && grep -q '"token"' "$RUNNER_HOME/config.json" 2>/dev/null; then
    say "This computer is already connected (runner updated). To connect it again: $LAUNCHER pair --server $SERVER"
  elif [ "$NO_PAIR" -eq 0 ]; then
    # Prints a code and a link, and waits until someone confirms it on the site.
    set -- pair --server "$SERVER"
    if [ -n "$DIR" ]; then set -- "$@" --dir "$DIR"; fi
    if [ -n "$NAME" ]; then set -- "$@" --name "$NAME"; fi
    if [ "$NO_EXEC" -eq 1 ]; then set -- "$@" --no-exec; fi
    "$LAUNCHER" "$@" || die "connecting this computer failed"
  fi
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive
  export DEBIAN_FRONTEND
  # A fresh server may be updating itself: wait for its lock instead of failing.
  apt-get -qq -o DPkg::Lock::Timeout=600 update || true
  apt-get -qq -o DPkg::Lock::Timeout=600 install -y --no-install-recommends "$@"
}

unpack() {
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$1" -d "$2"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m zipfile -e "$1" "$2"
  elif command -v apt-get >/dev/null 2>&1; then
    apt_install unzip && unzip -q -o "$1" -d "$2"
  else
    die "unzip is needed to unpack Bun; install it and run this again"
  fi
}

# The pinned Bun in $SYSTEM_DIR/bin, checked against its SHA-256; never one from the PATH, which root would then run.
get_bun() {
  case "$(uname -m)" in
    x86_64|amd64)
      BUN_TARGET=linux-x64
      # Bun's default x64 build needs AVX2.
      grep -qw avx2 /proc/cpuinfo 2>/dev/null || BUN_TARGET=linux-x64-baseline ;;
    aarch64|arm64) BUN_TARGET=linux-aarch64 ;;
    *) die "--system runs on x86_64 or arm64 Linux, not $(uname -m)" ;;
  esac
  case "$BUN_TARGET" in
${shaCases}
  esac
  RUNTIME="$SYSTEM_DIR/bin/bun"
  if [ "$("$RUNTIME" --version 2>/dev/null || true)" = "$BUN_VERSION" ]; then return 0; fi
  say "Downloading Bun $BUN_VERSION ..."
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT
  download "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$BUN_TARGET.zip" "$WORK/bun.zip" ||
    die "downloading Bun failed"
  [ "$(sha256 "$WORK/bun.zip")" = "$BUN_SHA256" ] ||
    die "the Bun download didn't match its checksum; it was not installed"
  unpack "$WORK/bun.zip" "$WORK"
  install -m 755 "$WORK/bun-$BUN_TARGET/bun" "$RUNTIME.new"
  [ "$("$RUNTIME.new" --version 2>/dev/null || true)" = "$BUN_VERSION" ] || die "Bun $BUN_VERSION doesn't run on this computer"
  mv -f "$RUNTIME.new" "$RUNTIME"
}

install_system() {
  [ "$(id -u)" -eq 0 ] ||
    die "--system installs the runner for the whole computer: run it as root (curl -fsSL $SERVER/api/machines/install.sh | sudo sh -s -- --system)"
  [ "$(uname -s)" = Linux ] || die "--system is for Linux"
  if [ "$DESKTOP" -eq 1 ]; then
    if command -v apt-get >/dev/null 2>&1; then
      say "Installing the packages for the agents' screens ..."
      # shellcheck disable=SC2086
      apt_install $DESKTOP_PACKAGES || die "installing the packages for the agents' screens failed"
    else
      say "For the agents' screens, install these packages (Debian names) with this computer's package manager:"
      say "  $DESKTOP_PACKAGES"
    fi
  fi
  SYSTEM_DIR=${shQuote(SYSTEM_RUNNER_DIR)}
  RUNNER_HOME=${shQuote(SYSTEM_RUNNER_HOME)}
  BUNDLE="$SYSTEM_DIR/agentes-runner.mjs"
  LAUNCHER=${shQuote(SYSTEM_LAUNCHER)}
  mkdir -p "$SYSTEM_DIR/bin" "$RUNNER_HOME" "$(dirname "$LAUNCHER")"
  # Folders someone else made earlier would let them swap what root runs.
  chown 0:0 "$SYSTEM_DIR" "$SYSTEM_DIR/bin" "$RUNNER_HOME"
  chmod 755 "$SYSTEM_DIR" "$SYSTEM_DIR/bin"
  chmod 700 "$RUNNER_HOME"
  get_bun
  get_runner
  set -- service install --system --no-start
  if [ -n "$UID_RANGE" ]; then set -- "$@" --agent-uid-range "$UID_RANGE"; fi
  "$LAUNCHER" "$@" || die "installing the service failed"
  if [ -n "$HOST_TOKEN_FILE" ]; then
    # Only root reads the token.
    chmod 600 "$HOST_TOKEN_FILE"
    set -- service install --host --server "$SERVER" --token-file "$HOST_TOKEN_FILE"
    if [ "$NO_START" -eq 1 ]; then set -- "$@" --no-start; fi
    "$LAUNCHER" "$@" || die "installing this server's computer failed"
  else
    connect
    if [ "$NO_START" -eq 0 ]; then "$LAUNCHER" service install --system || die "starting the service failed"; fi
  fi
  say "The agentes-runner command is $LAUNCHER (for example: agentes-runner status)."
}

install_user() {
  RUNNER_HOME="\${AGENTES_RUNNER_HOME:-$HOME/.agentes-runner}"
  BUNDLE="$RUNNER_HOME/agentes-runner.mjs"
  LAUNCHER="$RUNNER_HOME/bin/agentes-runner"
  if [ -f "$RUNNER_HOME/config.json" ] && grep -q '"managedBy": *"desktop"' "$RUNNER_HOME/config.json" 2>/dev/null; then
    die "this computer is connected by the agentes app; manage it there (or set AGENTES_RUNNER_HOME to another folder)"
  fi

  # Node.js 22+ or Bun.
  RUNTIME=""
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v//; s/\\..*//')
    case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
    if [ "$NODE_MAJOR" -ge 22 ]; then RUNTIME=$(command -v node); fi
  fi
  if [ -z "$RUNTIME" ] && command -v bun >/dev/null 2>&1; then RUNTIME=$(command -v bun); fi
  if [ -z "$RUNTIME" ] && [ -x "$HOME/.bun/bin/bun" ]; then RUNTIME="$HOME/.bun/bin/bun"; fi
  if [ -z "$RUNTIME" ]; then
    say "The runner needs Node.js 22 or newer (or Bun). Install one, then run this again:"
    say "  macOS:  brew install node"
    say "  Linux:  https://nodejs.org/en/download (or: curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22)"
    say "  Bun:    curl -fsSL https://bun.sh/install | bash"
    exit 1
  fi

  mkdir -p "$RUNNER_HOME/bin"
  chmod 700 "$RUNNER_HOME"
  get_runner
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
      say "Couldn't install the service. Start the runner yourself:"
      say "  $LAUNCHER start"
    fi
  else
    say "Start the runner (keep it running, for example in tmux):"
    say "  $LAUNCHER start"
  fi

  say ""
  say "To use the agentes-runner command, add it to your PATH:"
  say "  export PATH=\\"$RUNNER_HOME/bin:\\$PATH\\""
}

main() {
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
  if [ "$SYSTEM" -eq 1 ]; then
    [ "$NO_SERVICE" -eq 0 ] || die "--system always installs the service; to leave it stopped, use --no-start"
    [ -z "$DIR" ] || die "--dir doesn't go with --system: each agent works in its own user's home"
    install_system
  elif [ "$DESKTOP" -eq 1 ] || [ "$NO_PAIR" -eq 1 ] || [ "$NO_START" -eq 1 ] || [ -n "$UID_RANGE" ] || [ -n "$HOST_TOKEN_FILE" ]; then
    die "--desktop, --no-pair, --no-start, --agent-uid-range and --host-token-file go with --system"
  else
    install_user
  fi
}

main "$@"
`;
}
