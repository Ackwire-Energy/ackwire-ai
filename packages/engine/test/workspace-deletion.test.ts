import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { orgTopic, STREAM_CLOSE } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { Glob } from "bun";
import {
  agentBrainSummaries,
  assertCanWork,
  assertInviting,
  authorizeStream,
  canViewCost,
  consolidateItem,
  createContextToolSource,
  createInvitation,
  createOrganization,
  drainOutbox,
  enqueue,
  getDeviceCode,
  getMembership,
  insertMessage,
  inviteLink,
  issueManagedMachine,
  joinOrganization,
  listMachineRequests,
  listMemberships,
  OrgDeletingError,
  onManagedMachineHello,
  onUserCreated,
  postPersonMessage,
  previewInvitation,
  removeMember,
  requireBrowserAccess,
  requireChannelAccess,
  requirePermission,
  revokeManagedMachine,
  runErrorDetail,
  setOrgStanding,
  setProvisioning,
  signupAdmission,
  standingRefusal,
  startDeviceCode,
  type ToolContext,
  unfinishedWorkspaces,
} from "../src";
import { addMember, addUser, type Fixture, SECRET, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { channelRoutine, fire } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const DAY = 86_400_000;
/** What a deletion writes on the workspace's row: it closes until `dueAt`. */
const closing = (orgId: string, dueAt = new Date(Date.now() + 7 * DAY)) =>
  f.db.update(schema.organizations).set({ deletionDueAt: dueAt }).where(eq(schema.organizations.id, orgId));

/** Whether a call let the person through: false when it was refused because the workspace is being deleted. */
const lets = (call: Promise<unknown>) =>
  call.then(
    () => true,
    (error: unknown) => {
      if (error instanceof OrgDeletingError) return false;
      throw error;
    },
  );

const runs = () => f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);

/** A run of `@dev` on the owner's message, as a tool sees it. */
async function runContext(): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "forget that",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

