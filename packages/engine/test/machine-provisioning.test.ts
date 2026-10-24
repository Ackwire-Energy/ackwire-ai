import { afterEach, describe, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, orgTopic, type ServerFrame } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  agentComputerInfo,
  computerSetup,
  createAgent,
  createMachineHub,
  createOrganization,
  DEVICE_CODE_TTL_MS,
  deleteMachine,
  ForbiddenError,
  issueManagedMachine,
  listMachineRequests,
  listMachines,
  type MachineHub,
  OrgPausedError,
  pollDeviceToken,
  revokeManagedMachine,
  setAgentComputerTarget,
  setOrgStanding,
  setProvisioning,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

/**
 * The workspace's own computer from an external provisioner (ADR 0056 §10): the requests it lists, the
 * code it issues, and what the computer's first hello does.
 */

let f: Fixture;
let hub: MachineHub | null = null;
afterEach(async () => {
  await hub?.stop();
  hub = null;
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const page = (mode: "off" | "external" = "external", query: { limit?: number; cursor?: string } = {}) =>
  listMachineRequests(f.db, mode, { limit: 50, ...query });
const requested = async () => (await page()).requests.map((r) => r.orgName);
const machineRow = async (id: string) => {
  const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, id));
  if (!row) throw new Error("no machine");
  return row;
};
const agentMachine = async (agentId: string) => {
  const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  return row?.machineId ?? null;
};

/** The provisioner's flow up to the token: issue a code, the computer redeems it. */
async function enrolled(orgId = f.org.id) {
  const issued = await issueManagedMachine(deps(), orgId);
  if (!issued) throw new Error("no org");
  const token = await pollDeviceToken(deps(), issued.enrollCode);
  if (!token.ok) throw new Error(`enroll failed: ${token.error}`);
  return { machineId: issued.machineId, token: token.token };
}

/** A runner saying hello over an in-memory socket. */
async function hello(token: string) {
  hub ??= createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  const sent: ServerFrame[] = [];
  let closed: string | undefined;
  const conn = hub.open({
    send: (text) => void sent.push(JSON.parse(text) as ServerFrame),
    close: (_code, reason) => {
      closed = reason;
    },
  });
  await hub.message(
    conn,
    JSON.stringify({
      type: "hello",
      token,
      hostname: "vm-7f3a",
      os: "linux",
      arch: "x64",
      version: "1.0.0",
      protocol: MACHINE_PROTOCOL_VERSION,
      workspace: "/var/lib/agentes-runner/work",
      exec: true,
    }),
  );
  const current = hub;
  return { sent, closed: () => closed, disconnect: () => current.close(conn) };
}

/** Org broadcasts of these types, as members would hear them. */
function heard(...types: string[]) {
  const events: Record<string, unknown>[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
    const event = (e as { event?: Record<string, unknown> }).event;
    if (e.type === "org.broadcast" && event && types.includes(String(event.type))) events.push(event);
  });
  return events;
}

