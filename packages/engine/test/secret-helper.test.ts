import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecRequest, SandboxProvider } from "@agenteschat/adapters";
import { sealSecret, secretAad } from "@agenteschat/adapters";
import { type ComputerHandle, secretOnComputer, withSecretsCommand } from "../src";

/**
 * The cloud computer's helper, run for real: a fake provider whose `exec`
 * is this machine's shell, in a temp HOME and workspace. Same commands the
 * server sends to Daytona.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function computer() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "helper-home-")));
  const ws = path.join(home, "workspace");
  mkdirSync(ws);
  dirs.push(home);
  const exec = async (_id: string, req: ExecRequest) => {
    // Bun runs the helper as Node would (`node` is on Daytona's PATH; here it is Bun).
    const command = req.command.replace(/\bnode "/g, `"${process.execPath}" "`);
    const r = spawnSync("/bin/sh", ["-c", command], {
      cwd: ws,
      env: { PATH: process.env.PATH, HOME: home },
      encoding: "utf8",
    });
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, timedOut: false };
  };
  const provider = { id: "fake", exec } as unknown as SandboxProvider;
  const handle: ComputerHandle = { id: "sb-1", provider, ref: "daytona:sb-1" };
  return { home, ws, handle, exec };
}

const ORG = "org-1";
const VALUE = "tok_live_9f8e7d6c5b4a3210";

test("keypair, deliver (env and file), run with redaction, remove: the helper does what the runner does", async () => {
  const { home, ws, handle, exec } = computer();
  const { publicKey } = await secretOnComputer(handle, { action: "keypair", requestId: "req-0001-aaaa" });
  expect(publicKey).toBeTruthy();
  const keyFile = path.join(home, ".agentes-secrets", "keys", "req-0001-aaaa");
  expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  expect(statSync(path.join(home, ".agentes-secrets")).mode & 0o777).toBe(0o700);

  const target = { kind: "env" as const };
  const aad = secretAad({ requestId: "req-0001-aaaa", orgId: ORG, name: "STRIPE_KEY", target });
  const box = await sealSecret(publicKey as string, VALUE, aad);
  expect(
    await secretOnComputer(handle, {
      action: "deliver",
      requestId: "req-0001-aaaa",
      name: "STRIPE_KEY",
      target,
      aad,
      box,
    }),
  ).toEqual({ size: VALUE.length });
  // Used once: the key is gone, the same box can't be delivered again.
  await expect(
    secretOnComputer(handle, { action: "deliver", requestId: "req-0001-aaaa", name: "STRIPE_KEY", target, aad, box }),
  ).rejects.toThrow("key is gone");

  // Commands get it as an env variable; their output never shows it; exit codes pass through.
  const used = await exec("sb-1", {
    command: withSecretsCommand(
      `test "$STRIPE_KEY" = "${VALUE}" && echo same; echo "k=$STRIPE_KEY"; echo "$STRIPE_KEY" >&2; exit 3`,
    ),
    timeoutSeconds: 10,
  });
  expect(used.stdout).toBe("same\nk=[secret:STRIPE_KEY]\n");
  expect(used.stderr).toBe("[secret:STRIPE_KEY]\n");
  expect(used.exitCode).toBe(3);

  // A file target: written 600 inside the workspace; outside is refused.
  const pk2 = (await secretOnComputer(handle, { action: "keypair", requestId: "req-0002-bbbb" })).publicKey as string;
  const fileTarget = { kind: "file" as const, path: "config/.npmrc" };
  const aad2 = secretAad({ requestId: "req-0002-bbbb", orgId: ORG, name: "NPM_TOKEN", target: fileTarget });
  await secretOnComputer(handle, {
    action: "deliver",
    requestId: "req-0002-bbbb",
    name: "NPM_TOKEN",
    target: fileTarget,
    aad: aad2,
    box: await sealSecret(pk2, "//r/:_authToken=abcdef123", aad2),
  });
  const npmrc = path.join(ws, "config", ".npmrc");
  expect(readFileSync(npmrc, "utf8")).toBe("//r/:_authToken=abcdef123");
  expect(statSync(npmrc).mode & 0o777).toBe(0o600);
  const pk3 = (await secretOnComputer(handle, { action: "keypair", requestId: "req-0003-cccc" })).publicKey as string;
  const outside = { kind: "file" as const, path: "../outside" };
  const aad3 = secretAad({ requestId: "req-0003-cccc", orgId: ORG, name: "X_TOKEN", target: outside });
  await expect(
    secretOnComputer(handle, {
      action: "deliver",
      requestId: "req-0003-cccc",
      name: "X_TOKEN",
      target: outside,
      aad: aad3,
      box: await sealSecret(pk3, "abcdefgh", aad3),
    }),
  ).rejects.toThrow("inside the workspace");

  // Removed: gone from the store and its file deleted.
  await secretOnComputer(handle, { action: "remove", name: "NPM_TOKEN" });
  expect(() => statSync(npmrc)).toThrow();
  await secretOnComputer(handle, { action: "remove", name: "STRIPE_KEY" });
  const after = await exec("sb-1", { command: withSecretsCommand('echo "[$STRIPE_KEY]"'), timeoutSeconds: 10 });
  expect(after.stdout).toBe("[]\n");
});

test("a box altered on the way or meant for another secret doesn't open", async () => {
  const { handle } = computer();
  const { publicKey } = await secretOnComputer(handle, { action: "keypair", requestId: "req-0004-dddd" });
  const target = { kind: "env" as const };
  const aad = secretAad({ requestId: "req-0004-dddd", orgId: ORG, name: "API_KEY", target });
  const box = await sealSecret(publicKey as string, VALUE, aad);
  await expect(
    secretOnComputer(handle, { action: "deliver", requestId: "req-0004-dddd", name: "OTHER", target, aad, box }),
  ).rejects.toThrow("doesn't match");
  const forged = aad.replace(ORG, "org-2");
  await expect(
    secretOnComputer(handle, {
      action: "deliver",
      requestId: "req-0004-dddd",
      name: "API_KEY",
      target,
      aad: forged,
      box,
    }),
  ).rejects.toThrow("couldn't be opened");
});

test("without the helper (a recreated computer) commands run as they are", async () => {
  const { exec } = computer();
  const r = await exec("sb-1", { command: withSecretsCommand("echo plain; exit 4"), timeoutSeconds: 10 });
  expect(r.stdout).toBe("plain\n");
  expect(r.exitCode).toBe(4);
});
