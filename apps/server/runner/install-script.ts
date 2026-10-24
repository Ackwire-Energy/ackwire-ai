/** Quotes a value for POSIX sh (single quotes; a `'` becomes `'\''`). */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The Bun the installer fetches when the computer has none with `Bun.Terminal` (1.3.5 or newer). */
export const RUNNER_BUN_VERSION = "1.4.4";
/** SHA-256 (hex) of each `bun-<target>.zip` of `RUNNER_BUN_VERSION`, checked before it runs. */
export const RUNNER_BUN_SHA256 = {
  "linux-x64": "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c",
  "linux-x64-baseline": "e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76",
  "linux-aarch64": "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e",
  "darwin-x64-baseline": "d4a155adfbfd09155eb3ba05c9e3a544f39297d7a68616d3c7759f67ab5c47dc",
  "darwin-aarch64": "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510",
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
 * terminals need (ADR 0056): the computer's own, else `RUNNER_BUN_VERSION`
 * fetched into `~/.agentes-runner/runtime` and checked against
 * `RUNNER_BUN_SHA256`. Only when that can't be had (another platform, no
 * unzip, no download) Node.js 22+ or an older Bun, and it says what that
 * runner lacks.
 */
export function installScript(publicUrl: string): string {
  const server = shQuote(publicUrl.trim().replace(/\/+$/, ""));
  const shaCases = Object.entries(RUNNER_BUN_SHA256)
    .map(([target, sha]) => `    ${target}) BUN_SHA256=${shQuote(sha)} ;;`)
    .join("\n");
  return `#!/bin/sh
# agentes.chat runner installer: connects this computer to your organization.
# Usage: curl -fsSL <server>/api/machines/install.sh | sh -s -- [--dir DIR] [--no-exec] [--name NAME] [--no-service]
set -eu

SERVER=${server}
BUN_VERSION=${shQuote(RUNNER_BUN_VERSION)}
RUNNER_HOME="\${AGENTES_RUNNER_HOME:-$HOME/.agentes-runner}"
BUNDLE="$RUNNER_HOME/agentes-runner.mjs"
LAUNCHER="$RUNNER_HOME/bin/agentes-runner"
PINNED_BUN="$RUNNER_HOME/runtime/bun"

DIR=""
NAME=""
NO_EXEC=0
NO_SERVICE=0

say() { printf '%s\\n' "$*"; }
die() { printf 'agentes-runner: %s\\n' "$*" >&2; exit 1; }
need_value() { [ "$2" -ge 2 ] || die "$1 needs a value"; }
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\\\\\''/g")"; }
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d ' ' -f 1
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

unpack() {
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$1" -d "$2"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m zipfile -e "$1" "$2"
  else
    return 1
  fi
}

# A Bun with Bun.Terminal (1.3.5 or newer): the agents' screens and the terminal need it.
has_terminal() { [ -x "$1" ] && "$1" -e 'process.exit("Terminal" in Bun ? 0 : 1)' >/dev/null 2>&1; }

# The pinned Bun at $1, kept when it is there at that version, checked against its SHA-256 before it
# runs. Fails, saying why, where there's no pinned build or it can't be fetched or run here.
fetch_bun() {
  if [ "$("$1" --version 2>/dev/null || true)" = "$BUN_VERSION" ]; then return 0; fi
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64|Linux-amd64)
      BUN_TARGET=linux-x64
      # Bun's default x64 build needs AVX2.
      grep -qw avx2 /proc/cpuinfo 2>/dev/null || BUN_TARGET=linux-x64-baseline ;;
    Linux-aarch64|Linux-arm64) BUN_TARGET=linux-aarch64 ;;
    Darwin-x86_64) BUN_TARGET=darwin-x64-baseline ;;
    Darwin-arm64) BUN_TARGET=darwin-aarch64 ;;
    *) return 1 ;;
  esac
  case "$BUN_TARGET" in
${shaCases}
  esac
  say "Downloading Bun $BUN_VERSION to run the runner on ..."
  WORK=$(mktemp -d)
  WHY=""
  if ! download "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$BUN_TARGET.zip" "$WORK/bun.zip"; then
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
  if [ -n "$WHY" ]; then say "No Bun $BUN_VERSION: $WHY."; return 1; fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) need_value "$1" $#; DIR="$2"; shift 2 ;;
    --dir=*) DIR="\${1#--dir=}"; shift ;;
    --name) need_value "$1" $#; NAME="$2"; shift 2 ;;
    --name=*) NAME="\${1#--name=}"; shift ;;
    --no-exec) NO_EXEC=1; shift ;;
    --no-service) NO_SERVICE=1; shift ;;
    -h|--help)
      say "Usage: sh install.sh [--dir DIR] [--no-exec] [--name NAME] [--no-service]"
      exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

if [ -f "$RUNNER_HOME/config.json" ] && grep -q '"managedBy": *"desktop"' "$RUNNER_HOME/config.json" 2>/dev/null; then
  die "this computer is connected by the agentes app; manage it there (or set AGENTES_RUNNER_HOME to another folder)"
fi

mkdir -p "$RUNNER_HOME/bin" "$RUNNER_HOME/runtime"
chmod 700 "$RUNNER_HOME"

# This computer's Bun when it has Bun.Terminal, else the pinned one; Node.js 22+ (or an older Bun)
# only when there is neither, since a runner there gets no screens and no terminal.
RUNTIME=""
for CANDIDATE in "$(command -v bun 2>/dev/null || true)" "$HOME/.bun/bin/bun"; do
  if [ -n "$CANDIDATE" ] && has_terminal "$CANDIDATE"; then RUNTIME=$CANDIDATE; break; fi
done
if [ -z "$RUNTIME" ] && fetch_bun "$PINNED_BUN"; then RUNTIME=$PINNED_BUN; fi
if [ -z "$RUNTIME" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v//; s/\\..*//')
    case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
    if [ "$NODE_MAJOR" -ge 22 ]; then RUNTIME=$(command -v node); fi
  fi
  if [ -z "$RUNTIME" ] && command -v bun >/dev/null 2>&1; then RUNTIME=$(command -v bun); fi
  if [ -z "$RUNTIME" ] && [ -x "$HOME/.bun/bin/bun" ]; then RUNTIME="$HOME/.bun/bin/bun"; fi
  if [ -n "$RUNTIME" ]; then
    say "The runner runs on $RUNTIME, so agents get no screens and no terminal on this computer: those need Bun 1.3.5 or newer."
  fi
fi
if [ -z "$RUNTIME" ]; then
  say "The runner needs Bun 1.3.5 or newer, or Node.js 22 or newer. Install one, then run this again:"
  say "  Bun:    curl -fsSL https://bun.sh/install | bash"
  say "  macOS:  brew install node"
  say "  Linux:  https://nodejs.org/en/download (or: curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22)"
  exit 1
fi

say "Downloading the runner from $SERVER ..."
download "$SERVER/runner/agentes-runner.mjs" "$BUNDLE.download" || die "download failed"
mv "$BUNDLE.download" "$BUNDLE"

{
  printf '#!/bin/sh\\n'
  printf 'AGENTES_RUNNER_HOME=%s\\n' "$(quote "$RUNNER_HOME")"
  printf 'export AGENTES_RUNNER_HOME\\n'
  printf 'exec %s %s "$@"\\n' "$(quote "$RUNTIME")" "$(quote "$BUNDLE")"
} > "$LAUNCHER"
chmod 755 "$LAUNCHER"

if [ -f "$RUNNER_HOME/config.json" ] && grep -q '"token"' "$RUNNER_HOME/config.json" 2>/dev/null; then
  say "This computer is already connected (runner updated). To connect it again: $LAUNCHER pair --server $SERVER"
else
  # Prints a code and a link, and waits until someone confirms it on the site.
  set -- pair --server "$SERVER"
  if [ -n "$DIR" ]; then set -- "$@" --dir "$DIR"; fi
  if [ -n "$NAME" ]; then set -- "$@" --name "$NAME"; fi
  if [ "$NO_EXEC" -eq 1 ]; then set -- "$@" --no-exec; fi
  "$LAUNCHER" "$@" || die "connecting this computer failed"
fi

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
`;
}
