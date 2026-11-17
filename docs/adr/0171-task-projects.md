# 0171. Projects in Tarefas

- Status: Accepted
- Date: 2026-11-11
- Extends: the board's columns (`issue_columns`), who sees a task (ADR 0151), a person's view of Tarefas
  (`organization_members.issues_view`)

## Context

A workspace has one board. People who run several clients or products on it had no way to tell their tasks apart: some
typed a prefix into every title ("[Client] …") and searched for it on each visit, which works only because the search
reads titles and is never kept. Others asked for one board per client, as they have in other trackers.

Tasks already carry free labels (`issues.labels`, a `text[]`), which agents can set. No screen lets a person set,
filter or search them, they have no colour and no registry, and a typo makes a new one.

## Decision

### 1. One optional project per task

`issue_projects` holds a workspace's projects: `org_id`, `name`, `color` (one of the roles' seven colours,
`ROLE_COLORS`), `archived_at`. `issues.project_id` points at one, or is null. Names are unique in a workspace whatever
their capitals (a unique index on `org_id, lower(name)`), cut at 80 characters, and a workspace holds at most 200.

Deleting a project clears it from its tasks (`on delete set null`) and deletes none. Archiving one keeps its tasks and
its board, and takes it out of every picker: an archived project takes no new task (`issue_project.archived`), while a
task already in it can be edited and still names it.

### 2. A project's board is the same board, filtered

There is still one set of columns per workspace. A project's board is Tarefas with only its tasks: its own address
(`/org/{org}/issues?project={id}`, `none` for the tasks with no project), its name as the page's title, its own
counts. Picking a project is a history entry, so Back returns to every task.

The filter runs on the server (`GET …/issues?projectId=`): the list is capped (200 tasks, 500 at most), so filtering
in the browser would leave a busy workspace's project half empty. The search and the other filters work inside a
project as they do outside.

The projects list is the toolbar's "Projeto" chip: each project with its colour and the open tasks in it that the
reader sees, the tasks with none, the archived ones under their own heading, and "Novo projeto". Projects don't appear
in the sidebar. On every other board a card says its project as a dot in its colour and its name, under a toggle of
its own in Exibição. On the project's own board the cards leave it out, and a new task starts in that project.

### 3. Who manages projects

Whoever may create tasks (`post`) creates, renames, recolours, archives and deletes projects, as with the board's
columns, and sets a task's project when they can edit the task. Projects never widen who sees a task: a project's
counts and board follow each task's own audience (ADR 0151), so a project never tells of work its reader can't open.

`issue.projects` goes to the whole workspace when a project changes. It carries nothing: the apps read the projects
and the tasks again, so each reader gets their own counts.

### 4. Agents name a project, they don't invent one

`create_issue`, `update_issue` and `list_issues` take `project`, the project's name in any capitals (`"none"` clears
it, or lists the tasks with none). A name no project has is refused with the names that exist, so a typo or a guess
never starts a second project. `new_project: true` creates the named project on first use, for when the person asked
for a new one. A list line and the "Your open tasks" brief say each task's project.

A project an agent set is a field of the task like any other: it is on the change's receipt and Desfazer puts back
the one it had.

## Why one project and not free tags

- The ask was a board per client. A project gives a title, an address and a preset on new tasks. A tag gives a filter
  that has to be applied again.
- One project per task keeps counts and boards unambiguous: a task is on exactly one project's board, and the counts
  add up to the workspace's.
- A registry with a unique name stops drift ("clinica", "clínica", "cli") before it starts, for people and for
  agents.
- Labels stay as they are, for what cuts across projects ("bug"). They can become filterable later at low cost: the
  column and the agents' parameters exist.

## Not in this change

- A project's own columns. Every board shares the workspace's.
- Turning existing "[X] " title prefixes into projects. An agent can do it with `update_issue`.
- Creating, renaming or deleting a project on the phone. The phone filters by project, shows it on cards and sets it
  on a task.
- A saved project filter: the address holds it, the person's saved view doesn't.
