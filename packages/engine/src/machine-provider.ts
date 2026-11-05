import {
  type AgentScope,
  type ExecRequest,
  type ExecResult,
  MAX_INLINE_FILE_BYTES,
  policyRefusal,
  type SandboxProvider,
  SECRET_ACTIVATE_PROTOCOL,
  SECRETS_PROTOCOL,
  VAULT_PROTOCOL,
} from "@agenteschat/adapters";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import { MachineOfflineError, MachinePausedError } from "./machines";

/** Provider id of connected machines; their computer id is the machine id. */
export const MACHINE_PROVIDER_ID = "machine";

const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** The workspace's own computer has no owner to ask: what the agent can do instead of `request_folder_access`. */
export const foldersFixedMessage = (name: string) =>
  `Nobody can allow folders on ${name}, the workspace's own computer: work in your folder, read from your home, or copy what you need into your folder with a command.`;

/**
 * A runner's `not_allowed` (protocol 10): the path is outside every folder
 * this agent may use on the machine, or the tool is off there. Points the
 * agent at `request_folder_access` for a folder, where someone can answer it
 * (`managed`: nobody can). The command policy's own (`policyRefusal`) already
 * says where to go and stays as it is.
 */
export function notAllowedMessage(name: string, detail: string, path?: string, managed = false) {
  if (policyRefusal(detail)) return detail;
  if (managed) {
    return `${detail.replace(" (ask for it with request_folder_access)", ".") || "Not allowed on this computer."}${
      path && /^(\/|~|[A-Za-z]:)/.test(path) ? ` ${foldersFixedMessage(name)}` : " Tell the people."
    }`;
  }
  return `${detail || "Not allowed on this computer."} ${
    path && /^(\/|~|[A-Za-z]:)/.test(path)
      ? `${path} is outside the folders you may use on ${name}: ask its owner for it with request_folder_access (path and a short reason), or work inside your own folder.`
      : `On ${name}, only the person at the computer can allow folders or turn tools on: for a folder outside your own, ask with request_folder_access; for a tool that is off, tell the people.`
  }`;
}

/**
 * Runner error codes → what the agent reads (and tells the people). The runner's error stays as the `cause` of the
 * words given, so a caller can still tell where it failed (a Vault key's use, ADR 0144 §4).
 */
function explain(error: unknown, name: string, path?: string, managed = false): Error {
  if (!(error instanceof MachineRequestError)) return error instanceof Error ? error : new Error(String(error));
  const said = (message: string) => new Error(message, { cause: error });
  switch (error.code) {
    case "exec_disabled":
      return said(
        `Commands are turned off on the computer ${name} (its runner was started with --no-exec): you can only read, write, list and upload files there. Tell the person; its owner can restart the runner without --no-exec.`,
      );
    // The runner names what is wrong with the path and what to use instead.
    case "outside_workspace":
    case "not_found":
      return said(error.message);
    case "too_large":
      return said(
        `${path ?? "The file"} is too large to move this way (max ${MB(MAX_INLINE_FILE_BYTES)}); use upload_file to send big files to the Drive.`,
      );
    case "upload_failed":
      return said(`${path ?? "The file"} didn't reach the Drive. ${error.message}`);
    case "not_allowed":
      // The command policy's `never` (a push our git proxy refuses): callers read its code, as below.
      return policyRefusal(error.message) ? error : said(notAllowedMessage(name, error.message, path, managed));
    case "paused":
      return said(
        `The owner paused the computer ${name}: nothing new can start there until they resume it. Tell the people.`,
      );
    case "timeout":
    case "canceled":
      return said(error.message);
    // The command policy held it: its message says why and how to ask a person, and callers read its code.
    case "approval_needed":
      return error;
    default:
      return said(`The computer ${name} failed: ${error.message}`);
  }
}

/**
 * Connected machines as a `SandboxProvider` (ADR 0025): the channel over the hub. A machine is on while its
 * runner is connected; people pair it, and we never create, start or stop it. Files travel base64 up to 5 MB;
 * uploads go through `push`, straight to our upload URL. Every request is for `agent`, which the runner keeps
 * in its own folder of the workspace.
 */
