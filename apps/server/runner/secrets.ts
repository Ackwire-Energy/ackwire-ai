import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentScope, MachineReplies, SecretRequest } from "@agenteschat/adapters/machine-protocol";
import { generateSecretKeyPair, openSecret, redactSecrets, SECRET_NAME } from "@agenteschat/adapters/secret-box";
import { errnoCode, RunnerError } from "./errors";
import { agentFolderName, resolveInWorkspace } from "./paths";

/**
 * Each agent's secrets on this machine (ADR 0027), outside the workspace so
 * the file tools never reach them: `<runner home>/secrets/<agent id8>/`
 * (mode 700), with `keys/<requestId>` (the private key of a pending request)
 * and `store.json` (delivered values), both mode 600.
 */
interface Stored {
  name: string;
  target: { kind: "env" } | { kind: "file"; path: string };
  value: string;
  deliveredAt: string;
}

const REQUEST_ID = /^[a-zA-Z0-9-]{8,64}$/;
/** Keys of requests nobody answered (expired, canceled) are dropped after this. */
const STALE_KEY_MS = 3600_000;

async function pruneKeys(keysDir: string) {
  const names = await readdir(keysDir).catch(() => [] as string[]);
  for (const name of names) {
    const file = path.join(keysDir, name);
    const st = await stat(file).catch(() => null);
    if (st && Date.now() - st.mtimeMs > STALE_KEY_MS) await rm(file, { force: true });
  }
}

const dirOf = (root: string, agent: AgentScope) => path.join(root, agentFolderName(agent).suffix.slice(1));

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
}

async function readStore(dir: string): Promise<Stored[]> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, "store.json"), "utf8")) as { secrets?: Stored[] };
    return Array.isArray(raw.secrets) ? raw.secrets : [];
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return [];
    throw err;
  }
}

/** Written whole, then renamed: a crash never leaves half a file. */
async function writeStore(dir: string, secrets: Stored[]) {
  const file = path.join(dir, "store.json");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ secrets }), { mode: 0o600 });
  await rename(tmp, file);
}

const keyFile = (dir: string, requestId: string) => {
  if (!REQUEST_ID.test(requestId)) throw new RunnerError("bad_request", "Invalid request id");
  return path.join(dir, "keys", requestId);
};

/** `agentes-secret|v1|<request>|<org>|<name>|<target>`: the server's AAD must name this request, secret and target. */
function checkAad(aad: string, requestId: string, name: string, target: Stored["target"]) {
  const parts = String(aad).split("|");
  const want = target.kind === "file" ? `file:${target.path}` : "env";
  if (
    parts.length !== 6 ||
    parts[0] !== "agentes-secret" ||
    parts[2] !== requestId ||
    parts[4] !== name ||
    parts[5] !== want
  ) {
    throw new RunnerError("bad_request", "The secret doesn't match its request");
  }
}

export async function handleSecret(
  root: string,
  agent: AgentScope | undefined,
  workspaceReal: string,
  req: SecretRequest,
): Promise<MachineReplies["secret"]> {
  if (!agent) throw new RunnerError("bad_request", "Secrets belong to an agent");
  const dir = dirOf(root, agent);
  switch (req.action) {
    case "keypair": {
      const file = keyFile(dir, req.requestId);
      await ensureDir(path.dirname(file));
      await pruneKeys(path.dirname(file));
      const pair = await generateSecretKeyPair();
      await writeFile(file, pair.privateKey, { mode: 0o600 });
      return { publicKey: pair.publicKey };
    }
    case "deliver": {
      if (!SECRET_NAME.test(String(req.name))) throw new RunnerError("bad_request", "Invalid secret name");
      const target: Stored["target"] =
        req.target?.kind === "file" ? { kind: "file", path: String(req.target.path) } : { kind: "env" };
      checkAad(req.aad, req.requestId, req.name, target);
      const file = keyFile(dir, req.requestId);
      let privateKey: string;
      try {
        privateKey = await readFile(file, "utf8");
      } catch (err) {
        if (errnoCode(err) === "ENOENT")
          throw new RunnerError("not_found", "This request's key is gone (it expired or was answered)");
        throw err;
      }
      let value: string;
      try {
        value = await openSecret(privateKey, req.box, req.aad);
      } catch {
        throw new RunnerError("bad_request", "The secret couldn't be opened (wrong key or altered on the way)");
      }
      if (target.kind === "file") {
        const resolved = await resolveInWorkspace(workspaceReal, target.path);
        if (resolved.rel === "") throw new RunnerError("bad_request", "Can't write a secret over the workspace");
        await mkdir(path.dirname(resolved.abs), { recursive: true });
        await writeFile(resolved.abs, value, { mode: 0o600 });
        await chmod(resolved.abs, 0o600).catch(() => undefined);
        target.path = resolved.rel;
      }
      await ensureDir(dir);
      const secrets = (await readStore(dir)).filter((s) => s.name !== req.name);
      secrets.push({ name: req.name, target, value, deliveredAt: new Date().toISOString() });
      await writeStore(dir, secrets);
      await rm(file, { force: true });
      return { size: Buffer.byteLength(value) };
    }
    case "discard":
      await rm(keyFile(dir, req.requestId), { force: true });
      return {};
    case "remove": {
      const secrets = await readStore(dir);
      const gone = secrets.find((s) => s.name === req.name);
      if (gone?.target.kind === "file") {
        const resolved = await resolveInWorkspace(workspaceReal, gone.target.path).catch(() => null);
        if (resolved?.exists) await rm(resolved.abs, { force: true });
      }
      if (gone)
        await writeStore(
          dir,
          secrets.filter((s) => s.name !== req.name),
        );
      return {};
    }
    default:
      throw new RunnerError("bad_request", "Unknown secret action");
  }
}

/** What commands of this agent get: env values, and a redactor for everything that leaves the machine. */
export async function agentSecrets(root: string | undefined, agent: AgentScope | undefined) {
  if (!root || !agent) return null;
  const secrets = await readStore(dirOf(root, agent)).catch(() => []);
  if (secrets.length === 0) return null;
  const env: Record<string, string> = {};
  for (const s of secrets) if (s.target.kind === "env") env[s.name] = s.value;
  return {
    env,
    files: secrets.flatMap((s) => (s.target.kind === "file" ? [s.target.path] : [])),
    hold: Math.max(0, ...secrets.map((s) => s.value.length - 1)),
    redact: (text: string) => redactSecrets(text, secrets),
  };
}
