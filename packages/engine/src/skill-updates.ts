import { and, type Database, eq, isNotNull, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { sha256 } from "./crypto";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { notifySkillUpdate, resolveSkillWaiting } from "./notification-producers";
import { requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import {
  loadSkill,
  readSkillSource,
  runsCode,
  type SkillDeps,
  type SkillDetail,
  type SkillFileInput,
  type SkillRow,
  saveSkill,
  skillDetail,
  skillFilesOf,
  skillFolderFiles,
  writeSkillVersion,
} from "./skills";

const { skills } = schema;

/** The daily job that updates a workspace's skills that update by themselves ("Atualizar sozinha"). */
export const SKILL_UPDATES_JOB = "skills.update";
/** Workspaces' daily updates start at a time of their own within this, so they don't all read GitHub at once. */
export const SKILL_UPDATES_SPREAD_MS = 6 * 3600_000;

/** What a version held, to bring it back with its files (`lastUpdate.from`). */
export type SkillSnapshot = NonNullable<SkillRow["lastUpdate"]>["from"];

/**
 * An update from a skill's link: nothing new (`unchanged`); applied, a new version (`updated`, `before` what it
 * replaced); or waiting for a person who manages skills because it adds or changes what runs (`waiting`, those files;
 * `fresh`: this content wasn't waiting already).
 */
export type SkillSourceUpdate =
  | { status: "unchanged"; skill: SkillDetail }
  | { status: "updated"; skill: SkillDetail; before: SkillSnapshot }
  | { status: "waiting"; skill: SkillDetail; scripts: string[]; fresh: boolean };

const snapshot = (s: SkillRow): SkillSnapshot => ({
  version: s.version,
  body: s.body,
  description: s.description,
  metadata: s.metadata,
});

/** Installed before links kept their hash: the same text and the same files by path and size. */
async function sameAsInstalled(
  db: Database,
  s: SkillRow,
  incoming: { description: string; body: string; files: SkillFileInput[] },
) {
  if (incoming.body !== s.body || incoming.description !== s.description) return false;
  const now = await skillFilesOf(db, s);
  const sized = (f: SkillFileInput) => `${f.path}:${f.skippedSize ?? f.data.byteLength}`;
  return (
    now.length === incoming.files.length &&
    now
      .map((f) => `${f.path}:${f.size}`)
      .sort()
      .join("\n") === incoming.files.map(sized).sort().join("\n")
  );
}

/** The files of `incoming` that run (`runsCode`) and are new or not byte for byte what the skill has now. */
async function changedRunnables(deps: SkillDeps, s: SkillRow, files: SkillFileInput[]) {
  const runs = files.filter((f) => f.skippedSize === undefined && runsCode(f.path));
  if (runs.length === 0) return [];
  const kept = await skillFolderFiles(
    deps,
    s,
    runs.map((f) => f.path),
  );
  const now = new Map(kept.map((f) => [f.path, f.data]));
  return runs
    .filter((f) => {
      const was = now.get(f.path);
      return !was || Buffer.compare(was, f.data) !== 0;
    })
    .map((f) => f.path);
}

/**
 * Reads the skill's link and updates it from it, with `reimportSkill`'s read (who manages skills, `manage_agents`):
 * the same content again changes nothing; new text and files that don't run apply at once as a new version, which
 * `undoSkillUpdate` takes back; an update adding or changing a script or another file that runs waits for a person
 * (`pendingUpdate`), unless `approved` is that content's hash (`approveSkillUpdate`).
 */
export async function updateSkillFromSource(
  deps: SkillDeps,
  actorId: string,
  orgId: string,
  id: string,
  options: { approved?: string } = {},
): Promise<SkillSourceUpdate> {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  const s = await loadSkill(deps.db, orgId, id);
  const incoming = await readSkillSource(deps, s);
  const hash = incoming.sourceHash;
  const checkedAt = new Date();
  const mark = async (fields: Partial<typeof skills.$inferInsert>) => {
    const [row] = await deps.db
      .update(skills)
      .set({ checkedAt, updateError: null, ...fields })
      .where(eq(skills.id, s.id))
      .returning();
    return skillDetail(deps.db, row ?? s);
  };
  if (hash === s.sourceHash || (!s.sourceHash && (await sameAsInstalled(deps.db, s, incoming)))) {
    if (s.pendingUpdate && !s.pendingUpdate.dismissed) await resolveSkillWaiting(deps, orgId, s.id);
    return { status: "unchanged", skill: await mark({ sourceHash: hash, pendingUpdate: null }) };
  }
  const scripts = await changedRunnables(deps, s, incoming.files);
  if (scripts.length > 0 && options.approved !== hash) {
    const fresh = s.pendingUpdate?.hash !== hash;
    const skill = await mark(fresh ? { pendingUpdate: { hash, scripts, at: checkedAt.toISOString() } } : {});
    if (fresh) await notifySkillUpdate(deps, s, { state: "waiting", hash, scripts }, null).catch(() => {});
    return { status: "waiting", skill, scripts, fresh };
  }
  const before = snapshot(s);
  const saved = await saveSkill(deps, actorId, orgId, incoming);
  if (s.pendingUpdate && !s.pendingUpdate.dismissed) await resolveSkillWaiting(deps, orgId, s.id);
  const skill = await mark({
    pendingUpdate: null,
    lastUpdate: { from: before, version: saved.version, at: checkedAt.toISOString() },
  });
  return { status: "updated", skill, before };
}

/** The waiting update, applied as it was shown: if its link changed since, it waits again with what it holds now. */
export async function approveSkillUpdate(deps: SkillDeps, actorId: string, orgId: string, id: string) {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  const s = await loadSkill(deps.db, orgId, id);
  if (!s.pendingUpdate) throw new ValidationError("No update of this skill waits", "skill.no_pending_update");
  return updateSkillFromSource(deps, actorId, orgId, id, { approved: s.pendingUpdate.hash });
}

/** No to the waiting update: kept as refused, so the same content isn't raised again (new content is). */
export async function dismissSkillUpdate(deps: SkillDeps, actorId: string, orgId: string, id: string) {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  const s = await loadSkill(deps.db, orgId, id);
  if (!s.pendingUpdate) throw new ValidationError("No update of this skill waits", "skill.no_pending_update");
  const [row] = await deps.db
    .update(skills)
    .set({ pendingUpdate: { ...s.pendingUpdate, dismissed: true } })
    .where(eq(skills.id, s.id))
    .returning();
  await resolveSkillWaiting(deps, orgId, s.id);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "skill.update_dismissed",
    target: { type: "skill", id: s.id },
    details: { name: s.name, scripts: s.pendingUpdate.scripts },
  });
  return skillDetail(deps.db, row ?? s);
}

