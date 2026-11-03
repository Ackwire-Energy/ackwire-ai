import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { AGENT_BROWSER_SHA256, AGENT_BROWSER_VERSION } from "@agenteschat/adapters/machine-protocol";
import { lastLine } from "@agenteschat/setup/src/lib";
import { TERM_SH } from "@agenteschat/setup/src/term-sh";
import {
  GOOGLE_APT,
  installScript,
  RUNNER_BUN_SHA256,
  RUNNER_BUN_VERSION,
  SYSTEM_BROWSER_DIR,
  shQuote,
} from "../../runner/install-script";
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
    sys,
    env: { PATH: `${fake}:${sys}`, HOME: home, LOG: log, FAKE_BUN: fetched },
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
        err: r.stderr,
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
  // The look of every agentes.chat command line, in sh (packages/setup/src/term-sh.ts).
  expect(script).toContain(`\n${TERM_SH}`);
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
    expect(r.out).toContain("     Bun:    curl -fsSL https://bun.sh/install | bash\n");
    expect(r.runtime).toBeUndefined();
  },
  // Six whole installs, each a shell running real tools: seconds on a busy computer.
  30_000,
);

test.skipIf(process.platform === "win32")(
  "without a terminal: the marks and whole lines, no line down the left, no color; a refusal in its words",
  () => {
    const pc = fakeComputer({ bun: fakeBun(RUNNER_BUN_VERSION, true) });
    const r = pc.install(installScript("https://x.test"));
    expect(r.status).toBe(0);
    expect(r.out).toStartWith("agentes.chat connect this computer\n◇  Bun 1.4.4 (");
    expect(r.out).toContain("◒  Downloading the runner from https://x.test\n◇  The runner, from https://x.test\n");
    expect(r.out).toContain(
      `●  To use the agentes-runner command, add it to your PATH:\n     export PATH="${pc.home}/.agentes-runner/bin:$PATH"\n`,
    );
    expect(r.out).toEndWith("\nDone\n");
    expect(r.out).not.toContain("\x1b");
    expect(r.out).not.toContain("│");

    const refused = pc.install(installScript("https://x.test"), ["--bogus"]);
    expect(refused.status).toBe(1);
    expect(refused.out).toBe("■  unknown option: --bogus\n");
  },
);

/** A curl that can't download anything: the server answers 404. */
const CURL_404 = '#!/bin/sh\necho "curl: (22) The requested URL returned error: 404" >&2\nexit 22\n';

test.skipIf(process.platform === "win32")(
  "a failure without a terminal ends on why: the last line of stderr, and what the setup shows of it",
  () => {
    const pc = fakeComputer({ bun: fakeBun(RUNNER_BUN_VERSION, true) });
    const pinned = pc.install(installScript("https://x.test"), ["--runner-sha256", "0".repeat(64)]);
    expect(pinned.status).toBe(1);
    expect(pinned.err.trimEnd().split("\n").pop()).toBe(
      "■  the runner download didn't match --runner-sha256, so it was not installed",
    );

    writeFileSync(path.join(pc.fake, "curl"), CURL_404, { mode: 0o755 });
    const missing = pc.install(installScript("https://x.test"));
    expect(missing.status).toBe(1);
    expect(missing.out).toContain("curl: (22) The requested URL returned error: 404\n");
    // The setup's "Setting up the agents' computer failed: …" (packages/setup/src/cli.ts).
    expect(lastLine(missing.out)).toBe("download failed");
  },
);

