import { afterEach, describe, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, orgTopic, type ServerFrame } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
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
  type MachineHubDeps,
  OrgPausedError,
  pollDeviceToken,
  reduceMachineAccess,
  renameMachine,
  revokeManagedMachine,
  setAgentComputerTarget,
  setOrgStanding,
  setProvisioning,
  updateOrganization,
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

/** A runner saying hello over an in-memory socket (on a server that sends email with `readyEmail`). */
async function hello(token: string, readyEmail: MachineHubDeps["readyEmail"] = null) {
  hub ??= createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a", readyEmail });
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

    // `approval`, from an older provisioner, reads as capacity: there is no approval step.
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
          stage: null,
          reason: "capacity",
          since: expect.any(String),
          requestedAt: later.organization.createdAt.toISOString(),
          expectedReadyAt: null,
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
      stage: null,
      reason: null,
      since: null,
      requestedAt: f.org.createdAt.toISOString(),
      expectedReadyAt: null,
      specs: null,
      secondsLeft: null,
      secondsWaited: expect.any(Number),
      notifyByEmail: false,
      machineId: null,
    });
    expect((await computerSetup(f.db, "off", f.owner.id, f.org.id)).mode).toBe("pair");

    const specs = { cpus: 4, memoryGb: 8, diskGb: 75 };
    const at = new Date(Date.now() + 900_000);
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "reserving", expectedReadyAt: at, specs });
    const reserving = await status();
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "reserving", expectedReadyAt: at });
    expect(await status()).toEqual({ ...reserving, secondsLeft: expect.any(Number) });
    expect(events).toHaveLength(1);
    await Bun.sleep(5);
    // A reason only goes with `waiting`.
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "installing", reason: "capacity" });
    const installing = await status();
    expect(installing).toMatchObject({
      state: "preparing",
      step: "installing",
      reason: null,
      expectedReadyAt: null,
      secondsLeft: null,
      specs,
    });
    expect(installing.since).not.toBe(reserving.since);
    expect(events.at(-1)).toMatchObject({ type: "machine.provisioning", step: "installing", specs });
    expect(await setProvisioning(deps(), crypto.randomUUID(), { state: "problem" })).toBe(false);

    const { machineId, token } = await enrolled();
    await hello(token);
    expect(await status()).toMatchObject({ state: "ready", step: null, machineId });
    await expect(setProvisioning(deps(), f.org.id, { state: "problem" })).rejects.toMatchObject({
      code: "provisioning.ready",
    });

    // Removed: waiting again from now, with nothing reported yet.
    const revokedAt = Date.now();
    expect(await revokeManagedMachine(deps(), f.org.id, machineId)).toBe(true);
    const waiting = await status();
    expect(waiting).toMatchObject({
      state: "preparing",
      step: null,
      specs: null,
      expectedReadyAt: null,
      machineId: null,
    });
    expect(Date.parse(waiting.requestedAt ?? "")).toBeGreaterThanOrEqual(revokedAt);
    expect(waiting.since).toBe(waiting.requestedAt);
    expect(events.at(-1)).toMatchObject({
      type: "machine.provisioning",
      state: "preparing",
      requestedAt: waiting.requestedAt,
      machineId: null,
    });
    expect(await requested()).toEqual(["Acme"]);
    expect(await setProvisioning(deps(), f.org.id, { state: "problem" })).toBe(true);
    // Every later report keeps when the wait began.
    expect((await status()).requestedAt).toBe(waiting.requestedAt);
  });

  test("the stage within a step: kept with preparing only, any word, heard when it changes, since kept", async () => {
    f = await setup();
    const events = heard("machine.provisioning");
    const status = () => computerSetup(f.db, "external", f.owner.id, f.org.id);
    const at = new Date(Date.now() + 600_000);
    const report = (stage?: string) =>
      setProvisioning(deps(), f.org.id, { state: "preparing", step: "installing", stage, expectedReadyAt: at });

    await report("updating");
    const updating = await status();
    expect(updating).toMatchObject({ step: "installing", stage: "updating" });
    expect(events.at(-1)).toMatchObject({ step: "installing", stage: "updating" });
    const listed = (await page()).requests.find((r) => r.orgId === f.org.id);
    expect(listed?.provisioning).toMatchObject({ step: "installing", stage: "updating" });
    // The same report again says nothing new.
    await report("updating");
    expect(events).toHaveLength(1);
    // The restart the update needs: its people hear it, and the step it is in began when it did.
    await Bun.sleep(5);
    await report("restarting");
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ step: "installing", stage: "restarting" });
    expect((await status()).since).toBe(updating.since);
    // A word this server has no use for is kept as said: the apps read it as its step.
    await report("defragmenting");
    expect((await status()).stage).toBe("defragmenting");
    // A report without one has none, and only `preparing` has one.
    await report();
    expect((await status()).stage).toBeNull();
    expect(events.at(-1)).toMatchObject({ stage: null });
    await report("apps");
    await setProvisioning(deps(), f.org.id, { state: "waiting", reason: "capacity", stage: "apps" });
    expect(await status()).toMatchObject({ state: "waiting", stage: null });

    // Ready, then taken away: no stage left over.
    await report("finishing");
    const { machineId, token } = await enrolled();
    await hello(token);
    expect(await status()).toMatchObject({ state: "ready", stage: null });
    await revokeManagedMachine(deps(), f.org.id, machineId);
    expect(await status()).toMatchObject({ state: "preparing", step: null, stage: null });
  });

  test("the ready time: past times keep the first, the seconds left come from the server, older words still read", async () => {
    f = await setup();
    const events = heard("machine.provisioning");
    const status = () => computerSetup(f.db, "external", f.owner.id, f.org.id, true);
    const report = (expectedReadyAt?: Date, etaSeconds?: number) =>
      setProvisioning({ ...deps(), emails: true }, f.org.id, {
        state: "preparing",
        step: "installing",
        expectedReadyAt,
        etaSeconds,
      });

    const sixMinutes = new Date(Date.now() + 360_000);
    await report(sixMinutes);
    const first = await status();
    expect(first).toMatchObject({ expectedReadyAt: sixMinutes.toISOString(), notifyByEmail: true });
    expect(first.secondsLeft).toBeGreaterThan(350);
    expect(first.secondsLeft).toBeLessThanOrEqual(360);
    expect(events.at(-1)).toMatchObject({ expectedReadyAt: sixMinutes.toISOString(), notifyByEmail: true });
    // How long it has waited, counted here as well: the workspace was made two minutes ago.
    await f.db
      .update(schema.organizations)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(schema.organizations.id, f.org.id));
    const waited = (await status()).secondsWaited ?? 0;
    expect(waited).toBeGreaterThanOrEqual(120);
    expect(waited).toBeLessThan(130);

    // It runs over: the provisioner sends "now" again and again; the first time past stays, so the wait shows late.
    const overdue = new Date(Date.now() - 90_000);
    await report(overdue);
    const heardBefore = events.length;
    await report(new Date());
    await report(new Date(Date.now() - 1000));
    expect(await status()).toMatchObject({ expectedReadyAt: overdue.toISOString() });
    expect((await status()).secondsLeft).toBeLessThanOrEqual(-90);
    // The provisioner's clock a little ahead of this one: its "now" arrives seconds in the future, and still is now.
    await report(new Date(Date.now() + 10_000));
    expect(await status()).toMatchObject({ expectedReadyAt: overdue.toISOString() });
    expect(events.length).toBe(heardBefore);
    // A time ahead replaces it.
    const soon = new Date(Date.now() + 30_000);
    await report(soon);
    expect((await status()).expectedReadyAt).toBe(soon.toISOString());
    const later = new Date(Date.now() + 120_000);
    await report(later);
    expect((await status()).expectedReadyAt).toBe(later.toISOString());

    // An older provisioner's countdown is a time from now.
    const sent = Date.now();
    await report(undefined, 600);
    const eta = Date.parse((await status()).expectedReadyAt ?? "");
    expect(eta).toBeGreaterThanOrEqual(sent + 600_000);
    expect(eta).toBeLessThanOrEqual(Date.now() + 600_000);

    // Only `preparing` has a time.
    await setProvisioning(deps(), f.org.id, { state: "waiting", reason: "capacity", expectedReadyAt: later });
    expect(await status()).toMatchObject({
      state: "waiting",
      reason: "capacity",
      expectedReadyAt: null,
      secondsLeft: null,
    });

    // A row an older provisioner left says `approval`: it reads as capacity, and the same report keeps `since`.
    await f.db
      .update(schema.machineProvisioning)
      .set({ reason: "approval" })
      .where(eq(schema.machineProvisioning.orgId, f.org.id));
    const since = (await status()).since;
    expect((await status()).reason).toBe("capacity");
    await setProvisioning(deps(), f.org.id, { state: "waiting", reason: "capacity" });
    expect((await status()).since).toBe(since);
  });

  test("the ready email is promised by a ready time over a minute ahead, waiting or a problem, until it is ready", async () => {
    f = await setup();
    const promised = async (orgId = f.org.id) => {
      const [row] = await f.db
        .select()
        .from(schema.machineProvisioning)
        .where(eq(schema.machineProvisioning.orgId, orgId));
      return row?.emailWhenReady;
    };
    const preparing = (seconds: number) =>
      setProvisioning(deps(), f.org.id, {
        state: "preparing",
        step: "starting",
        expectedReadyAt: new Date(Date.now() + seconds * 1000),
      });
    await preparing(30);
    expect(await promised()).toBe(false);
    await preparing(90);
    expect(await promised()).toBe(true);
    // Told once, kept: a later, shorter estimate doesn't take it back.
    await preparing(10);
    expect(await promised()).toBe(true);
    for (const state of ["waiting", "problem"] as const) {
      const other = await createOrganization(f.db, (await addUser(f.db, state)).id, { name: state });
      await setProvisioning(deps(), other.organization.id, { state });
      expect(await promised(other.organization.id)).toBe(true);
    }
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

  test("its name says a computer, in its first owner's language, and follows the workspace's until renamed", async () => {
    f = await setup();
    const issued = await issueManagedMachine(deps(), f.org.id);
    if (!issued) throw new Error("no org");
    const name = async (id = issued.machineId) => (await machineRow(id)).name;
    expect(await name()).toBe("Computador da Acme");
    await updateOrganization(f.db, f.owner.id, f.org.id, { name: "Acme Labs" });
    expect(await name()).toBe("Computador da Acme Labs");
    await updateOrganization(f.db, f.owner.id, f.org.id, { context: "Clinics." });
    expect(await name()).toBe("Computador da Acme Labs");
    // A name someone gave it stays.
    await renameMachine(deps(), f.owner.id, f.org.id, issued.machineId, { name: "Servidor" });
    await updateOrganization(f.db, f.owner.id, f.org.id, { name: "Acme" });
    expect(await name()).toBe("Servidor");

    const ana = await addUser(f.db, "ana");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, ana.id));
    const { organization: beta } = await createOrganization(f.db, ana.id, { name: "Beta" });
    const english = await issueManagedMachine(deps(), beta.id);
    if (!english) throw new Error("no org");
    expect(await name(english.machineId)).toBe("Beta's computer");
    await updateOrganization(f.db, ana.id, beta.id, { name: "Beta Co" });
    expect(await name(english.machineId)).toBe("Beta Co's computer");
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
          stage: null,
          reason: null,
          since: expect.any(String),
          requestedAt: f.org.createdAt.toISOString(),
          expectedReadyAt: null,
          specs: null,
          secondsLeft: null,
          secondsWaited: expect.any(Number),
          notifyByEmail: false,
          machineId,
        },
        {
          type: "agent.computer",
          agentId: f.agent.id,
          target: { kind: "machine", machineId, name: "Computador da Acme", online: true },
        },
      ]),
    );
    expect(runner.sent.find((s) => s.type === "agents")).toMatchObject({
      agents: expect.arrayContaining([expect.objectContaining({ id: early.id })]),
    });
    const told = await f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "computer_ready"));
    expect(told.map((n) => [n.userId, n.source])).toEqual([[f.owner.id, { machineId, label: "Computador da Acme" }]]);

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

  test("the ready email: to the owners by language, once, when promised; a wait counts from the removal", async () => {
    f = await setup();
    const readyEmail = { publicUrl: "https://chat.example.com/", gateway: { hasModelCredential: async () => true } };
    const emails = async () =>
      (await f.db.select().from(schema.outbox))
        .filter((j) => j.kind === "email.send")
        .map((j) => j.payload as { key: string; to: string[]; template: Record<string, unknown> })
        .sort((a, b) => a.key.localeCompare(b.key));
    const caio = await addMember(f.db, f.org.id, "owner", "caio");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, caio.id));
    await addMember(f.db, f.org.id, "admin", "bia");

    // A spare claimed at once: no email.
    const quick = await enrolled();
    let runner = await hello(quick.token, readyEmail);
    expect(await emails()).toEqual([]);

    // An old workspace whose computer is taken away and made again at once: the wait began at the removal.
    await f.db
      .update(schema.organizations)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(schema.organizations.id, f.org.id));
    await runner.disconnect();
    await revokeManagedMachine(deps(), f.org.id, quick.machineId);
    runner = await hello((await enrolled()).token);
    expect(await emails()).toEqual([]);

    // Told it takes longer: the owners get it, each in their language; an admin doesn't.
    await runner.disconnect();
    await revokeManagedMachine(deps(), f.org.id, quick.machineId);
    await setProvisioning(deps(), f.org.id, { state: "waiting", reason: "capacity" });
    const again = await enrolled();
    await hello(again.token);
    const [readyAt] = await f.db
      .select({ since: schema.machineProvisioning.since })
      .from(schema.machineProvisioning)
      .where(eq(schema.machineProvisioning.orgId, f.org.id));
    const key = `computer_ready:${again.machineId}:${readyAt?.since.getTime()}`;
    const [pt, en] = await emails();
    expect(pt).toEqual({
      key,
      to: [f.owner.email],
      template: {
        kind: "computer_ready",
        locale: "pt-BR",
        orgName: "Acme",
        specs: null,
        needsAi: false,
        hasAgents: true,
        url: `https://chat.example.com/org/${f.org.id}`,
      },
    });
    expect(en).toMatchObject({ key: `${key}:en`, to: [caio.email], template: { locale: "en" } });

    // A reconnect is no new ready: nothing more.
    await hello(again.token);
    expect(await emails()).toHaveLength(2);
  });

  test("the ready email: a wait over a minute with nothing promised; none from a server that sends no email", async () => {
    f = await setup();
    const queued = async () => (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "email.send");
    await f.db
      .update(schema.organizations)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(schema.organizations.id, f.org.id));
    // Promised, but this server sends no email.
    await setProvisioning(deps(), f.org.id, { state: "problem" });
    await hello((await enrolled()).token);
    expect(await queued()).toEqual([]);
    await hub?.stop();
    hub = null;

    // Made over a minute ago, on a server that sends email, with no agent (and so no AI) yet.
    const other = await createOrganization(f.db, (await addUser(f.db, "caio")).id, { name: "Beta" });
    await f.db
      .update(schema.organizations)
      .set({ createdAt: new Date(Date.now() - 61_000) })
      .where(eq(schema.organizations.id, other.organization.id));
    const { token } = await enrolled(other.organization.id);
    await hello(token, { publicUrl: "https://chat.example.com", gateway: { hasModelCredential: async () => true } });
    const [email] = await queued();
    expect(email?.payload).toMatchObject({
      template: { kind: "computer_ready", orgName: "Beta", needsAi: true, hasAgents: false },
    });
  });

  test("the ready email goes out with the ready or not at all, and not to a workspace that isn't active", async () => {
    f = await setup();
    const readyEmail = { publicUrl: "https://chat.example.com", gateway: { hasModelCredential: async () => true } };
    const queued = async (orgId = f.org.id) =>
      (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "email.send" && j.orgId === orgId);
    const state = async (orgId = f.org.id) => {
      const [row] = await f.db
        .select({ state: schema.machineProvisioning.state })
        .from(schema.machineProvisioning)
        .where(eq(schema.machineProvisioning.orgId, orgId));
      return row?.state;
    };
    await setProvisioning(deps(), f.org.id, { state: "problem" });
    const { token } = await enrolled();
    // The email can't be queued: the computer doesn't turn ready without it, and the next hello does both.
    await f.db.execute(
      sql.raw(
        "create function no_email() returns trigger language plpgsql as $$ begin raise exception 'outbox down'; end $$",
      ),
    );
    await f.db.execute(
      sql.raw(
        "create trigger no_email before insert on outbox for each row when (new.kind = 'email.send') execute function no_email()",
      ),
    );
    const first = await hello(token, readyEmail);
    expect(await state()).toBe("problem");
    expect(await queued()).toEqual([]);
    await f.db.execute(sql.raw("drop trigger no_email on outbox"));
    await first.disconnect();
    await hello(token);
    expect(await state()).toBe("ready");
    expect(await queued()).toHaveLength(1);

    // Put on hold while its computer was being made: ready, but no email telling its owners to give a first task.
    const held = await createOrganization(f.db, (await addUser(f.db, "bia")).id, { name: "Held" });
    await setProvisioning(deps(), held.organization.id, { state: "problem" });
    const heldComputer = await enrolled(held.organization.id);
    await setOrgStanding(deps(), held.organization.id, { state: "hold", reason: "Review", notice: "silent" });
    await hello(heldComputer.token);
    expect(await state(held.organization.id)).toBe("ready");
    expect(await queued(held.organization.id)).toEqual([]);
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
      // Nor turned down: nobody here could turn a tool or a folder back on.
      const hub = { call: async () => ({ access: {} }), status: async () => ({ online: true }) } as never;
      for (const input of [{ disableTool: "commands" as const }, { removeFolder: { path: "/srv/shared" } }]) {
        const reduced = await reduceMachineAccess({ ...deps(), hub }, who, f.org.id, machineId, input).catch((e) => e);
        expect(reduced).toMatchObject({ code: "machine.managed_access" });
      }
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
