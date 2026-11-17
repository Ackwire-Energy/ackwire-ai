import { AGENT_COLORS } from "@agenteschat/tokens/look";
import type { IssueProject, IssueProjectRef } from "../api/types";
import { isUuid } from "./format";

/** A project's name holds at most this (mirror of `PROJECT_NAME_MAX`, packages/engine/src/issue-projects.ts). */
export const PROJECT_NAME_MAX = 80;

/** The colors a project can take: the roles' (mirror of `ROLE_COLORS`, packages/engine/src/permissions.ts). */
export const PROJECT_COLORS = AGENT_COLORS.filter((c) => c !== "sky");

/** In a project filter and its URL: the tasks with no project. */
export const NO_PROJECT = "none";

/** A project filter from a URL or a stored value: a project's id, `none`, or nothing. */
export const projectFilterOf = (value: unknown): string | undefined =>
  typeof value === "string" && (value === NO_PROJECT || isUuid(value)) ? value : undefined;

/**
 * The projects a task can take: the ones in use, plus the one it already has when that one is archived (so the
 * picker still names it).
 */
export function pickableProjects<P extends IssueProjectRef>(projects: P[], current?: IssueProjectRef | null) {
  const live = projects.filter((p) => !p.archived);
  if (!current?.archived || live.some((p) => p.id === current.id)) return live;
  return [...live, ...projects.filter((p) => p.id === current.id)];
}

/** A project filter's rows in order: the projects in use, the tasks with none (`null`), then the archived ones. */
export const projectFilterRows = <P extends IssueProjectRef>(projects: P[]): (P | null)[] => [
  ...projects.filter((p) => !p.archived),
  null,
  ...projects.filter((p) => p.archived),
];

/** A picked filter while it still means something: `none`, or a project that exists. Else every task (""). */
export const liveProjectFilter = (projects: IssueProjectRef[], picked: string) =>
  picked === NO_PROJECT || projects.some((p) => p.id === picked) ? picked : "";

/** The project a filter names, when it is one that still exists. */
export const projectOfFilter = (projects: IssueProject[] | undefined, filter: string | undefined) =>
  filter && filter !== NO_PROJECT ? (projects?.find((p) => p.id === filter) ?? null) : null;