/** A new version with this version's text and its files: the skill as it was. */
export const restoreSkillSnapshot = (db: Database, s: SkillRow, to: SkillSnapshot) =>
  writeSkillVersion(db, s, { body: to.body, description: to.description, metadata: to.metadata }, to.version);

/**
 * Back to the version before its last update from its link (a new version with its text and files), while the skill
 * is still at the version that update made. Its link isn't read: the next update applies only what changes there.
 */
export async function undoSkillUpdate(deps: SkillDeps, actorId: string, orgId: string, id: string) {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  const s = await loadSkill(deps.db, orgId, id);
  if (!s.lastUpdate || s.lastUpdate.version !== s.version)
    throw new ValidationError("There is no update from its link to undo", "skill.nothing_to_undo");
  const row = await restoreSkillSnapshot(deps.db, s, s.lastUpdate.from);
  const [cleared] = await deps.db.update(skills).set({ lastUpdate: null }).where(eq(skills.id, s.id)).returning();
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "skill.update_undone",
    target: { type: "skill", id: s.id },
    details: { name: s.name, version: row.version, restored: s.lastUpdate.from.version },
  });
  return skillDetail(deps.db, cleared ?? row);
}

/** "Atualizar sozinha" on or off (who manages skills): on, the daily update reads with the rights of who turned it on. */
export async function setSkillAutoUpdate(db: Database, actorId: string, orgId: string, id: string, on: boolean) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const s = await loadSkill(db, orgId, id);
  if (on && !s.sourceUrl)
    throw new ValidationError("Only a skill installed from a link can update by itself", "skill.no_link");
  const [row] = await db
    .update(skills)
    .set({ autoUpdate: on, autoUpdateUserId: on ? actorId : null, updateError: null })
    .where(eq(skills.id, s.id))
    .returning();
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: on ? "skill.auto_update_on" : "skill.auto_update_off",
    target: { type: "skill", id: s.id },
    details: { name: s.name },
  });
  return skillDetail(db, row ?? s);
}