export function createMachineSandboxProvider(hub: MachineCaller, agent: AgentScope): SandboxProvider {
  const guard = async <T>(id: string, fn: () => Promise<T>, path?: string): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof MachineOfflineError || error instanceof MachinePausedError) throw error;
      const status = await hub.status(id);
      throw explain(error, status?.name ?? "computer", path, status?.kind === "managed");
    }
  };
  const execOn = async (
    id: string,
    request: ExecRequest,
    onOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
  ): Promise<ExecResult> =>
    guard(id, async () => {
      const r = await hub.call(
        id,
        {
          agent,
          op: "exec",
          command: request.command,
          ...(request.cwd ? { cwd: request.cwd } : {}),
          timeoutSeconds: request.timeoutSeconds,
          stream: Boolean(onOutput),
          ...(request.approved ? { approved: true } : {}),
          ...(request.mergeRepos?.length ? { mergeRepos: request.mergeRepos } : {}),
          // Vault keys for this one command (ADR 0144), sealed to a one-use key of this computer.
          ...(request.vault ? { vault: request.vault } : {}),
        },
        { signal: request.signal, onOutput },
      );
      return {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        ...(r.canceled ? { canceled: r.canceled } : {}),
        ...(r.merge ? { merge: r.merge } : {}),
      };
    });
  return {
    id: MACHINE_PROVIDER_ID,
    exec: (id, request) => execOn(id, request),
    execStream: (id, request, onOutput) => execOn(id, request, onOutput),
    async writeFile(id, path, data) {
      if (data.byteLength > MAX_INLINE_FILE_BYTES) {
        throw new Error(
          `${path} is too large to copy to a connected computer (max ${MB(MAX_INLINE_FILE_BYTES)}); ask the person to put it on that machine.`,
        );
      }
      await guard(
        id,
        () => hub.call(id, { agent, op: "write", path, base64: Buffer.from(data).toString("base64") }),
        path,
      );
    },
    async readFile(id, path) {
      const r = await guard(id, () => hub.call(id, { agent, op: "read", path, maxBytes: MAX_INLINE_FILE_BYTES }), path);
      return r.base64 === null ? null : new Uint8Array(Buffer.from(r.base64, "base64"));
    },
    async listFiles(id, path, depth = 3) {
      const r = await guard(id, () => hub.call(id, { agent, op: "list", path, depth }), path);
      return r.entries;
    },
    async secret(id, request) {
      const status = await hub.status(id);
      if (status && status.protocol < SECRETS_PROTOCOL) {
        throw new Error(
          `The runner on the computer ${status.name} is too old to keep secrets. Tell the person: its owner should update it with \`agentes-runner update\`.`,
        );
      }
      if (
        status &&
        status.protocol < SECRET_ACTIVATE_PROTOCOL &&
        (request.action === "keypair" || request.action === "deliver" || request.action === "activate")
      ) {
        throw new Error(
          `The runner on the computer ${status.name} is too old for safe secret delivery. Its owner should update it with \`agentes-runner update\`.`,
        );
      }
      try {
        return await hub.call(id, { agent, op: "secret", ...request });
      } catch (error) {
        // The runner's own words ("This request's key is gone…"), not the file-tool wording.
        if (error instanceof MachineRequestError && error.code !== "timeout" && error.code !== "canceled") {
          throw new Error(error.message);
        }
        throw error;
      }
    },
    async pushFile(id, path, target) {
      return guard(
        id,
        () =>
          hub
            .call(id, {
              agent,
              op: "push",
              path,
              url: target.url,
              uploadId: target.uploadId,
              maxBytes: target.maxBytes,
            })
            .catch((error: unknown) => {
              if (!(error instanceof MachineRequestError) || error.code !== "too_large") throw error;
              throw new Error(
                `${path} is over the ${MB(target.maxBytes)} the Drive takes per file, so it stayed on the computer. Make it smaller (a video: re-encode it at a lower resolution or bitrate) or send it in parts under ${MB(target.maxBytes)}, then upload again.`,
                { cause: error },
              );
            }),
        path,
      );
    },
  };
}

/** What a computer too old for the Vault answers (ADR 0144): its owner updates the runner. */
export const vaultUpdateText = (machineName: string, what: string) =>
  `The computer ${machineName} needs an update to ${what}. Its owner can run \`agentes-runner update\`.`;

/** A one-use key on the agent's computer (ADR 0144, protocol 45): a Vault value is sealed to it, never sent bare. */
export type VaultKey = { keyId: string; publicKey: string; expiresAt: string };

/**
 * Asks the agent's runner for a one-use key (`vault.key`): the private key stays in that computer's memory (in the
 * agent's own worker in system mode) for two minutes and one opening. Throws an error the agent reads when the
 * computer is too old (`what` says what for) or refuses.
 */
export async function requestVaultKey(
  hub: MachineCaller,
  machineId: string,
  agent: AgentScope,
  what: string,
  signal?: AbortSignal,
): Promise<VaultKey> {
  const status = await hub.status(machineId);
  const name = status?.name ?? "computer";
  if (!status || status.protocol < VAULT_PROTOCOL) throw new Error(vaultUpdateText(name, what));
  try {
    const reply = await hub.call<"vault.key">(machineId, { agent, op: "vault.key" }, { signal, timeoutMs: 30_000 });
    const key = reply?.vaultKey;
    if (!key?.keyId || !key.publicKey) throw new Error(`The computer ${name} made no key for the Vault.`);
    return { keyId: key.keyId, publicKey: key.publicKey, expiresAt: key.expiresAt };
  } catch (error) {
    if (error instanceof MachineOfflineError || error instanceof MachinePausedError) throw error;
    throw explain(error, name);
  }
}
