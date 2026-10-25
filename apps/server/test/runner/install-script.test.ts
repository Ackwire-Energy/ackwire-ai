import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installScript, RUNNER_BUN_SHA256, RUNNER_BUN_VERSION, shQuote } from "../../runner/install-script";
import { launchdPlist, systemdUnit, windowsTaskCommand } from "../../runner/service";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

/** The bytes the fake GitHub serves as the Bun zip; a test that wants it to match swaps its SHA-256 in. */
const FAKE_ZIP = "not really a zip";

/** A fake `bun`: its version, whether it has Bun.Terminal (`-e`), and anything else it runs goes to $LOG. */
const fakeBun = (version: string, terminal: boolean) =>
  `#!/bin/sh\ncase "$1" in --version) echo ${version} ;; -e) exit ${terminal ? 0 : 1} ;; *) echo "$0 $*" >> "$LOG" ;; esac\n`;
const fakeNode = (version: string) =>
  `#!/bin/sh\ncase "$1" in -v) echo v${version} ;; *) echo "$0 $*" >> "$LOG" ;; esac\n`;

/**
 * A computer for the install script: Linux (or a Mac) on arm64, a curl that serves the runner and
 * `FAKE_ZIP`, an unzip that "unpacks" a Bun 1.4.4, the runtimes given, and the real tools the script uses.
 */
function fakeComputer(runtimes: { bun?: string; homeBun?: string; node?: string }, system = "Linux") {
  const root = tempDir("install-script-");
  dirs.push(root);
  const [fake, sys, home] = ["fake", "sys", "home"].map((d) => path.join(root, d)) as [string, string, string];
  for (const d of [fake, sys, home]) mkdirSync(d);
  const tools: Record<string, string | undefined> = {
    uname: `#!/bin/sh\ncase "$1" in -m) echo ${system === "Darwin" ? "arm64" : "aarch64"} ;; *) echo ${system} ;; esac\n`,
    curl: `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
echo "curl $url" >> "$LOG"
case "$url" in *oven-sh*) printf '%s' '${FAKE_ZIP}' > "$out" ;; *) printf '#!/usr/bin/env node\\n' > "$out" ;; esac
`,
    unzip: `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -d) dir=$2; shift 2 ;; *) shift ;; esac; done
mkdir -p "$dir/bun-linux-aarch64" && cp "$FAKE_BUN" "$dir/bun-linux-aarch64/bun"
`,
    bun: runtimes.bun,
    node: runtimes.node,
  };
  for (const [name, text] of Object.entries(tools))
    if (text) writeFileSync(path.join(fake, name), text, { mode: 0o755 });
  if (runtimes.homeBun) {
    mkdirSync(path.join(home, ".bun/bin"), { recursive: true });
    writeFileSync(path.join(home, ".bun/bin/bun"), runtimes.homeBun, { mode: 0o755 });
  }
  const fetched = path.join(root, "fetched-bun");
  writeFileSync(fetched, fakeBun(RUNNER_BUN_VERSION, true), { mode: 0o755 });
  for (const tool of ["sed", "grep", "mkdir", "chmod", "mv", "cp", "rm", "mktemp", "cut", "sha256sum", "shasum"]) {
    const real = Bun.which(tool);
    if (real) symlinkSync(real, path.join(sys, tool));
  }
  const log = path.join(root, "log");
  return {
    home,
    fake,
    pinned: path.join(home, ".agentes-runner/runtime/bun"),
    install(script: string, args: string[] = []) {
      const r = spawnSync("/bin/sh", ["-s", "--", ...args], {
        input: script,
        encoding: "utf8",
        env: { PATH: `${fake}:${sys}`, HOME: home, LOG: log, FAKE_BUN: fetched },
      });
      const launcher = path.join(home, ".agentes-runner/bin/agentes-runner");
      return {
        status: r.status,
        out: `${r.stdout}${r.stderr}`,
        runtime: existsSync(launcher) ? /^exec '([^']+)'/m.exec(readFileSync(launcher, "utf8"))?.[1] : undefined,
        log: existsSync(log) ? readFileSync(log, "utf8") : "",
      };
    },
  };
}

test("shQuote survives single quotes", () => {
  expect(shQuote("plain")).toBe("'plain'");
  expect(shQuote("it's")).toBe("'it'\\''s'");
});

