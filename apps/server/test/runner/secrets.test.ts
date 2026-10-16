import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { MachineRequest } from "@agenteschat/adapters/machine-protocol";
import { type SecretTarget, sealSecret, secretAad } from "@agenteschat/adapters/secret-box";
import { describeRequest, handleRequest, type RequestScope } from "../../runner/handlers";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const scope = (): RequestScope => ({ signal: new AbortController().signal, output: () => {} });
const dev = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev" };
const ops = { id: "9f00aa11-0000-7000-8000-000000000000", handle: "ops" };
const ORG = "org-1";
const VALUE = "ghp_s3cretValue1234567890";

function setup() {
  const ws = tempDir();
  const home = tempDir("runner-home-");
  dirs.push(ws, home);
  const ctx = { workspaceReal: ws, exec: true, token: "agm_x", secretsDir: path.join(home, "secrets") };
  const call = (req: MachineRequest) => handleRequest(ctx, req, scope());
  /** keypair on the machine → sealed like the browser does → deliver. */
  const give = async (agent: typeof dev, requestId: string, name: string, target: SecretTarget, value = VALUE) => {
    const { publicKey } = (await call({ agent, op: "secret", action: "keypair", requestId })) as { publicKey: string };
    const aad = secretAad({ requestId, orgId: ORG, name, target });
    const box = await sealSecret(publicKey, value, aad);
    return {
      aad,
      box,
      deliver: () => call({ agent, op: "secret", action: "deliver", requestId, name, target, aad, box }),
    };
  };
  return { ws, home, ctx, call, give };
}

const exec = (command: string) => ({ op: "exec" as const, command, timeoutSeconds: 10, stream: false });

test("an env secret reaches the agent's commands, never their output; other agents don't get it", async () => {
  const { call, give, home } = setup();
  const sent = await give(dev, "req-0001-aaaa", "AGENTES_DEMO_TOKEN", { kind: "env" });
  expect(await sent.deliver()).toEqual({ size: VALUE.length });

  const used = (await call({
    agent: dev,
    ...exec('test "$AGENTES_DEMO_TOKEN" = "' + VALUE + '" && echo matches'),
  })) as {
    stdout: string;
  };
  expect(used.stdout.trim()).toBe("matches");
  const printed = (await call({
    agent: dev,
    ...exec('echo "token=$AGENTES_DEMO_TOKEN"; echo "$AGENTES_DEMO_TOKEN" >&2'),
  })) as {
    stdout: string;
    stderr: string;
  };
  expect(printed.stdout.trim()).toBe("token=[secret:AGENTES_DEMO_TOKEN]");
  expect(printed.stderr.trim()).toBe("[secret:AGENTES_DEMO_TOKEN]");

  const other = (await call({ agent: ops, ...exec('echo "[$AGENTES_DEMO_TOKEN]"') })) as { stdout: string };
  expect(other.stdout.trim()).toBe("[]");

  // Stored outside the workspace, private to the user; the key is gone once used.
  const store = path.join(home, "secrets", "01a142cb", "store.json");
  expect(statSync(store).mode & 0o777).toBe(0o600);
  expect(statSync(path.dirname(store)).mode & 0o777).toBe(0o700);
  expect(existsSync(path.join(home, "secrets", "01a142cb", "keys", "req-0001-aaaa"))).toBe(false);
  expect(await errorCode(() => sent.deliver())).toBe("not_found");
});

test("a file secret is written 600 in the agent's folder and can't be read or uploaded from there", async () => {
  const { ws, call, give } = setup();
  const sent = await give(
    dev,
    "req-0002-bbbb",
    "NPM_TOKEN",
    { kind: "file", path: ".npmrc" },
    "//registry/:_authToken=abc12345",
  );
  await sent.deliver();
  const file = path.join(ws, "dev-01a142cb", ".npmrc");
  expect(readFileSync(file, "utf8")).toBe("//registry/:_authToken=abc12345");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(await errorCode(() => call({ agent: dev, op: "read", path: ".npmrc", maxBytes: 1000 }))).toBe("bad_request");
  expect(
    await errorCode(() =>
      call({ agent: dev, op: "push", path: ".npmrc", url: "https://x/u", uploadId: "u1", maxBytes: 1000 }),
    ),
  ).toBe("bad_request");
  const cat = (await call({ agent: dev, ...exec("cat .npmrc") })) as { stdout: string };
  expect(cat.stdout).toBe("[secret:NPM_TOKEN]");

  // Removed: the file goes too.
  await call({ agent: dev, op: "secret", action: "remove", name: "NPM_TOKEN" });
  expect(existsSync(file)).toBe(false);
});

test("a box for another request, secret or target doesn't open; nothing is stored", async () => {
  const { call, give, home } = setup();
  const sent = await give(dev, "req-0003-cccc", "API_KEY", { kind: "env" });
  const base = { agent: dev, op: "secret" as const, action: "deliver" as const, requestId: "req-0003-cccc" };
  // The server says another name than the box was sealed for.
  expect(
    await errorCode(() => call({ ...base, name: "OTHER", target: { kind: "env" }, aad: sent.aad, box: sent.box })),
  ).toBe("bad_request");
  // Same request, but the AAD was changed on the way: the cipher refuses it.
  const forged = sent.aad.replace(ORG, "org-2");
  expect(
    await errorCode(() => call({ ...base, name: "API_KEY", target: { kind: "env" }, aad: forged, box: sent.box })),
  ).toBe("bad_request");
  expect(existsSync(path.join(home, "secrets", "01a142cb", "store.json"))).toBe(false);
  // Discarded: the key is gone, the box can't be used any more.
  await call({ agent: dev, op: "secret", action: "discard", requestId: "req-0003-cccc" });
  expect(await errorCode(() => sent.deliver())).toBe("not_found");
});

test("the log line names the action, never the value", () => {
  const line = describeRequest({
    agent: dev,
    op: "secret",
    action: "deliver",
    requestId: "req-0004-dddd",
    name: "AGENTES_DEMO_TOKEN",
    target: { kind: "env" },
    aad: "x",
    box: { v: 1, epk: "e", iv: "i", ct: "c" },
  });
  expect(line).toBe("[dev] secret deliver AGENTES_DEMO_TOKEN");
});

test("live output never shows a value split between two chunks", async () => {
  const { ctx, give } = setup();
  await (await give(dev, "req-0005-eeee", "AGENTES_DEMO_TOKEN", { kind: "env" })).deliver();
  const live: string[] = [];
  const half = VALUE.length / 2;
  const reply = (await handleRequest(
    ctx,
    {
      agent: dev,
      op: "exec",
      command: `printf 'a=${VALUE.slice(0, half)}'; sleep 0.6; printf '${VALUE.slice(half)}\\n'`,
      timeoutSeconds: 10,
      stream: true,
    },
    { signal: new AbortController().signal, output: (_s, chunk) => live.push(chunk) },
  )) as { stdout: string };
  expect(live.length).toBeGreaterThan(0);
  expect(live.join("")).toBe("a=[secret:AGENTES_DEMO_TOKEN]\n");
  expect(live.join("")).not.toContain(VALUE.slice(0, half));
  expect(reply.stdout).toBe("a=[secret:AGENTES_DEMO_TOKEN]\n");
});
