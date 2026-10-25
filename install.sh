#!/bin/sh
# agentes.chat installer: a self-hosted agentes.chat on this computer, in one command.
#
#   curl -fsSL https://agentes.chat/install | sh
#   curl -fsSL https://agentes.chat/install | sh -s -- --plan      prints what it would do, does nothing
#
# To read it before it runs: curl -fsSLo install.sh https://agentes.chat/install, then sh install.sh.
#
# It gets this computer ready, then hands over to the setup (@agenteschat/setup), which asks its few
# questions, writes .env and starts everything. On Linux it makes sure of Docker and its Compose
# plugin. On a Mac it needs Docker running (Docker Desktop, OrbStack or Colima). On both it fetches
# a pinned Bun to run the setup with. Downloads are HTTPS only, and the pinned ones are checked
# against the SHA-256 below before anything runs them.
#
# Everything is inside main, which the last line calls, so a download cut short runs nothing.

main() {
  set -eu

  # The setup this installer hands over to, the Bun it runs on, and the Compose plugin it installs
  # when Docker has none (or one older than the 2.23.1 the compose file needs).
  SETUP_VERSION=0.1.0
  BUN_VERSION=1.4.4
  COMPOSE_VERSION=5.5.1
  MIN_COMPOSE=2.23.1
  INSTALL_URL=https://agentes.chat/install
  GUIDE=https://github.com/agentes-chat/agentes-chat/blob/main/SELF_HOSTING.md
  DOCKER_DOCS=https://docs.docker.com/engine/install/

  PLAN=0 YES=0 DIR='' DIR_FLAG='' OUT=1
  n=$#
  while [ "$n" -gt 0 ]; do
    arg=$1
    shift
    n=$((n - 1))
    case $arg in
      --plan | --dry-run) PLAN=1 ;;
      --yes | -y) YES=1 ;;
      --native)
        die "This installer can't run agentes.chat without Docker yet (--native)." \
          "On a Mac, the agentes.chat app runs it with no Docker (Use your own server, then Run agentes.chat on this Mac). Or use Docker: on a Mac, Docker Desktop, OrbStack or Colima; on Linux, this installer sets it up."
        ;;
      --dir)
        [ "$n" -gt 0 ] || die "--dir needs a folder, like --dir /srv/agentes."
        DIR=$1 DIR_FLAG=$1
        shift
        n=$((n - 1))
        ;;
      --dir=*) DIR=${arg#--dir=} DIR_FLAG=${arg#--dir=} ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        # The setup's own options, passed on in order. With --json its stdout is for the result
        # alone, so this installer talks on stderr.
        if [ "$arg" = --json ]; then OUT=2; fi
        set -- "$@" "$arg"
        ;;
    esac
  done

  OS=$(uname -s)
  ARCH=$(uname -m)
  COMPOSE_ASSET='' COMPOSE_SHA256=''
  case "$OS-$ARCH" in
    Linux-x86_64 | Linux-amd64)
      PLATFORM="Linux on x64"
      # Baseline: server CPUs may lack AVX2.
      BUN_TARGET=linux-x64-baseline
      BUN_SHA256=e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76
      COMPOSE_ASSET=docker-compose-linux-x86_64
      COMPOSE_SHA256=db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576
      ;;
    Linux-aarch64 | Linux-arm64)
      PLATFORM="Linux on arm64"
      BUN_TARGET=linux-aarch64
      BUN_SHA256=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
      COMPOSE_ASSET=docker-compose-linux-aarch64
      COMPOSE_SHA256=732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7
      ;;
    Darwin-x86_64)
      PLATFORM="macOS on Intel"
      BUN_TARGET=darwin-x64-baseline
      BUN_SHA256=d4a155adfbfd09155eb3ba05c9e3a544f39297d7a68616d3c7759f67ab5c47dc
      ;;
    Darwin-arm64)
      PLATFORM="macOS on Apple silicon"
      BUN_TARGET=darwin-aarch64
      BUN_SHA256=c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510
      ;;
    *)
      die "agentes.chat installs on macOS or Linux, on x64 or arm64, and this is $OS on $ARCH." \
        "On Windows, run it in WSL 2. Elsewhere, the manual steps: $GUIDE"
      ;;
  esac
  if [ "$OS" = Linux ]; then
    case "$(ldd --version 2>&1 || :)" in
      *musl*)
        die "This Linux uses musl (Alpine, say), which the installer doesn't support." \
          "The manual steps work there: $GUIDE"
        ;;
    esac
  fi

  IS_ROOT=0
  if [ "$(id -u)" = 0 ]; then
    IS_ROOT=1
    # cloud-init can run scripts without HOME, and Bun keeps its downloads under it.
    if [ -z "${HOME:-}" ]; then
      HOME=/root
      export HOME
    fi
  fi

  # [ -r /dev/tty ] is true with no terminal at all (cloud-init, CI), where opening it fails, so
  # opening it is the test. Under curl | sh, stdin is the rest of this script: the setup reads the
  # terminal, or nothing (its defaults and the options given).
  TTY=/dev/null
  if (exec </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi

  if [ "$PLAN" = 1 ]; then
    say "agentes.chat install plan (--plan: nothing runs)"
    WORK='<tmp>'
  else
    say "agentes.chat install"
    WORK=$(mktemp -d "${TMPDIR:-/tmp}/agentes-install.XXXXXX")
    trap 'rm -rf "$WORK"' EXIT
  fi
  if [ "$IS_ROOT" = 1 ]; then step "$PLATFORM, as root"; else step "$PLATFORM"; fi
  if [ "$TTY" = /dev/tty ]; then
    step "A terminal: the setup asks its questions there"
  else
    step "No terminal: the setup takes its defaults and the options given"
  fi

  DOCKER_VERSION=''
  if [ "$OS" = Linux ]; then
    linux_docker "$@"
  elif DOCKER_VERSION=$(docker_version); then
    step "Docker $DOCKER_VERSION"
  elif command -v docker >/dev/null 2>&1; then
    die "Docker is on this Mac, but it doesn't answer." "Start it (Docker Desktop, OrbStack or Colima) and run this again."
  else
    die "This installer runs agentes.chat on Docker, and this Mac doesn't have it." \
      "Install Docker Desktop, OrbStack or Colima, start it, and run this again. Or, with no Docker, open the agentes.chat app: Use your own server, then Run agentes.chat on this Mac."
  fi

  if [ -z "$DIR" ]; then
    if [ "$IS_ROOT" = 1 ]; then DIR=/opt/agentes; else DIR=$HOME/agentes; fi
  fi
  case $DIR in /*) ;; *) DIR=$PWD/$DIR ;; esac

  SETUP="@agenteschat/setup@$SETUP_VERSION"
  if [ -n "${AGENTES_INSTALL_SETUP:-}" ]; then
    case $AGENTES_INSTALL_SETUP in /*) ;; *) AGENTES_INSTALL_SETUP=$PWD/$AGENTES_INSTALL_SETUP ;; esac
    [ -f "$AGENTES_INSTALL_SETUP" ] ||
      die "AGENTES_INSTALL_SETUP is $AGENTES_INSTALL_SETUP, which isn't a file." \
        "Point it at a build of the setup (packages/setup/dist/index.js), or unset it."
    SETUP=$AGENTES_INSTALL_SETUP
  fi

  get_bun

  if [ -n "${AGENTES_INSTALL_SETUP:-}" ]; then
    set -- "$BUN" "$SETUP" "$@"
  else
    set -- "$BUN" x --bun "$SETUP" "$@"
  fi
  step "The setup, in $DIR:"
  run mkdir -p "$DIR"
  say "  \$ cd $DIR"
  say "  \$ $* <$TTY"
  if [ "$PLAN" = 1 ]; then return 0; fi
  rm -rf "$WORK"
  trap - EXIT
  cd "$DIR"
  exec "$@" <"$TTY"
}

usage() {
  say "agentes.chat installer: a self-hosted agentes.chat on this computer, in one command.

Usage: curl -fsSL https://agentes.chat/install | sh -s -- [options] [setup options]
       sh install.sh [options] [setup options]

  --dir <folder>      Where agentes.chat lives: /opt/agentes as root, ~/agentes otherwise.
  --yes               On Linux, install Docker without asking first. A Mac needs Docker Desktop,
                      OrbStack or Colima running.
  --plan              Print what it would do, and do nothing (--dry-run too).
  -h, --help

Every other option goes to the setup, like --network local or --email skip; the guide lists them:
$GUIDE

AGENTES_INSTALL_SETUP=<file> runs that build of the setup instead of the published one."
}

say() { printf '%s\n' "$*" >&"$OUT"; }

step() { say "· $*"; }

die() {
  printf '✗ %s\n' "$1" >&2
  if [ $# -gt 1 ]; then printf '  %s\n' "$2" >&2; fi
  exit 1
}

# Shows a command, then runs it; with --plan it only shows it. Its output goes to stderr, so the
# setup's --json result stays alone on stdout.
run() {
  say "  \$ $*"
  if [ "$PLAN" = 0 ]; then "$@" >&2; fi
}

fetch() {
  run curl -fsSL --proto =https --retry 3 -o "$2" "$1" ||
    die "Couldn't download $1." "Check this computer's internet connection, then run this again."
}

verify() {
  if [ "$PLAN" = 1 ]; then return 0; fi
  if command -v sha256sum >/dev/null 2>&1; then
    sum=$(sha256sum "$1")
  else
    sum=$(shasum -a 256 "$1")
  fi
  if [ "${sum%% *}" != "$2" ]; then
    rm -f "$1"
    die "The download of ${1##*/} isn't the file this installer expects (its SHA-256 differs), so it was deleted, not run." \
      "Run this again. If it happens again, open an issue: https://github.com/agentes-chat/agentes-chat/issues"
  fi
}

