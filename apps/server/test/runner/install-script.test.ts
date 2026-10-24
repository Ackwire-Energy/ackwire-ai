import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installScript, shQuote } from "../../runner/install-script";
import { launchdPlist, systemdUnit, windowsTaskCommand } from "../../runner/service";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

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
      env: { ...process.env, AGENTES_RUNNER_HOME: home },
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
