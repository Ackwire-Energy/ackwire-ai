import {
  type AgentScope,
  type ExecRequest,
  type ExecResult,
  MAX_INLINE_FILE_BYTES,
  type SandboxProvider,
  SECRET_ACTIVATE_PROTOCOL,
  SECRETS_PROTOCOL,
} from "@agenteschat/adapters";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import { MachineOfflineError, MachinePausedError } from "./machines";

/** Provider id of connected machines; their computer id is the machine id. */
export const MACHINE_PROVIDER_ID = "machine";

const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/**
 * A runner's `not_allowed` (protocol 10): the path is outside every folder
 * this agent may use on the machine, or the tool is off there. Points the
 * agent at `request_folder_access` for a folder.
 */
export function notAllowedMessage(name: string, detail: string, path?: string) {
  return `${detail || "Not allowed on this computer."} ${
    path && /^(\/|~|[A-Za-z]:)/.test(path)
      ? `${path} is outside the folders you may use on ${name}: ask its owner for it with request_folder_access (path and a short reason), or work inside your own folder.`
      : `On ${name}, only the person at the computer can allow folders or turn tools on: for a folder outside your own, ask with request_folder_access; for a tool that is off, tell the people.`
  }`;
}

/** Runner error codes → what the agent reads (and tells the people). */
function explain(error: unknown, name: string, path?: string): Error {
  if (!(error instanceof MachineRequestError)) return error instanceof Error ? error : new Error(String(error));
  switch (error.code) {
    case "exec_disabled":
      return new Error(
        `Commands are turned off on the computer ${name} (its runner was started with --no-exec): you can only read, write, list and upload files there. Tell the person; its owner can restart the runner without --no-exec.`,
      );
    case "outside_workspace":
      return new Error(
        `${path ?? "That path"} is outside the computer's workspace folder (or a link that leaves it); use paths inside the workspace.`,
      );
    case "too_large":
      return new Error(
        `${path ?? "The file"} is too large to move this way (max ${MB(MAX_INLINE_FILE_BYTES)}); use upload_file to send big files to the Drive.`,
      );
    case "not_found":
      return new Error(`No file or folder ${path ?? ""} on ${name}.`.replace("  ", " "));
    case "not_allowed":
      return new Error(notAllowedMessage(name, error.message, path));
    case "paused":
      return new Error(
        `The owner paused the computer ${name}: nothing new can start there until they resume it. Tell the people.`,
      );
    case "timeout":
    case "canceled":
      return new Error(error.message);
    // The command policy held it: its message says why and how to ask a person, and callers read its code.
    case "approval_needed":
      return error;
    default:
      return new Error(`The computer ${name} failed: ${error.message}`);
  }
}

/**
 * Connected machines as a `SandboxProvider` (ADR 0025): the channel over the hub. A machine is on while its
 * runner is connected; people pair it, and we never create, start or stop it. Files travel base64 up to 5 MB;
 * uploads go through `push`, straight to our upload URL. Every request is for `agent`, which the runner keeps
 * in its own folder of the workspace.
 */
export function createMachineSandboxProvider(hub: MachineCaller, agent: AgentScope): SandboxProvider {
  const nameOf = async (id: string) => (await hub.status(id))?.name ?? "computer";
  const guard = async <T>(id: string, fn: () => Promise<T>, path?: string): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof MachineOfflineError || error instanceof MachinePausedError) throw error;
      throw explain(error, await nameOf(id), path);
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
        },
        { signal: request.signal, onOutput },
      );
      return {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        ...(r.canceled ? { canceled: r.canceled } : {}),
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
          hub.call(id, {
            agent,
            op: "push",
            path,
            url: target.url,
            uploadId: target.uploadId,
            maxBytes: target.maxBytes,
          }),
        path,
      );
    },
  };
}