# A yes/no question on the terminal; Enter is yes.
ask() {
  printf '%s [Y/n] ' "$1" >/dev/tty
  read -r answer </dev/tty || answer=n
  case $answer in "" | [Yy]*) return 0 ;; *) return 1 ;; esac
}

# Whether version $1 is $2 or newer, number by number ("v" and anything after "-" or "+" ignored).
version_at_least() {
  va=${1#v} vb=${2#v}
  va=${va%%[-+]*} vb=${vb%%[-+]*}
  while [ -n "$va$vb" ]; do
    xa=${va%%.*} xb=${vb%%.*}
    case $xa in '' | *[!0-9]*) xa=0 ;; esac
    case $xb in '' | *[!0-9]*) xb=0 ;; esac
    if [ "$xa" -ne "$xb" ]; then
      [ "$xa" -gt "$xb" ]
      return
    fi
    case $va in *.*) va=${va#*.} ;; *) va='' ;; esac
    case $vb in *.*) vb=${vb#*.} ;; *) vb='' ;; esac
  done
}

# The Docker engine's version, when it answers within 5 seconds: a Docker Desktop that is still
# starting can hang without ever answering.
docker_version() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info --format '{{.ServerVersion}}' </dev/null 2>/dev/null &
  probe=$!
  (sleep 5 && kill "$probe") </dev/null >/dev/null 2>&1 &
  watchdog=$!
  status=0
  wait "$probe" || status=$?
  kill "$watchdog" 2>/dev/null || :
  return "$status"
}