test.skipIf(process.platform === "win32")(
  "on a terminal, a failed download's output is kept for its last lines, then removed with the installer",
  async () => {
    const pc = fakeComputer({ bun: fakeBun(RUNNER_BUN_VERSION, true) });
    writeFileSync(path.join(pc.fake, "curl"), CURL_404, { mode: 0o755 });
    for (const tool of ["date", "sleep", "stty", "fold", "tail", "tr"]) {
      const real = Bun.which(tool);
      if (real) symlinkSync(real, path.join(pc.sys, tool));
    }
    const tmp = tempDir("tmp-");
    dirs.push(tmp);
    const script = path.join(tmp, "..", `${path.basename(tmp)}-install.sh`);
    writeFileSync(script, installScript("https://x.test"));
    dirs.push(script);
    let out = "";
    const decoder = new TextDecoder();
    let eof = () => {};
    const drained = new Promise<void>((resolve) => {
      eof = resolve;
    });
    const proc = Bun.spawn(["/bin/sh", script], {
      env: { ...pc.env, TMPDIR: tmp, TERM: "xterm-256color" },
      terminal: {
        cols: 80,
        rows: 40,
        data: (_t, bytes) => {
          out += decoder.decode(bytes);
        },
        exit: () => eof(),
      },
    });
    const [code] = await Promise.all([proc.exited, drained]);
    expect(code).toBe(1);
    expect(out).toContain("curl: (22) The requested URL returned error: 404");
    expect(out).toContain("download failed");
    expect(readdirSync(tmp)).toEqual([]);
  },
  20_000,
);

test.skipIf(process.platform === "win32")(
  "Ctrl-C at the code stops the installer too, on 130, not as a failure",
  () => {
    const dir = tempDir("install-");
    dirs.push(dir);
    const site = path.join(dir, "site");
    mkdirSync(path.join(site, "runner"), { recursive: true });
    // Stands in for the runner: `pair` ends as Ctrl-C ends it.
    writeFileSync(path.join(site, "runner", "agentes-runner.mjs"), "process.exit(130);\n");
    const r = spawnSync("sh", ["-s", "--", "--no-service"], {
      input: installScript(`file://${site}`),
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
        AGENTES_RUNNER_HOME: path.join(dir, "home"),
      },
      encoding: "utf8",
    });
    expect(r.status).toBe(130);
    expect(r.stderr).not.toContain("connecting this computer failed");
  },
);

