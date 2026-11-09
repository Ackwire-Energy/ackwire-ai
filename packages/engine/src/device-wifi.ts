import type { PhonePairFailure, PhonePairing, PhonePairState } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { mayManageDevice } from "./devices";
import { ForbiddenError, NotFoundError } from "./errors";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import { getMachine } from "./machines";
import { requirePermission } from "./organizations";

const { machinePhones } = schema;

/**
 * Pairing an Android phone over Wi-Fi with a connected computer (bring your own devices): the computer's runner shows
 * Android's QR or takes the six-digit code, finds the phone on the network, pairs and connects it; the phone then
 * shows up under that computer like a cabled one. Only who may manage the computer pairs with it: the phone becomes
 * its owner's, on their adb.
 */

/** A pairing as the apps see it; `update`: the computer's agentes.chat is too old to pair over Wi-Fi. */
export interface WifiPairing {
  id: string;
  way: "qr" | "code";
  state: PhonePairState;
  reason?: PhonePairFailure | "update";
  /** Only when it starts: the QR the phone scans. */
  qr?: string;
  /** Connected: the phone's id in `GET …/devices`. */
  phoneId?: string;
  expiresAt: string;
}

const STATES: readonly PhonePairState[] = ["waiting", "pairing", "connecting", "connected", "failed"];
const FAILURES: readonly PhonePairFailure[] = [
  "mdns_off",
  "same_wifi",
  "refused",
  "timed_out",
  "outdated",
  "adb_missing",
  "canceled",
  "failed",
];

type Deps = { db: Database; hub: Pick<MachineCaller, "call"> };

async function pairingHost(db: Database, actorId: string, orgId: string, machineId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const machine = await getMachine(db, orgId, machineId);
  if (!machine || machine.kind === "managed") throw new NotFoundError("Device not found", "device.not_found");
  if (!mayManageDevice(membership, actorId, machine.pairedByUserId)) {
    throw new ForbiddenError("Only the computer's owner or an admin can pair phones with it", "device.forbidden");
  }
  return machine;
}

const failed = (way: "qr" | "code", reason: WifiPairing["reason"]): WifiPairing => ({
  id: "",
  way,
  state: "failed",
  reason,
  expiresAt: new Date().toISOString(),
});

/** The runner's answer, checked; connected only once the phone's row is there (its `phones.changed` landed). */
async function viewOf(db: Database, orgId: string, machineId: string, r: PhonePairing): Promise<WifiPairing> {
  const state = STATES.find((s) => s === r.state) ?? "failed";
  const reason = FAILURES.find((f) => f === r.reason);
  const view: WifiPairing = {
    id: typeof r.id === "string" ? r.id.slice(0, 64) : "",
    way: r.way === "code" ? "code" : "qr",
    state,
    ...(state === "failed" ? { reason: reason ?? "failed" } : {}),
    ...(typeof r.qr === "string" && /^WIFI:T:ADB;S:[\w-]{1,60};P:\w{1,60};;$/.test(r.qr) ? { qr: r.qr } : {}),
    expiresAt: typeof r.expiresAt === "string" && !Number.isNaN(Date.parse(r.expiresAt)) ? r.expiresAt : "",
  };
  if (state !== "connected") return view;
  const serial = typeof r.serial === "string" ? r.serial.slice(0, 200) : "";
  const [phone] = serial
    ? await db
        .select({ id: machinePhones.id })
        .from(machinePhones)
        .where(
          and(
            eq(machinePhones.orgId, orgId),
            eq(machinePhones.machineId, machineId),
            eq(machinePhones.platform, "android"),
            eq(machinePhones.serial, serial),
            isNull(machinePhones.deletedAt),
          ),
        )
    : [];
  return phone ? { ...view, phoneId: phone.id } : { ...view, state: "connecting" };
}

/**
 * A runner from before phones (`unsupported`, from the hub), or from before Wi-Fi pairing: it answers these ops as a
 * phone op naming no phone (`bad_request`). The route checks the address and code as the runner does.
 */
const tooOld = (error: unknown) =>
  error instanceof MachineRequestError && (error.code === "bad_request" || error.code === "unsupported");

/** `POST …/computers/{machineId}/wifi-pairings`: the QR way, or with `address` and `code` the six-digit way. */
export async function startWifiPairing(
  deps: Deps,
  actorId: string,
  orgId: string,
  machineId: string,
  input: { address?: string; code?: string },
): Promise<WifiPairing> {
  const machine = await pairingHost(deps.db, actorId, orgId, machineId);
  const way = input.code !== undefined ? "code" : "qr";
  let reply: PhonePairing;
  try {
    reply =
      way === "code"
        ? await deps.hub.call(machine.id, {
            op: "phone.pair.code",
            address: input.address ?? "",
            code: input.code ?? "",
          })
        : await deps.hub.call(machine.id, { op: "phone.pair.start" });
  } catch (error) {
    if (tooOld(error)) return failed(way, "update");
    if (error instanceof MachineRequestError) return failed(way, "failed");
    throw error;
  }
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "device.wifi_pairing",
    target: { type: "machine", id: machine.id },
    details: { way },
  });
  return viewOf(deps.db, orgId, machine.id, reply);
}

/** `GET …/wifi-pairings/{pairingId}`: where it stands (the QR isn't said again). */
export async function wifiPairingState(
  deps: Deps,
  actorId: string,
  orgId: string,
  machineId: string,
  pairingId: string,
): Promise<WifiPairing> {
  const machine = await pairingHost(deps.db, actorId, orgId, machineId);
  try {
    const reply = await deps.hub.call(machine.id, { op: "phone.pair.status", pairingId });
    const { qr: _qr, ...view } = await viewOf(deps.db, orgId, machine.id, reply);
    return view;
  } catch (error) {
    // The runner restarted in between, or is too old: that pairing is gone.
    if (error instanceof MachineRequestError) return { ...failed("qr", "failed"), id: pairingId };
    throw error;
  }
}

/** `DELETE …/wifi-pairings/{pairingId}`: the dialog closed; a computer gone already stopped it. */
export async function cancelWifiPairing(
  deps: Deps,
  actorId: string,
  orgId: string,
  machineId: string,
  pairingId: string,
): Promise<void> {
  const machine = await pairingHost(deps.db, actorId, orgId, machineId);
  await deps.hub.call(machine.id, { op: "phone.pair.cancel", pairingId }).catch(() => undefined);
}