linux_docker() {
  if command -v docker >/dev/null 2>&1; then
    DOCKER_VERSION=$(docker_version) || DOCKER_VERSION=''
    if [ -z "$DOCKER_VERSION" ] && [ "$IS_ROOT" = 1 ]; then
      die "Docker is installed, but its engine doesn't answer." "Start it (systemctl start docker) and run this again."
    fi
  fi
  if [ -z "$DOCKER_VERSION" ] && [ "$IS_ROOT" = 0 ]; then as_root "$@"; fi
  if [ -n "$DOCKER_VERSION" ]; then
    step "Docker $DOCKER_VERSION"
    compose_plugin
    return 0
  fi

  if [ "$YES" = 1 ]; then
    step "Docker isn't installed: installing it with Docker's own script (--yes)"
  elif [ "$TTY" = /dev/null ]; then
    die "Docker isn't installed, and with no terminal to ask, this installer won't install it on its own." \
      "Pass --yes to install it with Docker's script (get.docker.com), or install Docker yourself: $DOCKER_DOCS"
  elif [ "$PLAN" = 1 ]; then
    step "Docker isn't installed: installing it with Docker's own script, once you say yes (--yes doesn't ask)"
  else
    ask "Docker isn't installed. Install it now with Docker's own script (get.docker.com)?" ||
      die "agentes.chat runs on Docker here." "Install Docker yourself ($DOCKER_DOCS) and run this again."
    step "Installing Docker with Docker's own script"
  fi
  fetch https://get.docker.com "$WORK/get-docker.sh"
  run sh "$WORK/get-docker.sh" ||
    die "Docker's install script failed (above)." "Install Docker by hand ($DOCKER_DOCS), then run this again."
  if [ "$PLAN" = 1 ]; then
    step "Compose comes with it"
    return 0
  fi
  DOCKER_VERSION=$(docker_version) ||
    die "Docker is installed, but its engine doesn't answer." "Start it (systemctl start docker) and run this again."
  step "Docker $DOCKER_VERSION"
  compose_plugin
}

