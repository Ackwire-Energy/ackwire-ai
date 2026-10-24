/** Quotes a value for POSIX sh (single quotes; a `'` becomes `'\''`). */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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
 * `--enroll-file FILE` connects with a code issued for this computer instead
 * (`agentes-runner pair --enroll-file`, ADR 0056 §10), connected before or not.
 */
export function installScript(publicUrl: string): string {
  const server = shQuote(publicUrl.trim().replace(/\/+$/, ""));
  return `#!/bin/sh
# agentes.chat runner installer: connects this computer to your organization.
# Usage: curl -fsSL <server>/api/machines/install.sh | sh -s -- [--dir DIR] [--no-exec] [--name NAME] [--no-service] [--enroll-file FILE]
set -eu

SERVER=${server}
RUNNER_HOME="\${AGENTES_RUNNER_HOME:-$HOME/.agentes-runner}"
BUNDLE="$RUNNER_HOME/agentes-runner.mjs"
LAUNCHER="$RUNNER_HOME/bin/agentes-runner"

DIR=""
NAME=""
NO_EXEC=0
NO_SERVICE=0
ENROLL_FILE=""

say() { printf '%s\\n' "$*"; }
die() { printf 'agentes-runner: %s\\n' "$*" >&2; exit 1; }
need_value() { [ "$2" -ge 2 ] || die "$1 needs a value"; }
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\\\\\''/g")"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) need_value "$1" $#; DIR="$2"; shift 2 ;;
    --dir=*) DIR="\${1#--dir=}"; shift ;;
    --name) need_value "$1" $#; NAME="$2"; shift 2 ;;
    --name=*) NAME="\${1#--name=}"; shift ;;
    --no-exec) NO_EXEC=1; shift ;;
    --no-service) NO_SERVICE=1; shift ;;
    --enroll-file) need_value "$1" $#; ENROLL_FILE="$2"; shift 2 ;;
    --enroll-file=*) ENROLL_FILE="\${1#--enroll-file=}"; shift ;;
    -h|--help)
      say "Usage: sh install.sh [--dir DIR] [--no-exec] [--name NAME] [--no-service] [--enroll-file FILE]"
      exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

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

say "Downloading the runner from $SERVER ..."
TMP="$BUNDLE.download"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SERVER/runner/agentes-runner.mjs" -o "$TMP" || die "download failed"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" "$SERVER/runner/agentes-runner.mjs" || die "download failed"
else
  die "curl or wget is needed to download the runner"
fi
mv "$TMP" "$BUNDLE"

{
  printf '#!/bin/sh\\n'
  printf 'AGENTES_RUNNER_HOME=%s\\n' "$(quote "$RUNNER_HOME")"
  printf 'export AGENTES_RUNNER_HOME\\n'
  printf 'exec %s %s "$@"\\n' "$(quote "$RUNTIME")" "$(quote "$BUNDLE")"
} > "$LAUNCHER"
chmod 755 "$LAUNCHER"

if [ -z "$ENROLL_FILE" ] && [ -f "$RUNNER_HOME/config.json" ] && grep -q '"token"' "$RUNNER_HOME/config.json" 2>/dev/null; then
  say "This computer is already connected (runner updated). To connect it again: $LAUNCHER pair --server $SERVER"
else
  # Prints a code and a link, and waits until someone confirms it on the site (an issued code needs nobody).
  set -- pair --server "$SERVER"
  if [ -n "$ENROLL_FILE" ]; then set -- "$@" --enroll-file "$ENROLL_FILE"; fi
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
