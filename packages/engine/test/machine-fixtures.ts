import { createHash } from "node:crypto";
import {
  generateSecretKeyPair,
  MACHINE_PROTOCOL_VERSION,
  openSecret,
  type PubSub,
  type ServerFrame,
} from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import {
  confirmDeviceCode,
  grantScopes,
  type MachineHub,
  pollDeviceToken,
  setAgentComputerTarget,
  startDeviceCode,
} from "../src";
import type { Fixture } from "./fixtures";

export interface PairInput {
  name?: string;
  hostname?: string;
  os?: string;
  arch?: string;
  version?: string;
  protocol?: number;
  workspace?: string;
  exec?: boolean;
}

/**
 * Connects a computer the way the device-code flow does (ADR 0036 §5): the
 * computer asks for a code, `actorId` confirms it for `orgId`, the computer
 * polls for its token. Returns what the old pairing returned.
 */
export async function pairMachine(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  input: PairInput = {},
) {
  const start = await startDeviceCode(
    { db: deps.db, publicUrl: "https://agentes.chat" },
    {
      name: input.name ?? "",
      os: input.os ?? "linux",
      arch: input.arch ?? "x64",
      hostname: input.hostname ?? "box",
      version: input.version ?? "0.1.0",
      ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
      ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
      ...(input.exec !== undefined ? { exec: input.exec } : {}),
    },
    // Each test pairing from its own address: the per-address cap never gets in the way.
    { ip: `198.51.100.${Math.floor(Math.random() * 250)}:${crypto.randomUUID()}` },
  );
  await confirmDeviceCode(deps, actorId, orgId, start.userCode, { name: input.name });
  const token = await pollDeviceToken(deps, start.deviceCode);
  if (!token.ok) throw new Error(`pairing failed: ${token.error}`);
  return { machineId: token.machineId, name: token.name, token: token.token };
}

export const RUNNER = {
  hostname: "box",
  os: "linux",
  arch: "x64",
  version: "0.1.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/home/u/agentes",
};

type Request = Extract<ServerFrame, { type: "request" }>;

export interface FakeRunnerOptions {
  exec?: (
    req: Extract<Request, { op: "exec" }>,
    out: (stream: "stdout" | "stderr", chunk: string) => void,
  ) => { exitCode: number; stdout: string; stderr: string; timedOut?: boolean } | "hang";
  push?: (req: Extract<Request, { op: "push" }>, bytes: Uint8Array, name: string) => Promise<void>;
  execAllowed?: boolean;
  /** A socket whose close never reaches the hub (a runner killed behind a proxy: half-open). */
  dead?: boolean;
}

/**
 * A runner over an in-memory socket: files in a map, commands answered by
 * `exec`, uploads handed to `push`. Replies come on a later tick, like a network.
 */
export function fakeRunner(hub: MachineHub, options: FakeRunnerOptions = {}) {
  const sent: ServerFrame[] = [];
  const files = new Map<string, Uint8Array>();
  /** Like the real runner: private keys per request, opened values per name. */
  const keys = new Map<string, string>();
  const secrets = new Map<string, string>();
  let closed: { code?: number; reason?: string } | null = null;
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const handle = async (req: Request) => {
    const ok = (data: unknown) => reply({ type: "result", id: req.id, ok: true, data });
    const fail = (code: string, message: string) =>
      reply({ type: "result", id: req.id, ok: false, error: { code, message } });
    switch (req.op) {
      case "secret": {
        if (req.action === "keypair") {
          const pair = await generateSecretKeyPair();
          keys.set(req.requestId, pair.privateKey);
          return ok({ publicKey: pair.publicKey });
        }
        if (req.action === "deliver") {
          const key = keys.get(req.requestId);
          if (!key) return fail("not_found", "This request's key is gone");
          const value = await openSecret(key, req.box, req.aad).catch(() => null);
          if (value === null) return fail("bad_request", "The secret couldn't be opened");
          keys.delete(req.requestId);
          secrets.set(req.name, value);
          return ok({ size: Buffer.byteLength(value) });
        }
        if (req.action === "discard") keys.delete(req.requestId);
        if (req.action === "remove") secrets.delete(req.name);
        return ok({});
      }
      case "exec": {
        if (options.execAllowed === false) return fail("exec_disabled", "commands are off");
        const r = options.exec?.(req, (stream, chunk) => void reply({ type: "output", id: req.id, stream, chunk })) ?? {
          exitCode: 0,
          stdout: `ran: ${req.command}`,
          stderr: "",
        };
        if (r === "hang") return; // answers only to `cancel`
        return ok({ timedOut: false, ...r });
      }
      case "write":
        files.set(req.path, new Uint8Array(Buffer.from(req.base64, "base64")));
        return ok({ size: files.get(req.path)?.byteLength });
      case "read": {
        const data = files.get(req.path);
        return ok({ base64: data ? Buffer.from(data).toString("base64") : null, size: data?.byteLength ?? 0 });
      }
      case "list":
        return ok({ entries: [...files.entries()].map(([path, d]) => ({ path, isDir: false, size: d.byteLength })) });
      case "push": {
        const data = files.get(req.path);
        if (!data) return fail("not_found", `no ${req.path}`);
        const name = req.path.split("/").at(-1) ?? req.path;
        await options.push?.(req, data, name);
        return ok({
          name,
          size: data.byteLength,
          sha256: createHash("sha256").update(data).digest("hex"),
          contentType: "",
        });
      }
    }
  };
  const socket = {
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      sent.push(frame);
      if (frame.type === "request") setTimeout(() => void handle(frame), 1);
      if (frame.type === "cancel") {
        setTimeout(
          () =>
            void reply({
              type: "result",
              id: frame.id,
              ok: true,
              data: { exitCode: 130, stdout: "", stderr: "", timedOut: false, canceled: { killed: true } },
            }),
          1,
        );
      }
    },
    close(code?: number, reason?: string) {
      closed = { code, reason };
      if (!options.dead) void hub.close(conn);
    },
  };
  const conn = hub.open(socket);
  return {
    conn,
    sent,
    files,
    keys,
    secrets,
    closed: () => closed,
    hello: (token: string, extra: Record<string, unknown> = {}) =>
      hub.message(
        conn,
        JSON.stringify({ type: "hello", token, ...RUNNER, exec: options.execAllowed !== false, ...extra }),
      ),
    disconnect: () => hub.close(conn),
    /** Sends a frame as this runner. */
    frame: (frame: Record<string, unknown>) => reply(frame),
  };
}

/** A connected computer for `f`'s agent: paired, `sandbox:run` granted, the agent on it, its runner said hello. */
export async function connectedComputer(f: Fixture, options: FakeRunnerOptions = {}, name = "Build box") {
  const deps = { db: f.db, pubsub: f.pubsub };
  const paired = await pairMachine(deps, f.owner.id, f.org.id, {
    name,
    ...RUNNER,
    exec: options.execAllowed !== false,
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "sandbox:run" }]);
  await setAgentComputerTarget(deps, f.owner.id, f.org.id, f.agent.id, paired.machineId);
  const runner = fakeRunner(f.machineHub as MachineHub, options);
  await runner.hello(paired.token);
  return { paired, runner };
}