test.skipIf(process.platform === "win32")(
  "Ctrl-C at the code interrupts the installer's whole group: it waits for pair's last lines, then ends on 130",
  async () => {
    const dir = tempDir("install-");
    dirs.push(dir);
    const site = path.join(dir, "site");
    mkdirSync(path.join(site, "runner"), { recursive: true });
    // Stands in for pair at its code: Ctrl-C there interrupts every process of the terminal's group, the
    // installer's shell too, and pair says Canceled a moment later.
    writeFileSync(
      path.join(site, "runner", "agentes-runner.mjs"),
      'process.on("SIGINT", () => {});\nprocess.kill(0, "SIGINT");\nsetTimeout(() => { console.log("■  Canceled"); process.exit(130); }, 300);\n',
    );
    // dash, Debian's and Ubuntu's sh, stops at once on an interrupt it doesn't catch.
    const proc = Bun.spawn([Bun.which("dash") ?? "sh", "-s", "--", "--no-service"], {
      stdin: new Blob([installScript(`file://${site}`)]),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
        AGENTES_RUNNER_HOME: path.join(dir, "home"),
      },
      // A process group of its own, which the interrupt stays in.
      detached: true,
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    expect(proc.signalCode).toBeNull();
    expect(proc.exitCode).toBe(130);
    expect(stdout).toEndWith("■  Canceled\n");
    expect(stderr).not.toContain("connecting this computer failed");
  },
  20_000,
);

test.skipIf(process.platform === "win32")("a download cut short runs nothing: everything is inside main", () => {
  const script = installScript("https://x.test");
  const empty = tempDir("cut-");
  dirs.push(empty);
  const lastLine = script.trimEnd().lastIndexOf("\n");
  for (const cut of [script.slice(0, lastLine), script.slice(0, Math.floor(script.length / 2))]) {
    // No command on the PATH: running one would say it isn't found.
    const r = spawnSync("/bin/sh", ["-s"], { input: cut, encoding: "utf8", env: { PATH: empty } });
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain("not found");
  }
});

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

/** Root on Linux, with the system mode's folders in the test's own and the pinned Bun's download matching. */
function rootLinux() {
  const pc = fakeComputer({});
  writeFileSync(path.join(pc.fake, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
  writeFileSync(
    path.join(pc.fake, "systemctl"),
    '#!/bin/sh\necho "systemd 257 (257.9)"\necho "+PAM +BPF_FRAMEWORK"\n',
    {
      mode: 0o755,
    },
  );
  writeFileSync(path.join(pc.fake, "chown"), "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync(Bun.which("dirname") as string, path.join(pc.fake, "dirname"));
  const at = (dir: string) => path.join(pc.home, "system", dir);
  const script = installScript("https://agentes.test")
    .replace(RUNNER_BUN_SHA256["linux-aarch64"], createHash("sha256").update(FAKE_ZIP).digest("hex"))
    .replaceAll(shQuote(SYSTEM_BROWSER_DIR), shQuote(at("opt/browser")))
    .replaceAll("'/opt/agentes-runner'", shQuote(at("opt")))
    .replaceAll("'/var/lib/agentes-runner'", shQuote(at("var")))
    .replaceAll("'/usr/local/bin/agentes-runner'", shQuote(at("bin/agentes-runner")))
    .replace(/^CHROME_EXE=.*$/m, `CHROME_EXE=${shQuote(at("google/chrome/chrome"))}`)
    .replace(/^CHROME_KEYRING=.*$/m, `CHROME_KEYRING=${shQuote(at("keyrings/google-chrome.gpg"))}`)
    .replace(/^CHROME_SOURCES=.*$/m, `CHROME_SOURCES=${shQuote(at("apt/sources.list.d/google-chrome.sources"))}`)
    .replace(/^CHROME_UNATTENDED=.*$/m, `CHROME_UNATTENDED=${shQuote(at("apt/apt.conf.d/52agentes-google-chrome"))}`)
    .replace(/^CHROME_DESKTOP=.*$/m, `CHROME_DESKTOP=${shQuote(at("applications/google-chrome.desktop"))}`);
  return { ...pc, at, script };
}

test.skipIf(process.platform === "win32")(
  "install.sh --system: what it installs has the same modes under any umask (a provisioner's 077 included)",
  () => {
    const modes = (umask: string) => {
      const pc = rootLinux();
      // The computer's own /usr/local/bin.
      mkdirSync(pc.at("bin"), { recursive: true, mode: 0o755 });
      const r = pc.install(`umask ${umask}\n${pc.script}`, ["--system", "--desktop", "--no-pair", "--no-start"]);
      expect(r.status).toBe(0);
      expect(r.log).toContain("service install --system --no-start");
      expect(r.out).toEndWith(
        `●  The agentes-runner command is ${pc.at("bin/agentes-runner")}. To check this computer's connection:\n     agentes-runner status\n\nDone\n`,
      );
      return Object.fromEntries(
        readdirSync(pc.at(""), { recursive: true })
          .map(String)
          .filter((p) => p !== "bin")
          .map((p) => [p, (lstatSync(pc.at(p)).mode & 0o777).toString(8)]),
      );
    };
    const strict = modes("077");
    // The agents' users run the runner on its Bun; root alone reads its home (the token).
    expect(strict).toEqual({
      opt: "755",
      "opt/bin": "755",
      "opt/bin/bun": "755",
      "opt/agentes-runner.mjs": "644",
      "bin/agentes-runner": "755",
      var: "700",
    });
    expect(modes("022")).toEqual(strict);
  },
  // Two whole installs, each a shell running real tools.
  30_000,
);

/** What the fake downloads serve for agent-browser. */
const FAKE_AB = "not really agent-browser";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Root on x86_64 Linux with its Bun already at the pinned version, a curl that serves agent-browser, and apt with
 * Google's repository: its `apt-get install google-chrome-stable` puts a Chrome (156.0.8078.79) where its package
 * does, unless `aptFails` names a package it fails on; `gpg` reads Google's key with fingerprint `fingerprint`; the
 * computer's default browser is Firefox.
 */
function rootX64(opts: { fingerprint?: string; aptFails?: string } = {}) {
  const pc = rootLinux();
  const fake = (name: string, text: string) => writeFileSync(path.join(pc.fake, name), text, { mode: 0o755 });
  fake("uname", '#!/bin/sh\ncase "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac\n');
  mkdirSync(pc.at("opt/bin"), { recursive: true });
  writeFileSync(pc.at("opt/bin/bun"), fakeBun(RUNNER_BUN_VERSION, true), { mode: 0o755 });
  fake(
    "curl",
    `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
echo "curl $url" >> "$LOG"
case "$url" in
  *agent-browser*) printf '%s' '${FAKE_AB}' > "$out" ;;
  *linux_signing_key.pub) printf 'armored key' > "$out" ;;
  *) printf '#!/usr/bin/env node\\n' > "$out" ;;
esac
`,
  );
  const chrome = pc.at("google/chrome/chrome");
  fake(
    "apt-get",
    `#!/bin/sh
echo "apt-get $*" >> "$LOG"
case " $* " in *" ${opts.aptFails ?? "none"} "*) exit 100 ;; esac
case "$*" in *google-chrome-stable*)
  mkdir -p '${path.dirname(chrome)}'
  printf '#!/bin/sh\\necho "Google Chrome 156.0.8078.79 "\\n' > '${chrome}' && chmod 755 '${chrome}' ;;
esac
`,
  );
  fake("dpkg", '#!/bin/sh\n[ "$1" = --print-architecture ] && echo amd64\n');
  fake("dpkg-statoverride", '#!/bin/sh\n[ "$1" = --list ] && exit 1\necho "dpkg-statoverride $*" >> "$LOG"\n');
  fake(
    "gpg",
    `#!/bin/sh
echo "gpg $*" >> "$LOG"
case " $* " in
  *" --show-keys "*) printf 'pub:-:4096:1:7721F63BD38B4796:1460440619:::-:::scSC::::::23::0:\\nfpr:::::::::%s:\\n' '${opts.fingerprint ?? GOOGLE_APT.fingerprint}' ;;
  *" --dearmor "*) while [ $# -gt 1 ]; do [ "$1" = -o ] && out=$2; shift; done; printf 'binary key' > "$out" ;;
esac
`,
  );
  fake(
    "update-alternatives",
    `#!/bin/sh
case "$1" in
  --query) [ "$2" = x-www-browser ] && printf 'Name: x-www-browser\\nStatus: auto\\nValue: /usr/bin/firefox\\n' ;;
  *) echo "update-alternatives $*" >> "$LOG" ;;
esac
exit 0
`,
  );
  for (const tool of ["ls", "head", "cat", "printf"]) {
    const real = Bun.which(tool);
    if (real && !existsSync(path.join(pc.sys, tool))) symlinkSync(real, path.join(pc.sys, tool));
  }
  const script = pc.script.replace(AGENT_BROWSER_SHA256["linux-x64"], sha256(FAKE_AB));
  const browser = (p = "") => pc.at(path.join("opt/browser", p));
  const run = (text = script, more: string[] = ["--no-start"]) => pc.install(text, ["--system", "--no-pair", ...more]);
  return { ...pc, script, browser, run, chrome };
}

const read = (file: string) => readFileSync(file, "utf8");

test.skipIf(process.platform === "win32")(
  "install.sh --system: Google Chrome stable from Google's apt repository, its key checked, updated like the rest",
  () => {
    const pc = rootX64();
    const r = pc.run(pc.script, ["--desktop", "--no-start"]);
    expect(r.status).toBe(0);
    // Google's key, refused unless it is the one we know, into the keyring Chrome's own package writes.
    expect(r.log).toContain(`curl ${GOOGLE_APT.key}\n`);
    expect(r.log).toMatch(/gpg --batch --show-keys --with-colons \S+\/key\.asc\n/);
    expect(read(pc.at("keyrings/google-chrome.gpg"))).toBe("binary key");
    // The repository as the package itself sets it up, so its own setup rewrites it as it is.
    expect(read(pc.at("apt/sources.list.d/google-chrome.sources"))).toBe(
      [
        "### THIS FILE IS AUTOMATICALLY CONFIGURED ###",
        "# Changes to this file will not be preserved.",
        "# This file will not be recreated if removed.",
        "X-Repolib-Name: Google Chrome",
        "Types: deb",
        "URIs: https://dl.google.com/linux/chrome-stable/deb/",
        "Suites: stable",
        "Components: main",
        "Architectures: amd64",
        `Signed-By: ${pc.at("keyrings/google-chrome.gpg")}`,
        "",
      ].join("\n"),
    );
    expect(r.log).toContain(
      "apt-get -qq -o DPkg::Lock::Timeout=600 install -y --no-install-recommends google-chrome-stable\n",
    );
    // Its sandbox helper never set-user-id root, for this install and every upgrade, before the package lands.
    expect(r.log).toContain(`dpkg-statoverride --add root root 0755 ${pc.at("google/chrome/chrome-sandbox")}\napt-get`);
    // Updated with the computer's other packages (unattended upgrades included), never pinned.
    expect(read(pc.at("apt/apt.conf.d/52agentes-google-chrome"))).toBe(
      'Unattended-Upgrade::Origins-Pattern { "origin=Google LLC,codename=stable"; };\n',
    );
    // The computer's default browser stays its own.
    expect(r.log).toContain("update-alternatives --set x-www-browser /usr/bin/firefox\n");
    // The agents' menus offer no second Chrome on the default profile.
    expect(read(pc.at("applications/google-chrome.desktop"))).toContain("NoDisplay=true\n");
    expect(r.out).toContain("Google Chrome 156.0.8078.79, updated with this computer's packages");
    // No Chrome for Testing anywhere.
    expect(r.log).not.toContain("chrome-for-testing");
    expect(readdirSync(pc.browser())).toEqual([`agent-browser-${AGENT_BROWSER_VERSION}`]);
    expect(existsSync(pc.at("opt/agentes-runner.mjs"))).toBe(true);

    // Again, with Chrome there: nothing of it is installed or set again, whoever installed it.
    rmSync(pc.at("apt/apt.conf.d/52agentes-google-chrome"));
    const again = pc.run();
    expect(again.status).toBe(0);
    expect(again.log.split("google-chrome-stable").length).toBe(2);
    expect(again.out).toContain("Google Chrome 156.0.8078.79, updated by this computer's own updates");
    expect(existsSync(pc.at("apt/apt.conf.d/52agentes-google-chrome"))).toBe(false);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "install.sh --system: a key that isn't Google's stops the install; apt failing only says so, and the install goes on",
  () => {
    const forged = rootX64({ fingerprint: "0".repeat(40) });
    const r = forged.run();
    expect(r.status).toBe(1);
    expect(r.err.trimEnd().split("\n").pop()).toBe(
      "■  Google's apt key didn't match its fingerprint, so Google Chrome was not installed",
    );
    expect(existsSync(forged.at("keyrings/google-chrome.gpg"))).toBe(false);
    expect(existsSync(forged.at("apt/sources.list.d/google-chrome.sources"))).toBe(false);
    expect(r.log).not.toContain("google-chrome-stable");
    expect(existsSync(forged.at("opt/agentes-runner.mjs"))).toBe(false);

    const failing = rootX64({ aptFails: "google-chrome-stable" });
    const r2 = failing.run();
    expect(r2.status).toBe(0);
    expect(r2.out).toContain("Installing Google Chrome failed: run this installer again.");
    expect(existsSync(failing.chrome)).toBe(false);
    expect(existsSync(failing.at("opt/agentes-runner.mjs"))).toBe(true);
    expect(r2.log).toContain("service install --system --no-start");

    // No apt: the person installs Chrome, told so.
    const noApt = rootX64();
    rmSync(path.join(noApt.fake, "apt-get"));
    const r3 = noApt.run();
    expect(r3.status).toBe(0);
    expect(r3.out).toContain("The agents' browser needs Google Chrome: install it (google.com/chrome)");
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "install.sh --system: older agent-browsers go but the last one; Chrome for Testing goes once the runner restarted",
  () => {
    const pc = rootX64();
    const day = 86_400;
    const old = (name: string, daysAgo: number, dir = true) => {
      const p = pc.browser(name);
      if (dir) mkdirSync(path.join(p, "chrome-linux64"), { recursive: true });
      else writeFileSync(p, "old", { mode: 0o755 });
      const t = Date.now() / 1000 - daysAgo * day;
      utimesSync(p, t, t);
    };
    mkdirSync(pc.browser(), { recursive: true });
    old("agent-browser-0.37.0", 2, false);
    old("agent-browser-0.38.0", 1, false);
    old("chrome-156.0.8078.80", 1);
    old(".chrome-157.0.1.new", 1);
    old(".agent-browser-0.38.0.download", 1, false);
    // Not restarted (--no-start): the running runner may still use Chrome for Testing, so it stays.
    expect(pc.run().status).toBe(0);
    expect(readdirSync(pc.browser()).sort()).toEqual([
      ".chrome-157.0.1.new",
      "agent-browser-0.38.0",
      `agent-browser-${AGENT_BROWSER_VERSION}`,
      "chrome-156.0.8078.80",
    ]);
    // Restarted on Google Chrome: Chrome for Testing goes.
    const started = pc.run(pc.script, []);
    expect(started.status).toBe(0);
    expect(started.log).toContain("service install --system\n");
    expect(readdirSync(pc.browser()).sort()).toEqual([
      "agent-browser-0.38.0",
      `agent-browser-${AGENT_BROWSER_VERSION}`,
    ]);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "install.sh --system: an agent-browser download that isn't the pinned one stops the install; one that fails doesn't",
  () => {
    const ab = rootX64();
    const refused = ab.run(ab.script.replace(sha256(FAKE_AB), "0".repeat(64)));
    expect(refused.status).toBe(1);
    expect(refused.err.trimEnd().split("\n").pop()).toBe(
      "■  the agent-browser download didn't match its checksum, so it was not installed",
    );
    expect(readdirSync(ab.browser())).toEqual([]);
    expect(existsSync(ab.at("opt/agentes-runner.mjs"))).toBe(false);

    const pc = rootX64();
    const curl = path.join(pc.fake, "curl");
    const logged = 'echo "curl $url" >> "$LOG"\n';
    writeFileSync(
      curl,
      readFileSync(curl, "utf8").replace(
        logged,
        () => `${logged}case "$url" in *agent-browser-linux-x64) exit 22 ;; esac\n`,
      ),
    );
    const r = pc.run();
    expect(r.status).toBe(0);
    expect(r.out).toContain("failed: each agent installs what's missing at its browser's first use");
    expect(readdirSync(pc.browser())).toEqual([]);
    expect(existsSync(pc.at("opt/agentes-runner.mjs"))).toBe(true);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "this server's computer on Linux, as root: --no-exec passed on; a computer already connected keeps its service",
  () => {
    const rootHost = () => {
      const pc = rootLinux();
      const token = path.join(pc.home, "host-computer-token");
      writeFileSync(token, "t".repeat(64));
      const args = ["--system", "--desktop", "--server", "http://127.0.0.1:3000", "--host-token-file", token];
      return { ...pc, token, run: (more: string[] = []) => pc.install(pc.script, [...args, ...more]) };
    };

    const pc = rootHost();
    const run = pc.run(["--no-exec"]);
    expect(run.status).toBe(0);
    expect(run.log).toContain("service install --system --no-start");
    expect(run.log).toContain(
      `service install --host --server http://127.0.0.1:3000 --token-file ${pc.token} --no-exec\n`,
    );
    expect(pc.run().log).toContain(`service install --host --server http://127.0.0.1:3000 --token-file ${pc.token}\n`);

    // Connected as a computer of its own: the root unit stays that connection's, and nothing is installed.
    const paired = rootHost();
    mkdirSync(paired.at("var"), { recursive: true });
    writeFileSync(path.join(paired.at("var"), "config.json"), '{ "mode": "system", "token": "agm_x" }\n');
    const refused = paired.run();
    expect(refused.status).toBe(1);
    expect(refused.out).toContain("already connected to agentes.chat as a computer");
    expect(refused.log).toBe("");
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
