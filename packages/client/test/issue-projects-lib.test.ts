import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import { keys } from "../src/api/keys";
import type { IssueProject } from "../src/api/types";
import { knownErrorText } from "../src/lib/errors";
import {
  liveProjectFilter,
  NO_PROJECT,
  PROJECT_COLORS,
  PROJECT_NAME_MAX,
  pickableProjects,
  projectFilterOf,
  projectFilterRows,
  projectOfFilter,
} from "../src/lib/issue-projects";
import { ISSUE_CARD_FIELDS, ISSUES_VIEW_DEFAULT, isDefaultIssuesView } from "../src/lib/issues-view";

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const project = (n: number, name: string, archived = false): IssueProject => ({
  id: id(n),
  name,
  color: "teal",
  archived,
  open: n,
});
/** Twenty, as the server lists them: by name, the archived last. One name is the longest a project takes. */
const LONG = "Reestruturação do atendimento ".repeat(4).slice(0, PROJECT_NAME_MAX);
const projects = [
  ...Array.from({ length: 18 }, (_, k) => project(k + 1, k === 4 ? LONG : `Cliente ${k + 1}`)),
  project(19, "Acme 2024", true),
  project(20, "Acme 2025", true),
];

describe("task projects", () => {
  test("a project takes the roles' seven colours, never sky, and a name of 80 characters at most", () => {
    expect(PROJECT_COLORS).toEqual(["indigo", "violet", "rose", "amber", "green", "teal", "graphite"]);
    expect(LONG).toHaveLength(PROJECT_NAME_MAX);
  });

  test("a filter is a project's id or none: anything else in an address is dropped", () => {
    expect(projectFilterOf(id(3))).toBe(id(3));
    expect(projectFilterOf(NO_PROJECT)).toBe("none");
    for (const bad of [undefined, null, "", "tudo", 7, id(3).slice(1), `${id(3)}'--`])
      expect(projectFilterOf(bad)).toBeUndefined();
  });

  test("the filter's rows: the eighteen in use, the tasks with none, then the archived", () => {
    const rows = projectFilterRows(projects);
    expect(rows).toHaveLength(21);
    expect(rows[18]).toBeNull();
    expect(rows.slice(19).map((p) => p?.name)).toEqual(["Acme 2024", "Acme 2025"]);
    expect(rows.slice(0, 18).every((p) => p && !p.archived)).toBe(true);
    // Nothing made yet: only the tasks with none.
    expect(projectFilterRows([])).toEqual([null]);
  });

  test("a task picks among the ones in use, and still names its own archived project", () => {
    expect(pickableProjects(projects)).toHaveLength(18);
    expect(pickableProjects(projects, null)).toHaveLength(18);
    expect(pickableProjects(projects, projects[2]).map((p) => p.id)).not.toContain(id(19));
    const own = pickableProjects(projects, projects[19]);
    expect(own).toHaveLength(19);
    expect(own.at(-1)?.name).toBe("Acme 2025");
    // The longest name is offered whole.
    expect(own.map((p) => p.name)).toContain(LONG);
  });

  test("a picked filter lives while its project does; a deleted one means every task again", () => {
    expect(liveProjectFilter(projects, id(5))).toBe(id(5));
    expect(liveProjectFilter(projects, id(20))).toBe(id(20));
    expect(liveProjectFilter(projects, NO_PROJECT)).toBe("none");
    expect(liveProjectFilter(projects, id(99))).toBe("");
    expect(liveProjectFilter([], "")).toBe("");
    expect(projectOfFilter(projects, id(5))?.name).toBe(LONG);
    expect(projectOfFilter(projects, NO_PROJECT)).toBeNull();
    expect(projectOfFilter(projects, id(99))).toBeNull();
    expect(projectOfFilter(undefined, id(5))).toBeNull();
  });

  test("a project's tasks are their own cached list, under the tasks' key with the projects", () => {
    const all = keys.issueList("o1", "");
    const one = keys.issueList("o1", "", id(1));
    expect(all).toEqual(["org", "o1", "issues", "list", "", ""]);
    expect(one).not.toEqual(all);
    const qc = new QueryClient();
    qc.setQueryData(one, []);
    qc.setQueryData(keys.issueProjects("o1"), { projects: [], unfiled: 0 });
    void qc.invalidateQueries({ queryKey: keys.issues("o1") });
    expect(qc.getQueryState(one)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.issueProjects("o1"))?.isInvalidated).toBe(true);
  });

  test("the cards show the project by default, with a toggle of its own", () => {
    expect(ISSUE_CARD_FIELDS[0]).toBe("project");
    expect(ISSUES_VIEW_DEFAULT.fields.project).toBe(true);
    const off = { ...ISSUES_VIEW_DEFAULT, fields: { ...ISSUES_VIEW_DEFAULT.fields, project: false } };
    expect(isDefaultIssuesView(off)).toBe(false);
  });

  test("a name another project has is said in the app's words", () => {
    const t = ((key: string) => key) as unknown as TFunction;
    const taken = new ApiError(400, "issue_project.name_taken", "A project named x already exists", { name: "x" });
    expect(knownErrorText(t, taken)).toBe("errors.issue.projectNameTaken");
  });
});
