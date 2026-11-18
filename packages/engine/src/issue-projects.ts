import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, eq, inArray, schema, sql } from "@agenteschat/db";
import { ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { can, requireActiveMembership } from "./organizations";
import { ROLE_COLORS } from "./permissions";
import { taskSeenSql } from "./task-access";

const { issueProjects, issues } = schema;

/** A project's name holds at most this (the dialogs mirror it: packages/client/src/lib/issue-projects.ts). */
export const PROJECT_NAME_MAX = 80;
/** More than a workspace runs at once: the menu and the pickers stay a list someone can read. */
export const PROJECTS_MAX = 200;

/** A task's project as its card shows it. */
export interface IssueProjectRef {
  id: string;
  name: string;
  color: string;
  archived: boolean;
}

/** A project in the projects menu. `open`: the open tasks in it that the reader sees. */
export interface IssueProjectView extends IssueProjectRef {
  open: number;
}

type ProjectRow = typeof issueProjects.$inferSelect;

export const projectRef = (p: ProjectRow): IssueProjectRef => ({
  id: p.id,
  name: p.name,
  color: p.color,
  archived: p.archivedAt !== null,
});

export interface ProjectDeps {
  db: Database;
  pubsub?: PubSub;
}

function cleanName(name: string) {
  const n = name.trim().replace(/\s+/g, " ").slice(0, PROJECT_NAME_MAX).trim();
  if (!n) throw new ValidationError("name is required");
  return n;
}

function checkColor(color: string | undefined) {
  if (color === undefined) return undefined;
  if (!(ROLE_COLORS as readonly string[]).includes(color)) throw new ValidationError("invalid color");
  return color;
}

const nameTaken = (name: string) =>
  new ValidationError(`A project named "${name}" already exists`, "issue_project.name_taken", { name });

const byName = (orgId: string, name: string) =>
  and(eq(issueProjects.orgId, orgId), sql`lower(${issueProjects.name}) = lower(${name})`);

/** The org's projects by name, archived ones last. */
async function projectRows(db: Database, orgId: string) {
  return db
    .select()
    .from(issueProjects)
    .where(eq(issueProjects.orgId, orgId))
    .orderBy(sql`${issueProjects.archivedAt} is not null`, asc(sql`lower(${issueProjects.name})`));
}

/** The projects of these tasks, by project id. */
export async function projectsById(db: Database, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const rows = wanted.length ? await db.select().from(issueProjects).where(inArray(issueProjects.id, wanted)) : [];
  return new Map(rows.map((p) => [p.id, projectRef(p)]));
}

/**
 * The projects with how many open tasks the reader sees in each, and how many open tasks have none (`unfiled`).
 * The counts follow who sees each task, so a project never tells of work the reader can't open.
 */
export async function listIssueProjects(
  db: Database,
  userId: string,
  orgId: string,
): Promise<{ projects: IssueProjectView[]; unfiled: number }> {
  await requireActiveMembership(db, userId, orgId);
  const [rows, counts] = await Promise.all([
    projectRows(db, orgId),
    db
      .select({ projectId: issues.projectId, open: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.orgId, orgId),
          sql`${issues.status} not in ('done', 'canceled')`,
          taskSeenSql("issues", sql`${userId}::text`),
        ),
      )
      .groupBy(issues.projectId),
  ]);
  const open = new Map(counts.map((c) => [c.projectId, c.open]));
  return {
    projects: rows.map((p) => ({ ...projectRef(p), open: open.get(p.id) ?? 0 })),
    unfiled: open.get(null) ?? 0,
  };
}

async function announce(deps: ProjectDeps, orgId: string) {
  await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event: { type: "issue.projects" } });
}

