import {
  type AgentScope,
  type ExecRequest,
  type ExecResult,
  MAX_INLINE_FILE_BYTES,
  type SandboxInfo,
  type SandboxProvider,
  SandboxProviderError,
} from "@agenteschat/adapters";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import { MachineOfflineError } from "./machines";

/** Provider id of connected machines; their computer id is the machine id. */
export const MACHINE_PROVIDER_ID = "machine";

const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

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
    case "timeout":
    case "canceled":
      return new Error(error.message);
    default:
      return new Error(`The computer ${name} failed: ${error.message}`);
  }
}

/**
 * Connected machines as a `SandboxProvider` (ADR 0025): no lifecycle (a
 * machine is on while its runner is connected; we never create, start or
 * stop it) and a channel over the hub. Files travel base64 up to 5 MB;
 * uploads go through `push`, straight to our upload URL. Every request is
 * for `agent`, which the runner keeps in its own folder of the workspace.
 */
export function createMachineSandboxProvider(hub: MachineCaller, agent: AgentScope): SandboxProvider {
  const nameOf = async (id: string) => (await hub.status(id))?.name ?? "computer";
  const guard = async <T>(id: string, fn: () => Promise<T>, path?: string): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof MachineOfflineError) throw error;
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
  const info = (id: string, online: boolean): SandboxInfo => ({
    id,
    state: online ? "started" : "stopped",
    resources: { cpu: 0, memoryGiB: 0, diskGiB: 0 },
    network: "provider-default",
  });
  return {
    id: MACHINE_PROVIDER_ID,
    async create() {
      throw new SandboxProviderError("connected computers are paired by people, not created");
    },
    async get(id) {
      const s = await hub.status(id);
      return s ? info(id, s.online) : null;
    },
    async ensureStarted(id) {
      const s = await hub.status(id);
      if (!s?.online) throw new MachineOfflineError(s?.name ?? "computer");
      return info(id, true);
    },
    async stop() {},
    async destroy() {},
    async setNetwork() {
      return "provider-default";
    },
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