describe("a workspace being deleted is closed", () => {
  test("every way in refuses it, the operator's suspension first; back open, they let people in", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const computer = await pairMachine(deps, f.owner.id, f.org.id, { name: "MacBook" });
    const comeBack = await startDeviceCode(
      { db: f.db, publicUrl: "https://agentes.chat" },
      {
        name: "MacBook",
        os: "linux",
        arch: "x64",
        hostname: "box",
        version: "0.1.0",
        previousMachineId: computer.machineId,
        previousToken: computer.token,
      },
      { ip: "203.0.113.7" },
    );
    const link = await inviteLink(f.db, SECRET, f.owner.id, f.org.id);
    await createInvitation(f.db, f.owner.id, f.org.id, { email: "zoe@example.com", role: "member" });
    const asked = await runContext();
    const forget = (await createContextToolSource(f.context).tools(asked)).find((t) => t.name === "forget");
    if (!forget) throw new Error("no forget tool");

    const ways: [string, () => Promise<boolean>][] = [
      ["every permission check", () => lets(requirePermission(f.db, f.owner.id, f.org.id, "read"))],
      ["reading and posting", () => lets(requireChannelAccess(f.db, f.owner.id, f.org.id, f.general.id))],
      ["work", async () => (await standingRefusal(f.db, f.org.id)) === null],
      [
        "inviting",
        async () => {
          const member = await getMembership(f.db, f.owner.id, f.org.id);
          if (!member) throw new Error("no membership");
          return lets((async () => assertInviting(member))());
        },
      ],
      [
        "browser hand-offs",
        () => lets(requireBrowserAccess(f.db, f.owner.id, f.org.id, f.agent.id, undefined, "browser")),
      ],
      [
        "desktop streams",
        async () => {
          const target = await authorizeStream(
            { db: f.db, hub: { isLocal: () => false } },
            { userId: f.owner.id, orgId: f.org.id, agentId: f.agent.id, request: { kind: "desktop", mode: "watch" } },
          );
          return !("refused" in target) || target.refused !== STREAM_CLOSE.forbidden || target.reason !== "deleting";
        },
      ],
      [
        "brain settings",
        async () => {
          const agent = {
            id: f.agent.id,
            brain: "claude_code",
            brainModel: null,
            machineId: computer.machineId,
            ownerUserId: null,
          };
          return (
            (await agentBrainSummaries(f.db, f.owner.id, f.org.id, [agent])).get(f.agent.id)?.computer !== undefined
          );
        },
      ],
      [
        "context tools",
        async () => {
          const { item } = await consolidateItem(f.db, {
            orgId: f.org.id,
            kind: "fact",
            scopeType: "org",
            subject: crypto.randomUUID(),
            content: `Launch window ${crypto.randomUUID()}`,
          });
          return !(await forget.execute({ item_id: item.id }, asked)).isError;
        },
      ],
      ["usage", () => canViewCost(f.db, f.owner.id, f.org.id)],
      [
        "the computer device check",
        async () => (await getDeviceCode(deps, comeBack.userCode, f.owner.id)).reconnect !== undefined,
      ],
      ["invitation links", async () => !(await previewInvitation(f.db, link.token))?.closed],
      [
        "sign-up by invitation",
        async () =>
          (await signupAdmission(f.db, "zoe@example.com", { allowSignup: false, ownerByLink: false })) === "invitation",
      ],
      [
        "joining",
        async () => {
          const newcomer = await addUser(f.db, "newcomer");
          return lets(f.db.transaction((tx) => joinOrganization(tx, f.org.id, newcomer.id, "member")));
        },
      ],
      [
        "the provisioner's requests",
        async () =>
          (await listMachineRequests(f.db, "external", { limit: 50 })).requests.some((r) => r.orgId === f.org.id),
      ],
    ];
    const open = async () => {
      const result: Record<string, boolean> = {};
      for (const [way, check] of ways) result[way] = await check();
      return result;
    };
    const all = (value: boolean) => Object.fromEntries(ways.map(([way]) => [way, value]));
    const standing = (state: "active" | "hold" | "suspended") =>
      f.db
        .update(schema.organizations)
        .set({ standing: state, standingReason: state === "active" ? null : "review", standingNotice: "shown" })
        .where(eq(schema.organizations.id, f.org.id));

    expect(await open()).toEqual(all(true));
    const dueAt = new Date(Date.now() + 7 * DAY);
    await closing(f.org.id, dueAt);
    expect(await open()).toEqual(all(false));
    await expect(requirePermission(f.db, f.owner.id, f.org.id, "read")).rejects.toMatchObject({
      code: "org.deleting",
      message: "This workspace is being deleted.",
      params: { dueAt: dueAt.toISOString() },
      retryable: false,
    });
    // Past its date, nothing says when.
    await closing(f.org.id, new Date(Date.now() - DAY));
    await expect(requirePermission(f.db, f.owner.id, f.org.id, "read")).rejects.toMatchObject({
      code: "org.deleting",
      params: undefined,
    });
    // A hold says less than the deletion; the operator's suspension says more.
    await standing("hold");
    expect(await standingRefusal(f.db, f.org.id)).toMatchObject({ code: "org.deleting" });
    await standing("suspended");
    await expect(requirePermission(f.db, f.owner.id, f.org.id, "read")).rejects.toMatchObject({
      code: "org.suspended",
    });

    await standing("active");
    await f.db.update(schema.organizations).set({ deletionDueAt: null }).where(eq(schema.organizations.id, f.org.id));
    expect(await open()).toEqual(all(true));
  });

  test("who you are and leaving stay open", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await closing(f.org.id);
    expect(await listMemberships(f.db, bia.id)).toMatchObject([
      { orgId: f.org.id, standing: { state: "active", deletionDueAt: expect.any(Date) } },
    ]);
    await removeMember(f.db, bia.id, f.org.id, bia.id);
    expect(await listMemberships(f.db, bia.id)).toEqual([]);
  });

  test("work stops at once: a run fails and says why, a routine's slot passes, a job fails for good", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev check the build",
    });
    await closing(f.org.id);
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(0);
    const [run] = await runs();
    expect(run).toMatchObject({ status: "failed", error: "This workspace is being deleted." });
    expect(runErrorDetail(run?.error)).toEqual({ errorCode: "run.org_deleting" });
    expect(await fire(f, routine.id, new Date())).toMatchObject({
      status: "skipped",
      code: "org_deleting",
      agentRunId: null,
    });

    await enqueue(f.db, { orgId: f.org.id, kind: "test.work", payload: {} });
    await drainOutbox(f.db, { "test.work": () => assertCanWork(f.db, f.org.id) });
    const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "test.work"));
    expect(job).toMatchObject({ status: "failed", lastError: "This workspace is being deleted." });
  });

  test("its computer: no request, no report, no code, no ready email, and taken away it waits for none", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    // Told it takes a while: the owners are promised the ready email.
    await setProvisioning(deps, f.org.id, { state: "waiting", reason: "capacity" });
    const issued = await issueManagedMachine(deps, f.org.id);
    if (!issued) throw new Error("no org");
    await closing(f.org.id);

    expect((await listMachineRequests(f.db, "external", { limit: 50 })).requests).toEqual([]);
    await expect(setProvisioning(deps, f.org.id, { state: "preparing", step: "starting" })).rejects.toMatchObject({
      code: "org.deleting",
    });
    await expect(issueManagedMachine(deps, f.org.id)).rejects.toMatchObject({ code: "org.deleting" });

    const machine = { id: issued.machineId, orgId: f.org.id, name: "Acme's computer", kind: "managed" as const };
    const readyEmail = {
      publicUrl: "https://chat.example.com",
      gateway: { hasModelCredential: async () => true },
      machines: null,
    };
    await onManagedMachineHello({ ...deps, readyEmail }, machine);
    const emails = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send"));
    expect(emails).toEqual([]);

    const heard: Record<string, unknown>[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
      const event = (e as { event?: Record<string, unknown> }).event;
      if (event?.type === "machine.provisioning") heard.push(event);
    });
    expect(await revokeManagedMachine(deps, f.org.id, issued.machineId)).toBe(true);
    const waits = await f.db.select().from(schema.machineProvisioning);
    expect(waits).toEqual([]);
    expect(heard).toMatchObject([{ state: null, machineId: null }]);
  });

  test("the onboarding starts a new workspace instead of resuming one being deleted", async () => {
    f = await setup();
    const first = await createOrganization(f.db, f.owner.id, { name: "Rockets" }, { onboarding: true });
    expect((await unfinishedWorkspaces(f.db, f.owner.id)).map((u) => u.organization.id)).toEqual([
      first.organization.id,
    ]);
    await closing(first.organization.id);
    expect(await unfinishedWorkspaces(f.db, f.owner.id)).toEqual([]);
    const next = await createOrganization(f.db, f.owner.id, { name: "Rockets" }, { onboarding: true });
    expect(next.existing).toBe(false);
  });

  test("one being deleted waits for no plan; a trust hold on it still refuses a new workspace", async () => {
    f = await setup();
    const bia = await addUser(f.db, "bia");
    const first = await createOrganization(f.db, bia.id, { name: "First" }, { holdForPayment: true });
    await expect(createOrganization(f.db, bia.id, { name: "Second" }, { holdForPayment: true })).rejects.toMatchObject({
      code: "org.create_unpaid",
      params: { orgId: first.organization.id },
    });
    await closing(first.organization.id);
    const second = await createOrganization(f.db, bia.id, { name: "Second" }, { holdForPayment: true });
    expect(second.organization.standingReason).toBe("payment");

    await setOrgStanding({ db: f.db }, first.organization.id, { state: "hold", reason: "review", notice: "silent" });
    await expect(createOrganization(f.db, bia.id, { name: "Third" })).rejects.toMatchObject({
      code: "org.create_refused",
    });
  });

  test("a server's first account owns every workspace but those being deleted", async () => {
    const { db, close } = await createTestDatabase();
    try {
      await db
        .insert(schema.organizations)
        .values([{ name: "Kept" }, { name: "Going", deletionDueAt: new Date(Date.now() + 7 * DAY) }]);
      const zoe = await addUser(db, "zoe");
      await onUserCreated(db, zoe.id);
      expect((await listMemberships(db, zoe.id)).map((m) => m.orgName)).toEqual(["Kept"]);
    } finally {
      await close();
    }
  });
});

