import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_SERVICE, hostLogFile, hostState, parseOptions } from "../../../packages/setup/src/lib";
import { HostComputer } from "../runner/host";
import { launchdPlist, SERVICE_NAME } from "../runner/service";
import { createApp } from "../src/app";

/**
 * install.sh: served at /install, and its decisions per machine, read from `--plan`. The commands it
 * asks about the machine are stubs that answer as that machine would; every command that could change
 * the machine is a stub too, and `--plan` must call none of them.
 */
const SCRIPT = join(import.meta.dir, "../../../install.sh");
const text = readFileSync(SCRIPT, "utf8");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `agentes-install-${name}-`));
  dirs.push(dir);
  return dir;
};

interface Machine {
  os: string;
  arch: string;
  uid: number;
  /** The engine's version, or "down" (the CLI is there, the engine doesn't answer); no docker command without it. */
  docker?: string;
  /** The Compose plugin's version; none without it. */
  compose?: string;
  /** A bun on the PATH, and its version. */
  bun?: string;
  sudo?: boolean;
  musl?: boolean;
}

/** What the installer asks the machine, as `command args` lines. Anything else it runs is a change. */
const PROBES =
  /^(uname -[sm]|id -u|docker info --format \{\{\.ServerVersion\}\}|docker compose version --short|bun --version)$/;

async function plan(machine: Machine, args: string[] = [], o: { piped?: string; env?: Record<string, string> } = {}) {
  const bin = tempDir("bin");
  const home = tempDir("home");
  const log = join(bin, "calls.log");
  writeFileSync(log, "");
  const stub = (name: string, body = "") =>
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n${body}\n`, { mode: 0o755 });
  stub("uname", `case "$1" in -m) echo ${machine.arch} ;; *) echo ${machine.os} ;; esac`);
  stub("id", `echo ${machine.uid}`);
  if (machine.docker) {
    const info = machine.docker === "down" ? "exit 1" : `echo ${machine.docker}`;
    // Without the plugin, docker reads --short as a flag of its own.
    const compose = machine.compose ? `echo ${machine.compose}` : `echo "unknown flag: --short" >&2; exit 125`;
    stub("docker", `case "$1" in info) ${info} ;; compose) ${compose} ;; esac`);
  }
  if (machine.bun) stub("bun", `echo ${machine.bun}`);
  if (machine.musl) stub("ldd", `echo "musl libc (x86_64)" >&2; exit 1`);
  for (const name of [
    "curl",
    "unzip",
    "python3",
    "mkdir",
    "mv",
    "chmod",
    "systemctl",
    ...(machine.sudo === false ? [] : ["sudo"]),
  ]) {
    stub(name);
  }
  symlinkSync(Bun.which("sleep") as string, join(bin, "sleep"));
  const proc = Bun.spawn(
    o.piped === undefined ? ["/bin/sh", SCRIPT, "--plan", ...args] : ["/bin/sh", "-s", "--", "--plan", ...args],
    {
      cwd: home,
      env: { PATH: bin, HOME: home, STUB_LOG: log, ...o.env },
      stdin: o.piped === undefined ? "ignore" : new Blob([o.piped]),
      stdout: "pipe",
      stderr: "pipe",
      // A session of its own, so no controlling terminal, as under cloud-init or CI.
      detached: true,
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { code, out, err, calls, bin, home, changes: calls.filter((call) => !PROBES.test(call)) };
}

const linuxRoot: Machine = { os: "Linux", arch: "x86_64", uid: 0 };
const mac: Machine = { os: "Darwin", arch: "arm64", uid: 501 };
const bunZip = (target: string) =>
  `$ curl -fsSL --proto =https --retry 3 -o <tmp>/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-${target}.zip`;
const composeDownload = (asset: string) =>
  `$ curl -fsSL --proto =https --retry 3 -o <tmp>/docker-compose https://github.com/docker/compose/releases/download/v5.5.1/${asset}`;

