/**
 * Test fake — missions (apps/server/src/routes/app/missions.ts). In-memory
 * missions per organization, empty unless a test creates one (`create`, or
 * `seedMission` from the returned helpers). Reads are not logged (cards read
 * them on every render); changes are.
 */
import type { ApiClient } from "@/api/client";
import { ApiError } from "@/api/http";
import type {
  MachineTask,
  Mission,
  MissionDecision,
  MissionParticipants,
  MissionPlanVersion,
  MissionReview,
} from "@/api/types";
import { clone, type MockContext, mockId, perOrg } from "./context";

interface Store {
  missions: Mission[];
  tasks: MachineTask[];
  decisions: MissionDecision[];
  reviews: MissionReview[];
  plans: Map<string, MissionPlanVersion[]>;
  people: Map<string, MissionParticipants["participants"]>;
  files: Map<string, Record<string, string>>;
}

export function createFakeMissions(
  ctx: MockContext,
  log: (method: string, ...args: unknown[]) => void,
): ApiClient["missions"] {
  const store = perOrg(
    async (): Promise<Store> => ({
      missions: [],
      tasks: [],
      decisions: [],
      reviews: [],
      plans: new Map(),
      people: new Map(),
      files: new Map(),
    }),
  );
  const find = async (orgId: string, missionId: string) => {
    const m = (await store(orgId)).missions.find((x) => x.id === missionId);
    if (!m) throw new ApiError(404, "mission.not_found", "Mission not found");
    return m;
  };
  const touch = (m: Mission, patch: Partial<Mission>) => Object.assign(m, patch);
  const participants = async (orgId: string, m: Mission): Promise<MissionParticipants> => {
    const me = await ctx.lookup.me();
    return {
      owner: m.ownerId ? { userId: m.ownerId, name: me?.user.id === m.ownerId ? me.user.name : "Owner" } : null,
      participants: clone((await store(orgId)).people.get(m.id) ?? []),
    };
  };
  return {
    list: async (orgId, status = "open") => {
      const open = (m: Mission) => ["proposed", "active", "paused"].includes(m.status);
      return clone(
        (await store(orgId)).missions.filter((m) =>
          status === "open" ? open(m) : status === "closed" ? !open(m) : m.status === status,
        ),
      );
    },
    create: async (orgId, input) => {
      log("missions.create", orgId, input);
      const me = await ctx.lookup.me();
      const now = ctx.now().toISOString();
      const mission: Mission = {
        id: mockId("mission"),
        threadId: input.threadId ?? mockId("root"),
        channelId: input.channelId ?? (await ctx.lookup.channels(orgId))[0]?.id ?? "",
        agentId: input.agentId,
        ownerId: me?.user.id ?? null,
        executor: "claude",
        title: input.title ?? input.goal.slice(0, 60),
        goal: input.goal,
        status: "proposed",
        repoDir: input.folder ?? "",
        resumeTasks: true,
        plan: { version: 0, done: 0, total: 0, waiting: 0 },
        pending: { decisions: 0, provisional: 0, reviews: 0, suggestions: 0 },
        runningTasks: 1,
        machine: { id: "machine_1", name: "MacBook", online: true, lentBy: null },
        needsComputer: false,
        role: "owner",
        canAct: true,
        canManage: true,
        createdAt: now,
        startedAt: null,
        pausedAt: null,
        closedAt: null,
        closeReason: null,
        wikiPageId: null,
      };
      (await store(orgId)).missions.unshift(mission);
      return clone(mission);
    },
    get: async (orgId, missionId) => clone(await find(orgId, missionId)),
    ofThread: async (orgId, threadId) => {
      const m = (await store(orgId)).missions.find((x) => x.threadId === threadId);
      if (!m) throw new ApiError(404, "mission.not_found", "This thread has no mission");
      return clone(m);
    },
    threadTasks: async (orgId, threadId) => clone((await store(orgId)).tasks.filter((x) => x.threadId === threadId)),
    control: async (orgId, missionId, action) => {
      log("missions.control", orgId, missionId, action);
      const m = await find(orgId, missionId);
      const now = ctx.now().toISOString();
      if (action === "start") {
        if (m.role !== "owner") throw new ApiError(403, "mission.not_owner", "Only the mission's owner can start it");
        touch(m, { status: "active", startedAt: now });
      }
      if (action === "pause") touch(m, { status: "paused", pausedAt: now });
      if (action === "resume") touch(m, { status: "active", pausedAt: null });
      if (action === "stop") {
        const canceledTasks = m.runningTasks;
        touch(m, { status: "paused", pausedAt: now, runningTasks: 0 });
        return { ...clone(m), canceledTasks };
      }
      return clone(m);
    },
    close: async (orgId, missionId, input) => {
      log("missions.close", orgId, missionId, input);
      const m = await find(orgId, missionId);
      touch(m, { status: input.outcome, closedAt: ctx.now().toISOString(), runningTasks: 0 });
      return clone(m);
    },
    message: async (orgId, missionId, text) => {
      log("missions.message", orgId, missionId, text);
      await find(orgId, missionId);
      return { delivered: true };
    },
    participants: async (orgId, missionId) => participants(orgId, await find(orgId, missionId)),
    setParticipant: async (orgId, missionId, userId, role) => {
      log("missions.setParticipant", orgId, missionId, userId, role);
      const m = await find(orgId, missionId);
      const s = await store(orgId);
      const list = s.people.get(m.id) ?? [];
      const member = (await ctx.lookup.members(orgId)).find((x) => x.userId === userId);
      const at = list.findIndex((p) => p.userId === userId);
      const row = { userId, name: member?.name ?? userId, role, addedBy: null, createdAt: ctx.now().toISOString() };
      if (at >= 0) list[at] = row;
      else list.push(row);
      s.people.set(m.id, list);
      return participants(orgId, m);
    },
    removeParticipant: async (orgId, missionId, userId) => {
      log("missions.removeParticipant", orgId, missionId, userId);
      const s = await store(orgId);
      s.people.set(
        missionId,
        (s.people.get(missionId) ?? []).filter((p) => p.userId !== userId),
      );
    },
    transfer: async (orgId, missionId, input) => {
      log("missions.transfer", orgId, missionId, input);
      const m = await find(orgId, missionId);
      touch(m, { ownerId: input.userId, role: "decide", canManage: false });
      return clone(m);
    },
    setMachine: async (orgId, missionId, machineId) => {
      log("missions.setMachine", orgId, missionId, machineId);
      const m = await find(orgId, missionId);
      touch(m, { machine: { id: machineId, name: "Computer", online: true, lentBy: null }, needsComputer: false });
      return clone(m);
    },
    decisions: async (orgId, missionId) =>
      clone((await store(orgId)).decisions.filter((d) => d.missionId === missionId)),
    choose: async (orgId, missionId, decisionId, option) => {
      log("missions.choose", orgId, missionId, decisionId, option);
      const d = (await store(orgId)).decisions.find((x) => x.id === decisionId);
      if (!d) throw new ApiError(404, "mission.decision_not_found", "Decision not found");
      const me = await ctx.lookup.me();
      Object.assign(d, {
        status: "taken",
        chosen: option,
        chosenBy: me?.user.id ?? null,
        chosenAt: ctx.now().toISOString(),
      });
      return clone(d);
    },
    opinion: async (orgId, missionId, decisionId, option) => {
      log("missions.opinion", orgId, missionId, decisionId, option);
      const d = (await store(orgId)).decisions.find((x) => x.id === decisionId);
      if (!d) throw new ApiError(404, "mission.decision_not_found", "Decision not found");
      const me = await ctx.lookup.me();
      d.opinions = [
        ...d.opinions.filter((o) => o.userId !== me?.user.id),
        { userId: me?.user.id ?? "", option, at: ctx.now().toISOString() },
      ];
      return clone(d);
    },
    approveProvisional: async (orgId, missionId) => {
      log("missions.approveProvisional", orgId, missionId);
      const list = (await store(orgId)).decisions.filter(
        (d) => d.missionId === missionId && d.status === "provisional",
      );
      for (const d of list) d.status = "taken";
      return clone(list);
    },
    reviews: async (orgId, missionId) => clone((await store(orgId)).reviews.filter((r) => r.missionId === missionId)),
    review: async (orgId, missionId, reviewId, outcome, note) => {
      log("missions.review", orgId, missionId, reviewId, outcome, note);
      const r = (await store(orgId)).reviews.find((x) => x.id === reviewId);
      if (!r) throw new ApiError(404, "mission.review_not_found", "Review not found");
      Object.assign(r, {
        status: outcome === "approve" ? "approved" : "changes_requested",
        note: note ?? null,
        decidedAt: ctx.now().toISOString(),
      });
      return clone(r);
    },
    suggestion: async (orgId, missionId, messageId, outcome) => {
      log("missions.suggestion", orgId, missionId, messageId, outcome);
      return { messageId, status: outcome === "accept" ? "accepted" : "declined" };
    },
    files: async (orgId, missionId) => {
      const f = (await store(orgId)).files.get(missionId) ?? {};
      return {
        files: ["mission.md", "decisions.md", "notes.md"].map((name) => ({
          name,
          content: f[name] ?? null,
          source: "server",
          writtenAt: null,
          updatedAt: null,
        })),
        editedOnMachine: [],
      };
    },
    summary: async (orgId, missionId) => {
      const m = await find(orgId, missionId);
      return {
        missionId,
        text: "",
        plan: { done: m.plan.done, total: m.plan.total, doing: 0, waiting: m.plan.waiting },
        running: m.runningTasks,
        pendingDecisions: m.pending.decisions,
        provisionalDecisions: m.pending.provisional,
        pendingReviews: m.pending.reviews,
      };
    },
    plan: async (orgId, missionId) => {
      const history = clone((await store(orgId)).plans.get(missionId) ?? []);
      return { missionId, current: history[0] ?? null, history };
    },
  };
}