describe("external provisioning", () => {
  test("the requests list: only with the flag, active workspaces whose computer isn't ready, oldest first", async () => {
    f = await setup();
    expect(await page("off")).toEqual({ requests: [], next: null });
    const held = await createOrganization(f.db, (await addUser(f.db, "bia")).id, { name: "Held" });
    const later = await createOrganization(f.db, (await addUser(f.db, "caio")).id, { name: "Later" });
    expect(await requested()).toEqual(["Acme", "Held", "Later"]);
    const [first] = (await page()).requests;
    expect(first).toEqual({
      orgId: f.org.id,
      orgName: "Acme",
      createdAt: expect.any(Date),
      owner: { userId: f.owner.id, email: f.owner.email },
      provisioning: null,
    });

    await setOrgStanding(deps(), held.organization.id, { state: "hold", reason: "Review", notice: "silent" });
    expect(await requested()).toEqual(["Acme", "Later"]);

    expect(await setProvisioning(deps(), later.organization.id, { state: "waiting", reason: "approval" })).toBe(true);
    const one = await page("external", { limit: 1 });
    expect(one.requests.map((r) => r.orgName)).toEqual(["Acme"]);
    const two = await page("external", { limit: 1, cursor: one.next ?? "" });
    expect(two.requests).toEqual([
      expect.objectContaining({
        orgName: "Later",
        provisioning: {
          state: "waiting",
          step: null,
          reason: "approval",
          since: expect.any(String),
          etaSeconds: null,
          specs: null,
        },
      }),
    ]);
    expect(two.next).toBeNull();

    // Ready: no longer a request.
    await hello((await enrolled()).token);
    expect(await requested()).toEqual(["Later"]);
  });

  test("progress: since restarts only on a new state or step; ready is refused until the computer is removed", async () => {
    f = await setup();
    const events = heard("machine.provisioning");
    const status = () => computerSetup(f.db, "external", f.owner.id, f.org.id);
    expect(await status()).toEqual({
      mode: "external",
      state: "preparing",
      step: null,
      reason: null,
      since: null,
      etaSeconds: null,
      specs: null,
      machineId: null,
    });
    expect((await computerSetup(f.db, "off", f.owner.id, f.org.id)).mode).toBe("pair");

    const specs = { cpus: 4, memoryGb: 8, diskGb: 75 };
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "reserving", etaSeconds: 900, specs });
    const reserving = await status();
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "reserving", etaSeconds: 900 });
    expect(await status()).toEqual(reserving);
    expect(events).toHaveLength(1);
    await Bun.sleep(5);
    // A reason only goes with `waiting`.
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "installing", reason: "capacity" });
    const installing = await status();
    expect(installing).toMatchObject({ state: "preparing", step: "installing", reason: null, etaSeconds: null, specs });
    expect(installing.since).not.toBe(reserving.since);
    expect(events.at(-1)).toMatchObject({ type: "machine.provisioning", step: "installing", specs });
    expect(await setProvisioning(deps(), crypto.randomUUID(), { state: "problem" })).toBe(false);

    const { machineId, token } = await enrolled();
    await hello(token);
    expect(await status()).toMatchObject({ state: "ready", step: null, machineId });
    await expect(setProvisioning(deps(), f.org.id, { state: "problem" })).rejects.toMatchObject({
      code: "provisioning.ready",
    });

    expect(await revokeManagedMachine(deps(), f.org.id, machineId)).toBe(true);
    expect(await status()).toMatchObject({ state: "preparing", since: null, machineId: null });
    expect(events.at(-1)).toMatchObject({ type: "machine.provisioning", state: "preparing", machineId: null });
    expect(await setProvisioning(deps(), f.org.id, { state: "problem" })).toBe(true);
  });

  test("issuing is idempotent per workspace: one managed row, a new code each time, the old one dead", async () => {
    f = await setup();
    const first = await issueManagedMachine(deps(), f.org.id);
    const second = await issueManagedMachine(deps(), f.org.id, { name: "Computador da Acme" });
    if (!first || !second) throw new Error("no org");
    expect(second.machineId).toBe(first.machineId);
    expect(second.enrollCode).not.toBe(first.enrollCode);
    expect(second.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(DEVICE_CODE_TTL_MS);
    const managed = await f.db
      .select()
      .from(schema.machines)
      .where(and(eq(schema.machines.orgId, f.org.id), eq(schema.machines.kind, "managed")));
    expect(managed.map((m) => [m.name, m.tokenHash, m.pairedByUserId])).toEqual([["Computador da Acme", null, null]]);
    expect(await issueManagedMachine(deps(), crypto.randomUUID())).toBeNull();

    expect(await pollDeviceToken(deps(), first.enrollCode)).toEqual({ ok: false, error: "access_denied" });
    const redeemed = await pollDeviceToken(deps(), second.enrollCode);
    expect(redeemed).toMatchObject({ ok: true, machineId: first.machineId, org: { id: f.org.id, name: "Acme" } });
    expect(await pollDeviceToken(deps(), second.enrollCode)).toEqual({ ok: false, error: "expired_token" });
    const [audit] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "machine.paired")));
    expect(audit).toMatchObject({ actorType: "system", actorId: null, targetId: first.machineId });

    // Not for a workspace on hold.
    await setOrgStanding(deps(), f.org.id, { state: "hold", reason: "Review", notice: "shown" });
    await expect(issueManagedMachine(deps(), f.org.id)).rejects.toBeInstanceOf(OrgPausedError);
  });

  test("an issued code that expires leaves the managed row; a new code still connects it", async () => {
    f = await setup();
    const issued = await issueManagedMachine(deps(), f.org.id);
    if (!issued) throw new Error("no org");
    const late = new Date(Date.now() + DEVICE_CODE_TTL_MS + 1000);
    expect(await pollDeviceToken({ ...deps(), now: () => late }, issued.enrollCode)).toEqual({
      ok: false,
      error: "expired_token",
    });
    expect((await machineRow(issued.machineId)).deletedAt).toBeNull();
    const { machineId } = await enrolled();
    expect(machineId).toBe(issued.machineId);
  });

  test("the first hello makes it ready and gives it the agents with no computer, once", async () => {
    f = await setup();
    const events = heard("machine.provisioning", "agent.computer");
    // Created while it is being prepared: no computer yet, and the agent says it is on its way.
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "installing" });
    const early = await createAgent(f.db, f.owner.id, f.org.id, { name: "Ops", handle: "ops" }, { model: "auto" });
    expect(early.machineId).toBeNull();
    expect(await agentComputerInfo({ db: f.db, provider: null }, f.org.id, early.id)).toEqual({
      kind: "cloud",
      available: false,
      preparing: true,
    });

    const { machineId, token } = await enrolled();
    const runner = await hello(token);
    expect(runner.sent[0]).toMatchObject({ type: "welcome", machineId });
    expect(await agentMachine(f.agent.id)).toBe(machineId);
    expect(await agentMachine(early.id)).toBe(machineId);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: "machine.provisioning",
          state: "ready",
          step: null,
          reason: null,
          since: expect.any(String),
          etaSeconds: null,
          specs: null,
          machineId,
        },
        {
          type: "agent.computer",
          agentId: f.agent.id,
          target: { kind: "machine", machineId, name: "Acme", online: true },
        },
      ]),
    );
    expect(runner.sent.find((s) => s.type === "agents")).toMatchObject({
      agents: expect.arrayContaining([expect.objectContaining({ id: early.id })]),
    });
    const told = await f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "computer_ready"));
    expect(told.map((n) => [n.userId, n.source])).toEqual([[f.owner.id, { machineId, label: "Acme" }]]);

    // Someone takes an agent off it; a reconnect leaves that choice alone and tells nobody again.
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, early.id, null);
    await runner.disconnect();
    const count = events.length;
    await hello(token);
    expect(await agentMachine(early.id)).toBeNull();
    expect(events.length).toBe(count);
    expect(
      await f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "computer_ready")),
    ).toHaveLength(1);

    // New agents are born on it.
    const later = await createAgent(f.db, f.owner.id, f.org.id, { name: "Later", handle: "later" }, { model: "auto" });
    expect(later.machineId).toBe(machineId);
  });

  test("people see it without its insides and can't remove it; the provisioner can", async () => {
    f = await setup();
    const admin = await addMember(f.db, f.org.id, "admin");
    const member = await addMember(f.db, f.org.id, "member");
    const { machineId, token } = await enrolled();
    const runner = await hello(token);
    const [view] = await listMachines(f.db, member.id, f.org.id);
    expect(view).toMatchObject({
      id: machineId,
      kind: "managed",
      hostname: "",
      os: "other",
      arch: "",
      workspace: null,
    });
    expect((await listMachines(f.db, admin.id, f.org.id))[0]).toMatchObject({ hostname: "", workspace: null });

    for (const who of [f.owner.id, admin.id]) {
      const refused = await deleteMachine(deps(), who, f.org.id, machineId).catch((e) => e);
      expect(refused).toBeInstanceOf(ForbiddenError);
      expect(refused).toMatchObject({ code: "machine.managed" });
    }
    // Nobody paired it: an agent's owner may put their agent back on it.
    const own = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Mine", handle: "mine", ownerUserId: member.id },
      { model: "auto" },
    );
    await setAgentComputerTarget(deps(), member.id, f.org.id, own.id, null);
    expect(await setAgentComputerTarget(deps(), member.id, f.org.id, own.id, machineId)).toMatchObject({ machineId });

    expect(await revokeManagedMachine(deps(), crypto.randomUUID(), machineId)).toBe(false);
    expect(await revokeManagedMachine(deps(), f.org.id, machineId)).toBe(true);
    await Bun.sleep(1);
    expect(runner.closed()).toBe("revoked");
    expect((await machineRow(machineId)).deletedAt).not.toBeNull();
    expect(await agentMachine(f.agent.id)).toBeNull();
    expect(await requested()).toEqual(["Acme"]);
    expect(await revokeManagedMachine(deps(), f.org.id, machineId)).toBe(false);

    // Issued again: the same row comes back, ready again on its next first hello.
    const again = await enrolled();
    expect(again.machineId).toBe(machineId);
    await hello(again.token);
    expect(await agentMachine(f.agent.id)).toBe(machineId);
  });
});
