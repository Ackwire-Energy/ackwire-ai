/**
 * The helper we install in an agent's cloud computer for secrets (ADR 0027):
 * a dependency-free Node script (the computer always has Node), kept in
 * `$HOME/.agentes-secrets/` (mode 700) next to its keys and store, outside the
 * workspace so the file tools never reach it. It repeats `secret-box.ts`
 * (open only) and the runner's store; `secret-helper.test.ts` checks both
 * against what the browser seals.
 *
 *   node helper.mjs keypair <requestId>            → {"publicKey": "…"}
 *   node helper.mjs deliver <base64 JSON>          → {"size": n}   (requestId, name, target, aad, box)
 *   node helper.mjs discard <requestId>
 *   node helper.mjs remove <NAME>
 *   node helper.mjs run <base64 command>           runs it with the env secrets, output redacted
 *
 * Every action prints one JSON line; failures are `{"error": "…"}` with exit 2.
 */
export const SECRET_HELPER_DIR = "$HOME/.agentes-secrets";
export const SECRET_HELPER_PATH = `${SECRET_HELPER_DIR}/helper.mjs`;

export const SECRET_HELPER_SOURCE = String.raw`// agentes.chat secrets helper (ADR 0027). Installed by the server; don't edit.
import { webcrypto as crypto } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";

const HOME = path.join(process.env.HOME || "/tmp", ".agentes-secrets");
const KEYS = path.join(HOME, "keys");
const STORE = path.join(HOME, "store.json");
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const REQUEST = /^[a-zA-Z0-9-]{8,64}$/;
const EC = { name: "ECDH", namedCurve: "P-256" };
const INFO = new TextEncoder().encode("agentes.chat secret v1");

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const unb64 = (text) => new Uint8Array(Buffer.from(text, "base64"));
// Synchronous: process.exit right after must not cut the answer.
const fail = (message) => {
  writeSync(1, JSON.stringify({ error: message }) + "\n");
  process.exit(2);
};
const ok = (value) => writeSync(1, JSON.stringify(value ?? {}) + "\n");

function ensure(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
function readStore() {
  try {
    const raw = JSON.parse(readFileSync(STORE, "utf8"));
    return Array.isArray(raw.secrets) ? raw.secrets : [];
  } catch {
    return [];
  }
}
function writeStore(secrets) {
  ensure(HOME);
  const tmp = STORE + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify({ secrets }), { mode: 0o600 });
  renameSync(tmp, STORE);
}
function keyFile(requestId) {
  if (!REQUEST.test(String(requestId))) fail("Invalid request id");
  return path.join(KEYS, requestId);
}
/** A path inside the workspace (the cwd), never through a link that leaves it. */
function inWorkspace(rel) {
  const root = realpathSync(process.cwd());
  const clean = String(rel).replace(/\\/g, "/").replace(/^\/workspace\//, "");
  if (!clean || clean.startsWith("/") || clean.split("/").includes("..")) fail("The path must be inside the workspace");
  const abs = path.join(root, clean);
  let parent = path.dirname(abs);
  while (!existsSync(parent)) parent = path.dirname(parent);
  const real = realpathSync(parent);
  if (real !== root && !real.startsWith(root + path.sep)) fail("The path leaves the workspace");
  return { abs, rel: clean };
}
function redact(text, secrets) {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.value.length - a.value.length)) {
    if (s.value.length < 4) continue;
    out = out.split(s.value).join("[secret:" + s.name + "]");
  }
  return out;
}

async function open(privateKey, box, aad) {
  if (!box || box.v !== 1) fail("Unknown secret box version");
  const priv = await crypto.subtle.importKey("pkcs8", unb64(privateKey), EC, false, ["deriveBits"]);
  const epk = unb64(box.epk);
  const sender = await crypto.subtle.importKey("raw", epk, EC, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, priv, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: epk, info: INFO },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(box.iv), additionalData: new TextEncoder().encode(aad) },
    key,
    unb64(box.ct),
  );
  return new TextDecoder().decode(plain);
}

const [action, arg] = process.argv.slice(2);

if (action === "keypair") {
  const file = keyFile(arg);
  ensure(KEYS);
  // Keys of requests nobody answered (expired, canceled) go after an hour.
  for (const name of readdirSync(KEYS)) {
    try {
      if (Date.now() - statSync(path.join(KEYS, name)).mtimeMs > 3600000) rmSync(path.join(KEYS, name), { force: true });
    } catch {}
  }
  const pair = await crypto.subtle.generateKey(EC, true, ["deriveBits"]);
  const pub = await crypto.subtle.exportKey("raw", pair.publicKey);
  const priv = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  writeFileSync(file, b64(priv), { mode: 0o600 });
  ok({ publicKey: b64(pub) });
} else if (action === "deliver") {
  let req;
  try {
    req = JSON.parse(Buffer.from(String(arg), "base64").toString("utf8"));
  } catch {
    fail("Invalid request");
  }
  if (!NAME.test(String(req.name))) fail("Invalid secret name");
  const target = req.target && req.target.kind === "file" ? { kind: "file", path: String(req.target.path) } : { kind: "env" };
  const parts = String(req.aad).split("|");
  const want = target.kind === "file" ? "file:" + target.path : "env";
  if (parts.length !== 6 || parts[0] !== "agentes-secret" || parts[2] !== req.requestId || parts[4] !== req.name || parts[5] !== want) {
    fail("The secret doesn't match its request");
  }
  const file = keyFile(req.requestId);
  if (!existsSync(file)) fail("This request's key is gone (it expired or was answered)");
  let value;
  try {
    value = await open(readFileSync(file, "utf8"), req.box, req.aad);
  } catch {
    fail("The secret couldn't be opened (wrong key or altered on the way)");
  }
  if (target.kind === "file") {
    const where = inWorkspace(target.path);
    mkdirSync(path.dirname(where.abs), { recursive: true });
    writeFileSync(where.abs, value, { mode: 0o600 });
    chmodSync(where.abs, 0o600);
    target.path = where.rel;
  }
  const secrets = readStore().filter((s) => s.name !== req.name);
  secrets.push({ name: req.name, target, value, deliveredAt: new Date().toISOString() });
  writeStore(secrets);
  rmSync(file, { force: true });
  ok({ size: Buffer.byteLength(value) });
} else if (action === "discard") {
  rmSync(keyFile(arg), { force: true });
  ok();
} else if (action === "remove") {
  const secrets = readStore();
  const gone = secrets.find((s) => s.name === arg);
  if (gone && gone.target.kind === "file") {
    try {
      rmSync(inWorkspace(gone.target.path).abs, { force: true });
    } catch {}
  }
  if (gone) writeStore(secrets.filter((s) => s.name !== arg));
  ok();
} else if (action === "run") {
  const command = Buffer.from(String(arg), "base64").toString("utf8");
  const secrets = readStore();
  const env = { ...process.env };
  for (const s of secrets) if (s.target.kind === "env") env[s.name] = s.value;
  const child = spawn("/bin/sh", ["-c", command], { env, stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (from, to) => {
    let carry = "";
    from.setEncoding("utf8");
    // Redact first, then hold back a tail shorter than the longest secret: a value cut
    // between two chunks is caught whole with the next one, and never leaves in pieces.
    const keep = Math.max(0, ...secrets.map((s) => s.value.length - 1));
    from.on("data", (chunk) => {
      const out = redact(carry + chunk, secrets);
      const cut = Math.max(0, out.length - keep);
      to.write(out.slice(0, cut));
      carry = out.slice(cut);
    });
    from.on("end", () => to.write(redact(carry, secrets)));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => child.kill(sig));
  // Not process.exit: the redacted output may still be on its way out.
  child.on("close", (code, signal) => {
    process.exitCode = code ?? 128 + (signal === "SIGKILL" ? 9 : 15);
  });
} else {
  fail("Unknown action");
}
`;