/** A refusal's stable code (`skill.connection_gone`, `skill.no_skill_md`, `forbidden`…), or null for any other failure. */
const refusalCode = (error: unknown) =>
  error instanceof ValidationError || error instanceof ForbiddenError || error instanceof NotFoundError
    ? error.code
    : null;

/**
 * Every workspace with a skill that updates by itself, queued once a day (the date in its dedupe key), each at a time
 * of its own within `SKILL_UPDATES_SPREAD_MS`.
 */
export async function enqueueSkillUpdates(db: Database, now = new Date()) {
  const orgs = await db
    .selectDistinct({ orgId: skills.orgId })
    .from(skills)
    .where(and(eq(skills.autoUpdate, true), isNull(skills.deletedAt), isNotNull(skills.sourceUrl)));
  const day = now.toISOString().slice(0, 10);
  for (const { orgId } of orgs) {
    const offset = Number.parseInt(sha256(orgId).slice(0, 8), 16) % SKILL_UPDATES_SPREAD_MS;
    await enqueue(db, {
      orgId,
      kind: SKILL_UPDATES_JOB,
      payload: {},
      dedupeKey: `${SKILL_UPDATES_JOB}:${orgId}:${day}`,
      runAt: new Date(now.getTime() + offset),
      maxAttempts: 1,
    });
  }
  return orgs.length;
}

/**
 * A workspace's daily update of its skills that update by themselves, one at a time, each with the rights of who
 * turned it on: an update applied is told to them; one that changes what runs waits, told once to who manages skills;
 * a refusal (its link gone, the GitHub connection gone, no longer allowed) is told once, until an update works again.
 * Anything else (GitHub limiting us, a network failure) is left for the next day.
 */
export async function runSkillUpdates(deps: SkillDeps, orgId: string) {
  const due = await deps.db
    .select()
    .from(skills)
    .where(
      and(eq(skills.orgId, orgId), eq(skills.autoUpdate, true), isNull(skills.deletedAt), isNotNull(skills.sourceUrl)),
    );
  const done = { updated: 0, waiting: 0, failed: 0 };
  for (const s of due) {
    try {
      if (!s.autoUpdateUserId)
        throw new ForbiddenError("Whoever turned this on is no longer here", "skill.auto_update_owner_gone");
      const r = await updateSkillFromSource(deps, s.autoUpdateUserId, orgId, s.id);
      if (r.status === "updated") {
        done.updated++;
        await notifySkillUpdate(deps, s, { state: "updated", version: r.skill.version }, s.autoUpdateUserId).catch(
          () => {},
        );
      } else if (r.status === "waiting") done.waiting++;
    } catch (error) {
      const code = refusalCode(error);
      if (!code) continue;
      done.failed++;
      if (code === s.updateError) continue;
      await deps.db.update(skills).set({ updateError: code, checkedAt: new Date() }).where(eq(skills.id, s.id));
      await notifySkillUpdate(deps, s, { state: "failed", reason: code }, s.autoUpdateUserId).catch(() => {});
    }
  }
  return done;
}