test("the install script quotes the server URL and is valid sh", () => {
  const script = installScript("https://agentes.chat/");
  expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  expect(script).toContain("set -eu");
  expect(script).toContain("SERVER='https://agentes.chat'\n");
  expect(script).toContain('"$SERVER/runner/agentes-runner.mjs"');
  expect(script).toContain("service install");
  // Device-code connection (ADR 0036 §5): no code from the site; `pair` shows one and waits for the confirmation.
  expect(script).not.toContain("--code");
  expect(script).not.toContain("CODE=");
  expect(script).toContain('set -- pair --server "$SERVER"');
  // A home already connected keeps its connection; one managed by the desktop app is left alone.
  expect(script).toContain("grep -q '\"token\"'");
  expect(script).toContain("managedBy");
  expect(installScript("https://x.test/it's")).toContain("SERVER='https://x.test/it'\\''s'\n");
  if (process.platform !== "win32") {
    const check = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  }
});

test.skipIf(process.platform === "win32")(
  "runtime order: the computer's Bun with Bun.Terminal, else the pinned Bun checked by SHA-256, else Node with the note",
  () => {
    const script = installScript("https://x.test");
    const matching = script.replace(
      RUNNER_BUN_SHA256["linux-aarch64"],
      createHash("sha256").update(FAKE_ZIP).digest("hex"),
    );
    const bunZip = `curl https://github.com/oven-sh/bun/releases/download/bun-v${RUNNER_BUN_VERSION}/bun-linux-aarch64.zip`;
    const noScreens = "agents get no screens and no terminal on this computer";

    // Node comes after any Bun with Bun.Terminal, on the PATH or in ~/.bun.
    let pc = fakeComputer({ bun: fakeBun("1.3.8", true), node: fakeNode("22.12.0") });
    let r = pc.install(matching);
    expect(r.status).toBe(0);
    expect(r.runtime).toBe(path.join(pc.fake, "bun"));
    expect(r.log).not.toContain("oven-sh");
    expect(r.log).toContain(
      `${path.join(pc.fake, "bun")} ${pc.home}/.agentes-runner/agentes-runner.mjs pair --server https://x.test`,
    );
    pc = fakeComputer({ bun: fakeBun("1.3.1", false), homeBun: fakeBun("1.3.5", true), node: fakeNode("22.12.0") });
    expect(pc.install(matching).runtime).toBe(path.join(pc.home, ".bun/bin/bun"));

    // An older Bun and Node: the pinned Bun, fetched once, then kept.
    pc = fakeComputer({ bun: fakeBun("1.3.1", false), node: fakeNode("22.12.0") });
    r = pc.install(matching);
    expect(r.status).toBe(0);
    expect(r.runtime).toBe(pc.pinned);
    expect(r.log).toContain(bunZip);
    expect(r.out).not.toContain(noScreens);
    r = pc.install(matching);
    expect(r.runtime).toBe(pc.pinned);
    expect(r.log.split(bunZip).length).toBe(2);

    // A download that isn't the pinned zip never runs: Node, and the note on what that runner lacks.
    pc = fakeComputer({ node: fakeNode("22.12.0") });
    r = pc.install(script);
    expect(r.status).toBe(0);
    expect(r.out).toContain(
      `No Bun ${RUNNER_BUN_VERSION}: the download didn't match its checksum, so it was not installed.`,
    );
    expect(r.runtime).toBe(path.join(pc.fake, "node"));
    expect(r.out).toContain(`The runner runs on ${path.join(pc.fake, "node")}, so ${noScreens}`);
    expect(existsSync(pc.pinned)).toBe(false);

    // Nothing to run on.
    r = fakeComputer({ node: fakeNode("20.18.0") }).install(script);
    expect(r.status).toBe(1);
    expect(r.out).toContain("The runner needs Bun 1.3.5 or newer, or Node.js 22 or newer.");
    expect(r.runtime).toBeUndefined();
  },
  // Six whole installs, each a shell running real tools: seconds on a busy computer.
  30_000,
);

test("every Bun build the installer picks has its SHA-256", () => {
  const picked = new Set([...installScript("https://x.test").matchAll(/BUN_TARGET=([\w-]+)/g)].map((m) => m[1]));
  expect([...picked].sort()).toEqual(Object.keys(RUNNER_BUN_SHA256).sort());
  for (const sha of Object.values(RUNNER_BUN_SHA256)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
});

test.skipIf(process.platform === "win32")("--enroll-file reaches pair, also in a home already connected", () => {
  const dir = tempDir("install-");
  dirs.push(dir);
  const site = path.join(dir, "site");
  const calls = path.join(dir, "calls");
  mkdirSync(path.join(site, "runner"), { recursive: true });
  // Stands in for the runner: notes the arguments of each run.
  writeFileSync(
    path.join(site, "runner", "agentes-runner.mjs"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\n`,
  );
  const home = path.join(dir, "home");
  mkdirSync(home);
  writeFileSync(path.join(home, "config.json"), '{ "token": "agm_x" }\n');
  const install = (...args: string[]) =>
    spawnSync("sh", ["-s", "--", ...args, "--no-service"], {
      input: installScript(`file://${site}`),
      // The test's own Bun first: it has Bun.Terminal, so the installer fetches none.
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, AGENTES_RUNNER_HOME: home },
      encoding: "utf8",
    });

  expect(install().status).toBe(0);
  expect(existsSync(calls)).toBe(false);
  const run = install("--enroll-file", "/run/agentes/enroll-code", "--dir", "/srv/work");
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(readFileSync(calls, "utf8")).toBe(
    `pair --server file://${site} --enroll-file /run/agentes/enroll-code --dir /srv/work\n`,
  );
});