describe("one closed predicate", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");
  /** A standing compared to a state: as a value, through Drizzle, or in SQL. */
  const COMPARES = [
    /\b(state|standing)\s*[!=]==?\s*["'](active|hold|suspended)["']/,
    /["'](active|hold|suspended)["']\s*[!=]==?\s*[\w.?]*\b(state|standing)\b/,
    /\b(eq|ne)\(\s*[\w.]*organizations\.standing\s*,\s*["']/,
    /\b(inArray|notInArray)\(\s*[\w.]*organizations\.standing\s*,\s*\[/,
    /standing\}?\s*(=|<>|!=|in\b|is (not )?distinct from)\s*\(?\s*'(active|hold|suspended)'/i,
  ];

  test("only standing.ts compares a workspace's standing to a state (`closedRefusal`, `workRefusal`, `openOrg`)", async () => {
    const found: string[] = [];
    for (const dir of ["packages/engine/src", "apps/server/src"]) {
      for await (const file of new Glob("**/*.ts").scan(join(REPO, dir))) {
        const path = `${dir}/${file}`;
        if (path === "packages/engine/src/standing.ts") continue;
        const lines = (await Bun.file(join(REPO, path)).text()).split("\n");
        lines.forEach((line, i) => {
          if (COMPARES.some((pattern) => pattern.test(line))) found.push(`${path}:${i + 1}`);
        });
      }
    }
    expect(found).toEqual([]);
  });
});