describe("GET /install", () => {
  const app = () => {
    const web = tempDir("web");
    writeFileSync(join(web, "index.html"), '<!doctype html><div id="root"></div>');
    return createApp({ edition: "selfhost", version: "1", modules: [], pingDatabase: async () => {}, webDir: web });
  };

  test("serves install.sh as a shell script, never cached, ahead of the web app", async () => {
    const server = app();
    for (const path of ["/install", "/install.sh"]) {
      const res = await server.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toStartWith("text/x-shellscript");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe(text);
    }
  });

  test("serves the repository's docker-compose.yml, the one the setup downloads into a folder that has none", async () => {
    const res = await app().request("/install/docker-compose.yml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("application/yaml");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(readFileSync(join(import.meta.dir, "../../../docker-compose.yml"), "utf8"));
  });
});

describe("the setup reads the agents' computer the way the runner writes it", () => {
  test("its service's name, and its log on a Mac", () => {
    expect(HOST_SERVICE).toBe(SERVICE_NAME);
    const home = "/Users/ana/.agentes-runner";
    const plist = launchdPlist({ runtime: "/usr/local/bin/bun", script: `${home}/agentes-runner.mjs`, home });
    expect(plist).toContain(`<key>StandardOutPath</key>\n  <string>${hostLogFile(home)}</string>`);
  });

  test("each state of `agentes-runner host`, from the lines it logs", async () => {
    const answers: [string, () => Promise<Response>][] = [
      ["on", async () => Response.json({ orgs: [] })],
      ["off", async () => new Response("{}", { status: 404 })],
      ["refused", async () => new Response("{}", { status: 401 })],
      [
        "unreachable",
        async () => {
          throw new Error("Unable to connect");
        },
      ],
    ];
    for (const [state, answer] of answers) {
      const lines: string[] = [];
      const computer = new HostComputer({
        server: "http://127.0.0.1:3000",
        token: () => "t".repeat(64),
        state: tempDir("host"),
        name: "box",
        system: false,
        exec: false,
        // As `agentes-runner host` writes it: a time stamp, then the line.
        log: (line) => lines.push(`${new Date().toISOString()} ${line}`),
        start: () => ({ exited: new Promise(() => {}), kill: () => {} }),
        fetch: answer,
      });
      await computer.sync();
      expect(hostState(lines.join("\n"))).toBe(state as ReturnType<typeof hostState>);
    }
    const lines: string[] = [];
    const noToken = new HostComputer({
      server: "http://127.0.0.1:3000",
      token: () => null,
      state: tempDir("host"),
      name: "box",
      system: false,
      exec: false,
      log: (line) => lines.push(`${new Date().toISOString()} ${line}`),
      start: () => ({ exited: new Promise(() => {}), kill: () => {} }),
    });
    await noToken.sync();
    expect(hostState(lines.join("\n"))).toBe("no_token");
  });
});

describe("install.sh", () => {
  test("parses as POSIX sh", () => {
    expect(Bun.spawnSync(["/bin/sh", "-n", SCRIPT]).exitCode).toBe(0);
  });

  test("a download cut short runs nothing", async () => {
    const lastLine = text.trimEnd().lastIndexOf("\n");
    for (const cut of [text.slice(0, lastLine), text.slice(0, Math.floor(text.length / 2))]) {
      const run = await plan(linuxRoot, [], { piped: cut });
      expect(run.calls).toEqual([]);
      expect(run.out).toBe("");
    }
  });

  test("hands over to the setup it ships with, on a Bun at least the repository's", () => {
    const setup = JSON.parse(readFileSync(join(import.meta.dir, "../../../packages/setup/package.json"), "utf8"));
    expect(text).toContain(`\n  SETUP_VERSION=${setup.version}\n`);
    const root = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8"));
    const repo = (root.packageManager as string).replace(/^bun@/, "").split(".").map(Number);
    const pinned = (/\n {2}BUN_VERSION=([\d.]+)\n/.exec(text)?.[1] ?? "").split(".").map(Number);
    const order = pinned.map((n, i) => n - (repo[i] ?? 0)).find((d) => d !== 0) ?? 0;
    expect(order).toBeGreaterThanOrEqual(0);
  });

  test("Linux as root without Docker: Docker's own script with --yes, then Bun and the setup", async () => {
    const run = await plan(linuxRoot, ["--yes", "--network", "local"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("· Linux on x64, as root");
    expect(run.out).toContain("· Docker isn't installed: installing it with Docker's own script (--yes)");
    expect(run.out).toContain("$ curl -fsSL --proto =https --retry 3 -o <tmp>/get-docker.sh https://get.docker.com");
    expect(run.out).toContain("$ sh <tmp>/get-docker.sh");
    expect(run.out).toContain("· Compose comes with it");
    expect(run.out).toContain(bunZip("linux-x64-baseline"));
    expect(run.out).toContain("$ mv <tmp>/bun-linux-x64-baseline/bun /opt/agentes/.runtime/bun");
    expect(run.out).toContain("$ cd /opt/agentes");
    expect(run.out).toContain(
      "$ /opt/agentes/.runtime/bun x --bun @agenteschat/setup@0.1.0 --network local </dev/null",
    );
    expect(run.changes).toEqual([]);
  });

  test("docker.io without Compose, or with an old one: the pinned plugin for every user", async () => {
    const none = await plan({ ...linuxRoot, docker: "26.1.5+dfsg1" });
    expect(none.out).toContain("· Docker 26.1.5+dfsg1");
    expect(none.out).toContain(
      "· Docker has no Compose plugin: installing Compose 5.5.1 (SHA-256 checked) in /usr/local/lib/docker/cli-plugins",
    );
    expect(none.out).toContain(composeDownload("docker-compose-linux-x86_64"));
    expect(none.out).toContain("$ mv <tmp>/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose");
    expect(none.out).not.toContain("get.docker.com");
    expect(none.changes).toEqual([]);

    const old = await plan({ ...linuxRoot, docker: "26.1.5", compose: "2.20.2" });
    expect(old.out).toContain("· Compose 2.20.2 is older than 2.23.1: installing Compose 5.5.1");

    const fine = await plan({ ...linuxRoot, docker: "26.1.5", compose: "2.26.1", bun: "1.3.1" });
    expect(fine.out).toContain("· Compose 2.26.1");
    expect(fine.out).not.toContain("docker-compose");
    // A bun older than the pinned one isn't used.
    expect(fine.out).toContain(bunZip("linux-x64-baseline"));
  });

  test("not root and no Docker: the same install again with sudo, its options kept", async () => {
    const user: Machine = { os: "Linux", arch: "x86_64", uid: 1000 };
    const file = await plan(user, ["--yes", "--dir", "/srv/agentes", "--network", "local"]);
    expect(file.code).toBe(0);
    expect(file.out).toContain("· Docker needs root here: running this installer again as root");
    expect(file.out).toContain(`$ sudo sh ${SCRIPT} --yes --dir /srv/agentes --network local`);
    expect(file.out).toContain("With --plan it stops here");
    expect(file.out).not.toContain("Bun");
    expect(file.changes).toEqual([]);

    // Under curl | sh there's no file to run again: it downloads the published one.
    const piped = await plan({ ...user, docker: "down" }, [], { piped: text });
    expect(piped.out).toContain("· Docker needs root here: downloading this installer to run it again as root");
    expect(piped.out).toContain(
      "$ curl -fsSL --proto =https --retry 3 -o <tmp>/install.sh https://agentes.chat/install",
    );
    expect(piped.out).toContain("$ sudo sh <tmp>/install.sh");
    expect(piped.changes).toEqual([]);

    const noSudo = await plan({ ...user, sudo: false });
    expect(noSudo.code).toBe(1);
    expect(noSudo.err).toContain("Docker needs root here, and this computer has no sudo.");
  });

  test("a user who can use Docker installs in their home, Compose in their own plugins", async () => {
    const run = await plan({ os: "Linux", arch: "x86_64", uid: 1000, docker: "27.3.1" });
    expect(run.code).toBe(0);
    expect(run.out).toContain(`in ${run.home}/.docker/cli-plugins`);
    expect(run.out).toContain(`$ cd ${run.home}/agentes`);
    expect(run.changes).toEqual([]);
  });

  test("a Mac with Docker running: Docker, and the bun it already has", async () => {
    const run = await plan({ ...mac, docker: "28.5.1", bun: "1.4.4" }, ["--network", "local"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("· macOS on Apple silicon");
    expect(run.out).toContain("· Docker 28.5.1");
    expect(run.out).toContain(`· Bun 1.4.4 (${run.bin}/bun)`);
    expect(run.out).toContain(`$ cd ${run.home}/agentes`);
    expect(run.out).toContain(`$ ${run.bin}/bun x --bun @agenteschat/setup@0.1.0 --network local </dev/null`);
    expect(run.out).not.toContain("--native");
    expect(run.out).not.toContain("Compose");
    expect(run.changes).toEqual([]);
  });

  test("a Mac without Docker, or with it stopped, is told what to install or start; --native isn't there yet", async () => {
    const none = await plan(mac);
    expect(none.code).toBe(1);
    expect(none.err).toContain("agentes.chat runs on Docker, and this Mac doesn't have it.");
    expect(none.err).toContain("Docker Desktop, OrbStack or Colima");
    expect(none.out).not.toContain("Bun");
    expect(none.changes).toEqual([]);

    const stopped = await plan({ ...mac, docker: "down" });
    expect(stopped.code).toBe(1);
    expect(stopped.err).toContain("Docker is on this Mac, but it doesn't answer.");

    for (const machine of [mac, linuxRoot]) {
      const native = await plan(machine, ["--native"]);
      expect(native.code).toBe(1);
      expect(native.err).toContain("(--native) isn't available yet");
      expect(native.calls).toEqual([]);
    }
  });

  test("every option it hands the setup is one the setup knows", async () => {
    const runs = [
      await plan(linuxRoot, ["--yes", "--network", "local", "--email", "skip"]),
      await plan(linuxRoot, ["--yes", "--computer", "no", "--computer-commands", "no", "--telemetry", "off"]),
      await plan({ ...linuxRoot, docker: "26.1.5", compose: "2.26.1" }, ["--json"]),
      await plan({ ...mac, docker: "28.5.1", bun: "1.4.4" }, ["--network", "local"]),
      await plan({ ...linuxRoot, docker: "26.1.5", compose: "2.26.1" }, ["--email", "skip"], { piped: text }),
    ];
    for (const run of runs) {
      const line = `${run.out}${run.err}`.split("\n").find((l) => l.includes("@agenteschat/setup@"));
      const args = line?.split("@agenteschat/setup@0.1.0")[1]?.replace("</dev/null", "").trim().split(" ");
      expect(args).toBeDefined();
      expect(parseOptions((args ?? []).filter(Boolean), {})).not.toHaveProperty("error");
    }
  });

  test("arm64 Linux gets the arm64 Bun and Compose", async () => {
    const run = await plan({ os: "Linux", arch: "aarch64", uid: 0, docker: "26.1.5" });
    expect(run.out).toContain("· Linux on arm64, as root");
    expect(run.out).toContain(composeDownload("docker-compose-linux-aarch64"));
    expect(run.out).toContain(bunZip("linux-aarch64"));
  });

  test("anything but 64-bit macOS or glibc Linux is refused, with the manual steps", async () => {
    for (const machine of [
      { os: "FreeBSD", arch: "amd64", uid: 0 },
      { os: "Linux", arch: "i686", uid: 0 },
      { os: "MINGW64_NT-10.0", arch: "x86_64", uid: 0 },
    ]) {
      const run = await plan(machine);
      expect(run.code).toBe(1);
      expect(run.err).toContain(`this is ${machine.os} on ${machine.arch}`);
      expect(run.err).toContain("SELF_HOSTING.md");
    }
    const musl = await plan({ ...linuxRoot, musl: true });
    expect(musl.code).toBe(1);
    expect(musl.err).toContain("musl");
  });

  test("no terminal: Docker only with --yes, and the setup reads nothing, not the piped script", async () => {
    const run = await plan(linuxRoot);
    expect(run.out).toContain("· No terminal: the setup takes its defaults and the options given");
    expect(run.code).toBe(1);
    expect(run.err).toContain("with no terminal to ask");
    expect(run.err).toContain("Pass --yes");

    const piped = await plan({ ...linuxRoot, docker: "26.1.5", compose: "2.26.1" }, ["--email", "skip"], {
      piped: text,
    });
    expect(piped.code).toBe(0);
    expect(piped.out).toContain("@agenteschat/setup@0.1.0 --email skip </dev/null");
  });

  test("a local build of the setup, and --json output kept off stdout", async () => {
    const build = join(tempDir("setup"), "index.js");
    writeFileSync(build, "");
    const run = await plan({ ...linuxRoot, docker: "26.1.5", compose: "2.26.1", bun: "1.4.4" }, ["--json"], {
      env: { AGENTES_INSTALL_SETUP: build },
    });
    expect(run.code).toBe(0);
    expect(run.out).toBe("");
    expect(run.err).toContain(`$ ${run.bin}/bun ${build} --json </dev/null`);
  });
});