# Docker's install script includes Compose, but distribution packages often don't (Debian 13's
# docker.io), or ship one older than the compose file needs.
compose_plugin() {
  have=$(compose_version)
  if [ -n "$have" ] && version_at_least "$have" "$MIN_COMPOSE"; then
    step "Compose $have"
    return 0
  fi
  if [ "$IS_ROOT" = 1 ]; then
    plugins=/usr/local/lib/docker/cli-plugins
  else
    plugins=${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins
  fi
  if [ -n "$have" ]; then
    step "Compose $have is older than $MIN_COMPOSE: installing Compose $COMPOSE_VERSION (SHA-256 checked) in $plugins"
  else
    step "Docker has no Compose plugin: installing Compose $COMPOSE_VERSION (SHA-256 checked) in $plugins"
  fi
  fetch "https://github.com/docker/compose/releases/download/v$COMPOSE_VERSION/$COMPOSE_ASSET" "$WORK/docker-compose"
  verify "$WORK/docker-compose" "$COMPOSE_SHA256"
  run chmod 755 "$WORK/docker-compose"
  run mkdir -p "$plugins"
  run mv "$WORK/docker-compose" "$plugins/docker-compose"
  if [ "$PLAN" = 0 ] && ! version_at_least "$(compose_version)" "$MIN_COMPOSE"; then
    die "Compose doesn't answer after installing it in $plugins." "See what docker compose version says, then run this again."
  fi
}

compose_version() {
  version=$(docker compose version --short </dev/null 2>/dev/null || :)
  version=${version#v}
  # Without the plugin, docker answers with its own usage.
  case $version in [0-9]*.[0-9]*) printf '%s' "$version" ;; esac
}

# Installing Docker needs root: the same install again, as root. Under curl | sh, $0 is the shell
# and there is no file to run again, so it downloads the published installer.
as_root() {
  command -v sudo >/dev/null 2>&1 ||
    die "Docker needs root here, and this computer has no sudo." \
      "Run this as root, or install Docker yourself ($DOCKER_DOCS) and add your user to the docker group."
  script=$0
  if is_installer "$script"; then
    step "Docker needs root here: running this installer again as root"
  else
    script=$WORK/install.sh
    step "Docker needs root here: downloading this installer to run it again as root"
    fetch "$INSTALL_URL" "$script"
  fi
  if [ -n "$DIR_FLAG" ]; then set -- --dir "$DIR_FLAG" "$@"; fi
  if [ "$YES" = 1 ]; then set -- --yes "$@"; fi
  say "  \$ sudo sh $script $*"
  if [ "$PLAN" = 1 ]; then
    say "With --plan it stops here; as root, --plan shows the rest."
    exit 0
  fi
  if [ "$script" = "$0" ]; then rm -rf "$WORK"; fi
  exec sudo sh "$script" "$@"
}

# Whether $1 is this file (sh install.sh) rather than the shell reading it from a pipe.
is_installer() {
  [ -f "$1" ] || return 1
  { IFS= read -r _ && IFS= read -r second; } <"$1" || return 1
  [ "$second" = "# agentes.chat installer: a self-hosted agentes.chat on this computer, in one command." ]
}

get_bun() {
  if command -v bun >/dev/null 2>&1; then
    have=$(bun --version </dev/null 2>/dev/null || :)
    if version_at_least "$have" "$BUN_VERSION"; then
      BUN=$(command -v bun)
      step "Bun $have ($BUN)"
      return 0
    fi
  fi
  BUN=$DIR/.runtime/bun
  if [ -x "$BUN" ] && [ "$("$BUN" --version </dev/null 2>/dev/null || :)" = "$BUN_VERSION" ]; then
    step "Bun $BUN_VERSION ($BUN)"
    return 0
  fi
  step "Bun $BUN_VERSION, to run the setup: downloading it (SHA-256 checked) into $DIR/.runtime"
  fetch "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$BUN_TARGET.zip" "$WORK/bun.zip"
  verify "$WORK/bun.zip" "$BUN_SHA256"
  if [ "$PLAN" = 1 ] || command -v unzip >/dev/null 2>&1; then
    run unzip -q -o "$WORK/bun.zip" -d "$WORK"
  elif command -v python3 >/dev/null 2>&1; then
    run python3 -m zipfile -e "$WORK/bun.zip" "$WORK"
  else
    die "Unpacking Bun needs unzip or python3, and this computer has neither." \
      "Install unzip (apt-get install unzip, say) and run this again."
  fi
  run chmod 755 "$WORK/bun-$BUN_TARGET/bun"
  run mkdir -p "$DIR/.runtime"
  run mv "$WORK/bun-$BUN_TARGET/bun" "$BUN"
  if [ "$PLAN" = 0 ] && [ "$("$BUN" --version </dev/null 2>/dev/null || :)" != "$BUN_VERSION" ]; then
    die "Bun $BUN_VERSION doesn't start on this computer." "The manual steps don't need it: $GUIDE"
  fi
}

main "$@"
