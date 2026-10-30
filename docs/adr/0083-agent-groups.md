# 0083. Groups of agents

- Status: Accepted
- Date: 2026-10-30
- Code: `packages/db/src/schema/agents.ts` (`agent_groups`, `agents.group_id`, `agents.group_position`), `packages/engine/src/agent-groups.ts`, `apps/server/src/routes/app/agents.ts`, `packages/client/src/lib/agent-groups.ts`, `apps/web/src/components/AgentGroups.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/mobile/src/features/agents/AgentsScreen.tsx`

## Context

A workspace with many agents (an import brings twenty or more, for several companies and projects) had one long "Agentes" list in the sidebar. Other agent apps show their agents in titled sections. Nothing here grouped agents, and channels have no sections either, so there was no pattern to follow.

## Decision

1. **Groups belong to the workspace** and everyone in it sees them, like channels. A group has a name (up to 80 characters) and a place among the groups, at most 50 of them. An agent is in one group at most: its group is a column of the agent (`agents.group_id`, with its place inside, `group_position`), so the database holds that rule. Deleting a group sets its agents back to no group (the foreign key does it).
2. **Owners and admins change them** (`manage_agents`, as for the agents themselves). Members read them and close the ones they don't need, on their own screen.
3. **One view for every app.** `GET …/agent-groups` gives the groups in order, each with its agents in order, archived ones left out. Every change (`POST …/agent-groups`, `PATCH` and `DELETE …/agent-groups/{groupId}`, `PUT …/agents/{agentId}/group` with a place inside the group) answers with that whole list and tells the workspace's open apps with the org event `agent.groups`, on which each app reads the list again. The event carries no list: the list grows with the agents (fifty groups of long names, or a couple hundred agents in groups), and Postgres NOTIFY, which carries org events between replicas, refuses payloads near 8000 bytes. Agents in no group keep the workspace's order (when they were created). The refusals a person can meet carry codes the apps translate: `agent_group.too_many` (with `max`) and `agent_group.not_found` (a group someone else deleted meanwhile).
4. **Web and desktop app.** The agents in no group stay under "Agentes", and each group is a category after it, which closes like the others (remembered in the browser). For owners and admins: "+" on "Agentes" makes a group; "…" on a group renames it, moves it up or down, or deletes it after a question; "…" on an agent's row, shown on hover, picks its group, makes a new one with it, or moves it up or down inside its group; and rows drag between categories, to a place inside a group. The agent's page has a Grupo field in Configurações › Identidade, saved with the rest of the page and shown once the workspace has groups. A workspace with no groups sees the sidebar as before.
5. **Phone.** "Esperando você" and "Trabalhando agora" stay first. "Livres" splits into the agents in no group ("Sem grupo" once there are groups) and one section per group, which collapses and is remembered on the phone, on one list for every workspace (group ids are unique). Agents move between groups on the web for now.
6. **Imports.** `createAgentGroup(deps, userId, orgId, { name, agentIds })` makes a group after the others with these agents in it, in order, taking them out of any other group. An importer that brings sections of agents calls it once per section.

## Consequences

- Changes to groups are not in the audit log, like the board's columns: they change how lists read, not what an agent may do.
- An archived agent keeps its group and is out of every view while archived.
- Touch screens show no "…" on a row (there is no hover): there, the agent's page moves an agent.
- Two moves at the same time may give two agents the same place in a group. The order then falls back on when they were created, and the next move numbers the group again.
- An import run twice makes its groups twice unless the importer looks for a group of the same name first (`listAgentGroups`).