async function insertProject(db: Database, orgId: string, input: { name: string; color?: string }) {
  const name = cleanName(input.name);
  const color = checkColor(input.color) ?? "graphite";
  const existing = await db
    .select({ id: issueProjects.id, name: issueProjects.name })
    .from(issueProjects)
    .where(eq(issueProjects.orgId, orgId));
  if (existing.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw nameTaken(name);
  if (existing.length >= PROJECTS_MAX) {
    throw new ValidationError(`A workspace holds at most ${PROJECTS_MAX} projects`, "issue_project.too_many", {
      max: PROJECTS_MAX,
    });
  }
  // Two at once with one name: the unique index refuses the second.
  const [row] = await db.insert(issueProjects).values({ orgId, name, color }).onConflictDoNothing().returning();
  if (!row) throw nameTaken(name);
  return row;
}

async function requirePoster(db: Database, userId: string, orgId: string) {
  const membership = await requireActiveMembership(db, userId, orgId);
  if (!can(membership, "post")) throw new ForbiddenError();
}

/** Whoever may create tasks may create, change and delete projects, as with the board's columns. */
export async function createIssueProject(
  deps: ProjectDeps,
  userId: string,
  orgId: string,
  input: { name: string; color?: string },
): Promise<IssueProjectView> {
  await requirePoster(deps.db, userId, orgId);
  const row = await insertProject(deps.db, orgId, input);
  await announce(deps, orgId);
  return { ...projectRef(row), open: 0 };
}

/** Renames, recolours, archives or brings back a project. */
export async function updateIssueProject(
  deps: ProjectDeps,
  userId: string,
  orgId: string,
  projectId: string,
  patch: { name?: string; color?: string; archived?: boolean },
): Promise<IssueProjectRef> {
  await requirePoster(deps.db, userId, orgId);
  const [current] = await deps.db
    .select()
    .from(issueProjects)
    .where(and(eq(issueProjects.id, projectId), eq(issueProjects.orgId, orgId)));
  if (!current) throw new NotFoundError("Project not found");
  const set: Partial<typeof issueProjects.$inferInsert> = {};
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (name !== current.name) {
      const [other] = await deps.db.select({ id: issueProjects.id }).from(issueProjects).where(byName(orgId, name));
      if (other && other.id !== current.id) throw nameTaken(name);
      set.name = name;
    }
  }
  const color = checkColor(patch.color);
  if (color !== undefined) set.color = color;
  if (patch.archived !== undefined) set.archivedAt = patch.archived ? (current.archivedAt ?? new Date()) : null;
  if (Object.keys(set).length === 0) return projectRef(current);
  const [row] = await deps.db
    .update(issueProjects)
    .set(set)
    .where(eq(issueProjects.id, current.id))
    .returning()
    // Two renames to one name at once: the unique index refuses the second.
    .catch((error: unknown) => {
      throw isUniqueViolation(error) ? nameTaken(set.name ?? current.name) : error;
    });
  await announce(deps, orgId);
  return projectRef(row ?? current);
}

/** Deletes a project. Its tasks stay, with no project (the column's foreign key clears it). */
export async function deleteIssueProject(deps: ProjectDeps, userId: string, orgId: string, projectId: string) {
  await requirePoster(deps.db, userId, orgId);
  const gone = await deps.db
    .delete(issueProjects)
    .where(and(eq(issueProjects.id, projectId), eq(issueProjects.orgId, orgId)))
    .returning({ id: issueProjects.id });
  if (gone.length === 0) throw new NotFoundError("Project not found");
  await announce(deps, orgId);
}

/** A project of the org a task may take: an archived one takes no new tasks. */
export async function projectForTask(db: Database, orgId: string, projectId: string) {
  const [project] = await db
    .select()
    .from(issueProjects)
    .where(and(eq(issueProjects.id, projectId), eq(issueProjects.orgId, orgId)));
  if (!project) throw new ValidationError("That project does not exist", "issue_project.not_found");
  if (project.archivedAt) throw new ValidationError("That project is archived", "issue_project.archived");
  return project;
}

/**
 * The project an agent named, in any capitals. An unknown name is refused with the names that exist, so a typo never
 * starts a second project. `new`: the person asked for a new one, so an unknown name is made on the spot. `list`: only
 * read, so an archived one will do. Otherwise an archived project is refused: it takes no new task.
 */
export async function projectByName(
  deps: ProjectDeps,
  orgId: string,
  name: string,
  mode: "task" | "new" | "list" = "task",
) {
  const wanted = cleanName(name);
  const [found] = await deps.db.select().from(issueProjects).where(byName(orgId, wanted));
  if (found?.archivedAt && mode !== "list") {
    throw new ValidationError(
      `The project "${found.name}" is archived and takes no new task. A person brings it back from its board.`,
      "issue_project.archived",
    );
  }
  if (found) return found;
  if (mode === "new") {
    const row = await insertProject(deps.db, orgId, { name: wanted });
    await announce(deps, orgId);
    return row;
  }
  const names = (await projectRows(deps.db, orgId)).filter((p) => !p.archivedAt).map((p) => `"${p.name}"`);
  const message = names.length
    ? `There is no project named "${wanted}". The projects are: ${names.join(", ")}. Use one of them, or set new_project only when the person asked for a new project.`
    : `There is no project named "${wanted}", and no projects yet. Set new_project only when the person asked for a new project.`;
  throw new ValidationError(message, "issue_project.unknown");
}