test.skipIf(process.platform === "win32")(
  "this server's computer: alone on a Mac, as the person and never paired; on Linux only with --system",
  () => {
    const mac = fakeComputer({ bun: fakeBun(RUNNER_BUN_VERSION, true) }, "Darwin");
    const token = path.join(mac.home, "host-computer-token");
    writeFileSync(token, "t".repeat(64), { mode: 0o644 });
    const args = ["--server", "http://127.0.0.1:3000", "--host-token-file", token, "--no-exec"];
    const run = mac.install(installScript("https://agentes.test"), args);
    expect(run.status).toBe(0);
    expect(run.log).toContain("curl http://127.0.0.1:3000/runner/agentes-runner.mjs");
    expect(run.log).toContain(`service install --host --server http://127.0.0.1:3000 --token-file ${token} --no-exec`);
    expect(run.log).not.toContain(" pair ");
    expect(statSync(token).mode & 0o777).toBe(0o600);
    // The service is how it keeps up with the server, so there's no leaving it out.
    const noService = mac.install(installScript("https://agentes.test"), [...args, "--no-service"]);
    expect(noService.status).toBe(1);
    expect(noService.out).toContain("--host-token-file installs the service");

    // Connected as one of the person's computers: its launchd agent stays theirs.
    const paired = fakeComputer({ bun: fakeBun(RUNNER_BUN_VERSION, true) }, "Darwin");
    mkdirSync(path.join(paired.home, ".agentes-runner"), { recursive: true });
    writeFileSync(path.join(paired.home, ".agentes-runner/config.json"), '{ "token": "agm_x" }\n');
    const refused = paired.install(installScript("https://agentes.test"), ["--host-token-file", token]);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain("already connected to agentes.chat as a computer");
    expect(refused.log).toBe("");

    const linux = fakeComputer({ bun: fakeBun(RUNNER_BUN_VERSION, true) });
    const alone = linux.install(installScript("https://agentes.test"), ["--host-token-file", token]);
    expect(alone.status).toBe(1);
    expect(alone.out).toContain("go with --system");
    expect(alone.log).toBe("");
  },
);

test("service files: systemd unit, launchd plist and the Windows task command", () => {
  const launch = {
    runtime: "/usr/bin/node",
    script: "/home/me/.agentes-runner/agentes-runner.mjs",
    home: "/home/me/.agentes-runner",
  };
  const unit = systemdUnit(launch);
  expect(unit).toContain('ExecStart="/usr/bin/node" "/home/me/.agentes-runner/agentes-runner.mjs" start');
  expect(unit).toContain("Restart=always");
  expect(unit).toContain("RestartSec=5");
  expect(unit).toContain("RestartPreventExitStatus=0 2 3");
  // Restarting the runner (an update) leaves background tasks running.
  expect(unit).toContain("KillMode=process");
  expect(unit).toContain('Environment="AGENTES_RUNNER_HOME=/home/me/.agentes-runner"');
  // The install-time PATH, like the plist: tasks find claude, git, node.
  expect(systemdUnit({ ...launch, path: "/home/me/.local/bin:/usr/bin" })).toContain(
    'Environment="PATH=/home/me/.local/bin:/usr/bin"',
  );

  const plist = launchdPlist({ ...launch, script: "/Users/me/a&b/agentes-runner.mjs" });
  expect(plist).toContain("<string>chat.agentes.runner</string>");
  expect(plist).toContain("<string>/Users/me/a&amp;b/agentes-runner.mjs</string>");
  expect(plist).toContain("<key>RunAtLoad</key>");
  expect(plist).toContain("<key>AbandonProcessGroup</key>\n  <true/>");
  expect(plist).toContain("<string>/home/me/.agentes-runner/runner.log</string>");

  const win = windowsTaskCommand({
    runtime: "C:\\Program Files\\nodejs\\node.exe",
    script: "C:\\Users\\me\\.agentes-runner\\agentes-runner.mjs",
    home: "C:\\Users\\me\\.agentes-runner",
  });
  expect(win.install).toBe(
    'schtasks /Create /TN agentes-runner /SC ONLOGON /RL LIMITED /F /TR "\\"C:\\Program Files\\nodejs\\node.exe\\" \\"C:\\Users\\me\\.agentes-runner\\agentes-runner.mjs\\" start"',
  );
});
