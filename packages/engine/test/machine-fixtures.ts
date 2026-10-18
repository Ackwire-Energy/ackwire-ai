import type { PubSub } from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import { confirmDeviceCode, pollDeviceToken, startDeviceCode } from "../src";

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
