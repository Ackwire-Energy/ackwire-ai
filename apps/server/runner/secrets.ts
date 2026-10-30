import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentScope, MachineReplies, SecretRequest } from "@agenteschat/adapters/machine-protocol";
import {
  generateSecretKeyPair,
  isReservedSecretName,
  openSecret,
  redactSecrets,
  SECRET_NAME,
} from "@agenteschat/adapters/secret-box";
import { errnoCode, RunnerError } from "./errors";
import { touchesGitInternals } from "./git-guard";
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
  requestId?: string;
  order?: string;
}

type Staged = Extract<SecretRequest, { action: "deliver" }>;

const REQUEST_ID = /^[a-zA-Z0-9-]{8,64}$/;
/** Keys of requests nobody answered (expired, canceled) are dropped after this. */
const STALE_KEY_MS = 3600_000;

async function pruneKeys(keysDir: string) {
  const names = await readdir(keysDir).catch(() => [] as string[]);
  for (const name of names) {
    const file = path.join(keysDir, name);
    const st = await stat(file).catch(() => null);
    if (!st || Date.now() - st.mtimeMs <= STALE_KEY_MS) continue;
    const staged = path.join(path.dirname(keysDir), "staged", name);
    const stagedStat = await stat(staged).catch(() => null);
    // A committed delivery can wait for the machine to reconnect before the
    // outbox activates it. Keep its key while the staged box is recoverable.
    if (stagedStat && Date.now() - stagedStat.mtimeMs <= 7 * 24 * STALE_KEY_MS) continue;
    await rm(file, { force: true });
    if (stagedStat) await rm(staged, { force: true });
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
const stagedFile = (dir: string, requestId: string) => {
  if (!REQUEST_ID.test(requestId)) throw new RunnerError("bad_request", "Invalid request id");
  return path.join(dir, "staged", requestId);
};
const canceledFile = (dir: string, requestId: string) =>
  path.join(dir, "canceled", path.basename(stagedFile(dir, requestId)));
const orderFile = (dir: string, name: string) => {
  if (!SECRET_NAME.test(name)) throw new RunnerError("bad_request", "Invalid secret name");
  return path.join(dir, "orders", name);
};
async function latestOrder(dir: string, name: string, stored: Stored | undefined) {
  const persisted = await readFile(orderFile(dir, name), "utf8").catch((err) => {
    if (errnoCode(err) === "ENOENT") return "";
    throw err;
  });
  return persisted > (stored?.order ?? "") ? persisted : (stored?.order ?? "");
}
async function writeOrder(dir: string, name: string, order: string) {
  const file = orderFile(dir, name);
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, order, { mode: 0o600 });
  await rename(tmp, file);
}
async function cancelStaged(dir: string, requestId: string) {
  const marker = canceledFile(dir, requestId);
  await ensureDir(path.dirname(marker));
  await writeFile(marker, "", { mode: 0o600 });
  await rm(keyFile(dir, requestId), { force: true });
  await rm(stagedFile(dir, requestId), { force: true });
}

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

const secretQueues = new Map<string, Promise<void>>();

/** Serialize an agent's secret mutations, including activation against removal. */
export async function handleSecret(
  root: string,
  agent: AgentScope | undefined,
  workspaceReal: string,
  req: SecretRequest,
): Promise<MachineReplies["secret"]> {
  if (!agent) throw new RunnerError("bad_request", "Secrets belong to an agent");
  const dir = dirOf(root, agent);
  const previous = secretQueues.get(dir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  secretQueues.set(dir, current);
  await previous;
  try {
    return await handleSecretLocked(dir, workspaceReal, req);
  } finally {
    release();
    if (secretQueues.get(dir) === current) secretQueues.delete(dir);
  }
}

async function handleSecretLocked(
  dir: string,
  workspaceReal: string,
  req: SecretRequest,
): Promise<MachineReplies["secret"]> {
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
      if (!SECRET_NAME.test(String(req.name)) || isReservedSecretName(String(req.name))) {
        throw new RunnerError("bad_request", "Invalid secret name");
      }
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
        // Like the `write` op: a repository's git dir is the runner's own git's settings (`git-guard.ts`).
        if (touchesGitInternals(target.path, resolved.abs)) {
          throw new RunnerError("bad_request", "A secret can't be written inside a .git folder");
        }
      }
      // Before the server commits, keep only ciphertext and never expose the
      // value to commands, browser use, or files in the workspace.
      const staged = stagedFile(dir, req.requestId);
      await ensureDir(path.dirname(staged));
      const payload = JSON.stringify(req);
      try {
        await writeFile(staged, payload, { flag: "wx", mode: 0o600 });
      } catch (err) {
        if (errnoCode(err) !== "EEXIST" || (await readFile(staged, "utf8")) !== payload) throw err;
        // A lost stage reply may be retried with the same sealed box.
      }
      return { size: Buffer.byteLength(value) };
    }
    case "activate": {
      if (!req.order || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\|[a-zA-Z0-9-]{8,64}$/.test(req.order))
        throw new RunnerError("bad_request", "Invalid secret delivery order");
      if (
        await stat(canceledFile(dir, req.requestId)).then(
          () => true,
          (err) => {
            if (errnoCode(err) === "ENOENT") return false;
            throw err;
          },
        )
      )
        return { superseded: true };
      const staged = stagedFile(dir, req.requestId);
      let delivery: Staged;
      try {
        delivery = JSON.parse(await readFile(staged, "utf8")) as Staged;
      } catch (err) {
        if (errnoCode(err) !== "ENOENT") throw err;
        // An activation reply can be lost after the store was written.
        const secrets = await readStore(dir);
        const own = secrets.find((s) => s.requestId === req.requestId);
        const current = own ? secrets.filter((s) => s.name === own.name).at(-1) : null;
        if (own && (await latestOrder(dir, own.name, current ?? undefined)) > req.order) {
          await cancelStaged(dir, req.requestId);
          return { superseded: true };
        }
        if (own && current?.requestId === req.requestId) return { size: Buffer.byteLength(own.value) };
        throw new RunnerError("not_found", "This request has no staged secret");
      }
      if (delivery.action !== "deliver" || delivery.requestId !== req.requestId)
        throw new RunnerError("bad_request", "Invalid staged secret");
      const file = keyFile(dir, req.requestId);
      const privateKey = await readFile(file, "utf8");
      const value = await openSecret(privateKey, delivery.box, delivery.aad);
      const target: Stored["target"] =
        delivery.target.kind === "file" ? { kind: "file", path: delivery.target.path } : { kind: "env" };
      checkAad(delivery.aad, delivery.requestId, delivery.name, target);
      const current = (await readStore(dir)).filter((s) => s.name === delivery.name).at(-1);
      if ((await latestOrder(dir, delivery.name, current ?? undefined)) > req.order) {
        await cancelStaged(dir, req.requestId);
        return { superseded: true };
      }
      let fileTarget: string | null = null;
      if (target.kind === "file") {
        const resolved = await resolveInWorkspace(workspaceReal, target.path);
        if (resolved.rel === "") throw new RunnerError("bad_request", "Can't write a secret over the workspace");
        if (touchesGitInternals(target.path, resolved.abs)) {
          throw new RunnerError("bad_request", "A secret can't be written inside a .git folder");
        }
        target.path = resolved.rel;
        fileTarget = resolved.abs;
      }
      await ensureDir(dir);
      await writeOrder(dir, delivery.name, req.order);
      const before = await readStore(dir);
      const next = before.filter((s) => s.name !== delivery.name);
      next.push({
        name: delivery.name,
        target,
        value,
        deliveredAt: new Date().toISOString(),
        requestId: req.requestId,
        order: req.order,
      });
      // A replacement can move a secret to another file or to the environment.
      // Keep every old file in the store (and therefore in file guards and
      // redaction) until its plaintext has been overwritten or removed.
      const livePaths = new Set(next.flatMap((s) => (s.target.kind === "file" ? [s.target.path] : [])));
      const oldFiles = before.filter((s) => s.name === delivery.name && s.target.kind === "file");
      const filesToRemove = oldFiles.filter((s) => s.target.kind === "file" && !livePaths.has(s.target.path));
      await writeStore(dir, [...oldFiles, ...next]);
      // The DB already guards the file path, and the store records the value
      // before any workspace write that might fail halfway through.
      if (fileTarget) {
        await mkdir(path.dirname(fileTarget), { recursive: true });
        await writeFile(fileTarget, value, { mode: 0o600 });
        await chmod(fileTarget, 0o600).catch(() => undefined);
      }
      if (oldFiles.length > 0) {
        let allRemoved = true;
        for (const old of filesToRemove) {
          if (old.target.kind !== "file") continue;
          try {
            const resolved = await resolveInWorkspace(workspaceReal, old.target.path);
            if (resolved.exists) await rm(resolved.abs, { force: true });
          } catch {
            // Retain the old entry so reads/uploads stay blocked and a later
            // remove or replacement can try the cleanup again.
            allRemoved = false;
          }
        }
        if (allRemoved) await writeStore(dir, next);
      }
      await rm(file, { force: true });
      await rm(staged, { force: true });
      return { size: Buffer.byteLength(value) };
    }
    case "discard":
      await rm(keyFile(dir, req.requestId), { force: true });
      await rm(stagedFile(dir, req.requestId), { force: true });
      return {};
    case "remove": {
      const secrets = await readStore(dir);
      const selected = (s: Stored) =>
        s.name === req.name &&
        (!req.requestIds ||
          (s.requestId !== undefined && req.requestIds.includes(s.requestId)) ||
          (req.throughOrder !== undefined && (s.order ?? "") <= req.throughOrder));
      const gone = secrets.filter(selected);
      const otherPaths = new Set(
        secrets.flatMap((s) => (!selected(s) && s.target.kind === "file" ? [s.target.path] : [])),
      );
      for (const old of gone) {
        if (old.target.kind !== "file" || otherPaths.has(old.target.path)) continue;
        const resolved = await resolveInWorkspace(workspaceReal, old.target.path);
        if (resolved.exists) await rm(resolved.abs, { force: true });
      }
      if (gone.length > 0)
        await writeStore(
          dir,
          secrets.filter((s) => !selected(s)),
        );
      for (const requestId of req.requestIds ?? []) {
        await cancelStaged(dir, requestId);
      }
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
  // One kept before its name was reserved still never reaches the env.
  for (const s of secrets) if (s.target.kind === "env" && !isReservedSecretName(s.name)) env[s.name] = s.value;
  return {
    env,
    files: secrets.flatMap((s) => (s.target.kind === "file" ? [s.target.path] : [])),
    hold: Math.max(0, ...secrets.map((s) => s.value.length - 1)),
    redact: (text: string) => redactSecrets(text, secrets),
  };
}

/** One delivered secret's value by name (the agent browser types it into a password field), or null. */
export async function secretValue(root: string | undefined, agent: AgentScope, name: string): Promise<string | null> {
  if (!root) return null;
  const secrets = await readStore(dirOf(root, agent)).catch(() => [] as Stored[]);
  return secrets.filter((s) => s.name === name).at(-1)?.value ?? null;
}
