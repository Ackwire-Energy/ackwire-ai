import { and, type Database, desc, eq, inArray, isNull, schema } from "@agenteschat/db";

const {
  missions,
  missionParticipants,
  missionPlanVersions,
  missionDecisions,
  missionReviews,
  machineTasks,
  machines,
  users,
} = schema;

/**
 * The compact mission brief a run in a mission's thread gets (ADR 0029 §8):
 * plan progress, what runs, what waits for people, who may ask for work,
 * and how to pass requests on. Only when the thread has a mission (the run's
 * context learns that from the same lookup as the thread's range).
 */
export async function missionBrief(db: Database, missionId: string): Promise<string | null> {
  const [mission] = await db.select().from(missions).where(eq(missions.id, missionId));
  if (!mission) return null;
  const [people, plan, running, decisions, reviews, machine] = await Promise.all([
    db
      .select({ userId: missionParticipants.userId, role: missionParticipants.role, name: users.name })
      .from(missionParticipants)
      .innerJoin(users, eq(users.id, missionParticipants.userId))
      .where(eq(missionParticipants.missionId, mission.id)),
    db
      .select({ items: missionPlanVersions.items })
      .from(missionPlanVersions)
      .where(eq(missionPlanVersions.missionId, mission.id))
      .orderBy(desc(missionPlanVersions.version))
      .limit(1),
    db
      .select({ title: machineTasks.title, branch: machineTasks.branch, lastLine: machineTasks.lastLine })
      .from(machineTasks)
      .where(
        and(
          eq(machineTasks.missionId, mission.id),
          inArray(machineTasks.status, ["queued", "running", "interrupted"]),
          isNull(machineTasks.endedAt),
        ),
      )
      .limit(5),
    db
      .select({
        question: missionDecisions.question,
        options: missionDecisions.options,
        status: missionDecisions.status,
      })
      .from(missionDecisions)
      .where(
        and(eq(missionDecisions.missionId, mission.id), inArray(missionDecisions.status, ["pending", "provisional"])),
      )
      .limit(5),
    db
      .select({ title: missionReviews.title })
      .from(missionReviews)
      .where(and(eq(missionReviews.missionId, mission.id), eq(missionReviews.status, "pending")))
      .limit(5),
    mission.machineId
      ? db.select({ name: machines.name }).from(machines).where(eq(machines.id, mission.machineId))
      : Promise.resolve([] as { name: string }[]),
  ]);
  const [owner] = mission.ownerId
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, mission.ownerId))
    : [];
  const items = plan[0]?.items ?? [];
  const doing = items.filter((i) => i.status === "doing").map((i) => i.title);
  const waiting = items.filter((i) => i.status === "waiting_you").map((i) => i.title);
  const deciders = people.filter((p) => p.role === "decide").map((p) => p.name);
  const commenters = people.filter((p) => p.role === "comment").map((p) => p.name);
  const computer = machine[0]?.name ?? "the computer";
  const executor = mission.executor === "codex" ? "Codex" : "Claude Code";
  const pending = decisions.filter((d) => d.status === "pending");
  const provisional = decisions.filter((d) => d.status === "provisional");
  return [
    "# Mission in this thread",
    `"${mission.title}" (${mission.status}). Goal: ${mission.goal.slice(0, 600)}`,
    `Who can ask for work: ${owner?.name ?? "the owner"} (owner)${deciders.length ? `, ${deciders.join(", ")} (can decide)` : ""}.${
      commenters.length ? ` Can only comment: ${commenters.join(", ")}.` : ""
    } Anyone else here only reads; their requests become suggestions the owner accepts or declines.`,
    items.length
      ? `Plan: ${mission.planDone} of ${mission.planTotal} done.${doing.length ? ` In progress: ${doing.join("; ")}.` : ""}${
          waiting.length ? ` Waiting for people: ${waiting.join("; ")}.` : ""
        }`
      : "Plan: not written yet.",
    running.length
      ? `Running on ${computer}: ${running
          .map((t) => `"${t.title}"${t.branch ? ` (${t.branch})` : ""}${t.lastLine ? `: ${t.lastLine}` : ""}`)
          .join("; ")}.`
      : `Nothing running on ${computer} now.`,
    ...(pending.length
      ? [`Waiting for a decision: ${pending.map((d) => `"${d.question}" (${d.options.join(" / ")})`).join("; ")}.`]
      : []),
    ...(provisional.length ? [`Provisional decisions to review: ${provisional.length}.`] : []),
    ...(reviews.length ? [`Waiting for a review: ${reviews.map((r) => `"${r.title}"`).join("; ")}.`] : []),
    `${executor} on ${computer} does the work in its main session; you route and relay. When the owner or someone who can decide asks for work, a change or something only the executor knows, pass it on with send_to_mission (their words, briefly) and say so; don't start tasks yourself here. Answer questions about progress from this brief. Commands people have: /stop, /pause, /summary, /plan.`,
  ].join("\n");
}
