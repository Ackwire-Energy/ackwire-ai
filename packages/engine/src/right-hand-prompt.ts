import { and, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { type AiStatusDeps, agentAiStates, orgHasAi } from "./ai-status";
import { seesAgentDetails } from "./audience";
import { listChannels } from "./channels";
import { can, getMembership } from "./organizations";
import type { RolePermission } from "./permissions";
import { agentBudgetsThisMonth } from "./usage";

const { agents, channelMembers, connectorConnections, organizationMembers, users } = schema;

/** What the person behind the run may do here, as its prompt names it. */
const POWERS: [RolePermission, string][] = [
  ["create_agents", "create agents"],
  [
    "manage_agents",
    "change any agent's settings (model, AI account, budget, owner, who may use it) and archive agents",
  ],
  ["manage_channels", "manage channels (which agents are in them, how they reply)"],
  ["manage_connectors", "connect apps and MCP servers"],
  ["manage_credentials", "connect AI accounts and keys"],
  ["invite_people", "invite people"],
  ["manage_routines", "manage any agent's routines"],
];

/** At most this many agents, people and channels in the snapshot, like the team roster. */
const SNAPSHOT_MAX = 40;

const usd = (nano: number) => `US$ ${(nano / 1e9).toFixed(2)}`;

/**
 * Its system block in place of an agent's own instructions (ours, shipped with the product): who it is, who it talks
 * to and what they may do, the team as it is now and what isn't set up yet, read live per run and never cached (the
 * snapshot is what this person may see), and the rules of its cards.
 */
export async function rightHandPrompt(
  deps: { db: Database; ai?: Omit<AiStatusDeps, "db"> },
  input: { orgId: string; agent: { id: string; name: string; handle: string }; personId: string; inDm: boolean },
): Promise<string> {
  const { db } = deps;
  const { orgId, agent, personId } = input;
  const membership = await getMembership(db, personId, orgId);
  const [person, team, people, channels, budgets, apps] = await Promise.all([
    db.select({ name: users.name }).from(users).where(eq(users.id, personId)),
    db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt), isNull(agents.builtin)))
      .orderBy(agents.createdAt)
      .limit(SNAPSHOT_MAX),
    db
      .select({ name: users.name, handle: organizationMembers.handle, role: organizationMembers.role })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, orgId), isNull(users.blockedAt)))
      .orderBy(organizationMembers.createdAt)
      .limit(SNAPSHOT_MAX + 1),
    listChannels(db, personId, orgId),
    agentBudgetsThisMonth(db, orgId),
    db
      .select({ label: connectorConnections.label })
      .from(connectorConnections)
      .where(and(eq(connectorConnections.orgId, orgId), isNull(connectorConnections.revokedAt))),
  ]);
  const roleNames = membership?.roleIds.length
    ? (
        await db
          .select({ name: schema.orgRoles.name })
          .from(schema.orgRoles)
          .where(and(eq(schema.orgRoles.orgId, orgId), inArray(schema.orgRoles.id, membership.roleIds)))
      ).map((r) => r.name)
    : [];
  const seen = team.filter((a) => seesAgentDetails(a, personId, membership));
  const open = channels.slice(0, SNAPSHOT_MAX);
  const seats = open.length
    ? await db
        .select({ channelId: channelMembers.channelId, agentId: channelMembers.agentId, userId: channelMembers.userId })
        .from(channelMembers)
        .where(
          and(
            eq(channelMembers.orgId, orgId),
            inArray(
              channelMembers.channelId,
              open.map((c) => c.id),
            ),
          ),
        )
    : [];
  const channelName = new Map(open.map((c) => [c.id, c.name]));
  const channelsOf = (agentId: string) =>
    seats.filter((s) => s.agentId === agentId).map((s) => `#${channelName.get(s.channelId)}`);
  const ai = deps.ai ? { db, ...deps.ai } : null;
  const [anyAi, aiStates] = ai
    ? await Promise.all([
        orgHasAi(ai, orgId),
        agentAiStates(
          ai,
          orgId,
          seen.map((a) => a.id),
        ),
      ])
    : [null, null];

  const may = POWERS.filter(([key]) => can(membership, key)).map(([, what]) => what);
  const mayNot = POWERS.filter(([key]) => !can(membership, key)).map(([, what]) => what);
  const name = person[0]?.name ?? "this person";
  const owner = membership?.role === "owner";

  const agentLines = seen.map((a) => {
    const b = budgets.get(a.id);
    const used = b && b.budgetNanoUsd > 0 ? Math.round((b.spentNanoUsd / b.budgetNanoUsd) * 100) : 0;
    const where = channelsOf(a.id);
    return [
      `- @${a.handle} (${a.name})${a.role ? `, ${a.role}` : ""}`,
      `model ${a.model}${aiStates?.get(a.id)?.state === "no_ai" ? " (no AI: it can't answer)" : ""}`,
      where.length ? `in ${where.join(", ")}` : "in no channel",
      b ? `budget ${usd(b.budgetNanoUsd)}/month${b.isDefault ? " (the default)" : ""}, ${used}% used` : "",
    ]
      .filter(Boolean)
      .join("; ");
  });
  const hidden = team.length - seen.length;

  const checklist = [
    anyAi === false
      ? "No AI is connected: nothing can answer yet. Offer the Connect AI card (offer_connect_ai) first."
      : "",
    aiStates && seen.some((a) => aiStates.get(a.id)?.state === "no_ai")
      ? "An agent has no AI: point to it and offer the Connect AI card."
      : "",
    team.length === 0 ? "There is no agent besides you: offer to create the first ones (propose_agent)." : "",
    people.length <= 1 ? "Only one person is here: offer to invite the team (offer_invites)." : "",
    apps.length === 0 ? "No app is connected: offer one the team needs (offer_connect_app)." : "",
    seen.some((a) => channelsOf(a.id).length === 0)
      ? "An agent is in no channel: offer to add it to one (add_agent_to_channel)."
      : "",
    seen.some((a) => {
      const b = budgets.get(a.id);
      return b && b.budgetNanoUsd > 0 && b.spentNanoUsd >= 0.8 * b.budgetNanoUsd;
    })
      ? "An agent used 80% or more of its monthly budget: say so to someone who may raise it."
      : "",
  ].filter(Boolean);

  return [
    `You are ${agent.name} (@${agent.handle}), this workspace's assistant: the team's right hand. You set up and change the team with the people: you propose agents, change teammates' settings, connect apps and invite people. You do no team work yourself (no code, no answering customers, no research): hand that to the agent whose job it is, or propose one.`,
    [
      "# Who you talk to",
      `${name}${owner ? ", an owner of this workspace" : ""}${roleNames.length ? ` (roles: ${roleNames.join(", ")})` : ""}. You act with their permissions, never more.`,
      may.length ? `They may: ${may.join("; ")}.` : "",
      mayNot.length
        ? `They can't: ${mayNot.join("; ")}. Still make the card for such a change: it goes to whoever may decide it.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    [
      "# The team now",
      agentLines.length ? agentLines.join("\n") : "No agents yet besides you.",
      hidden > 0 ? `(${hidden} more agent${hidden > 1 ? "s" : ""} this person can't see.)` : "",
      `People: ${people
        .slice(0, SNAPSHOT_MAX)
        .map((p) => `${p.name}${p.handle ? ` (@${p.handle})` : ""}${p.role === "owner" ? ", owner" : ""}`)
        .join("; ")}.`,
      open.length
        ? `Channels they see: ${open.map((c) => `#${c.name} (${seats.filter((s) => s.channelId === c.id).length} members)`).join(", ")}.`
        : "",
      apps.length ? `Apps connected: ${apps.map((a) => a.label).join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    checklist.length ? `# Not set up yet\n${checklist.map((l) => `- ${l}`).join("\n")}` : "",
    [
      "# Your cards",
      "- Every change is a card the person clicks, applied as whoever clicks it. Never say it is done before the click.",
      "- When this person can't make a change, make the same card: it is sent to whoever may decide it.",
      "- At most 5 agent proposals in a row; ask one short question first when what they need is unclear.",
      "- Never ask for a key, password or token in the chat: say where the setting is, the card's dialog takes it.",
    ].join("\n"),
    "# Never\nDecide approvals, change people's roles, remove members, billing, delete a workspace, an account or an agent. When asked, say where it is in Settings.",
    input.inDm
      ? "# Where you are\nYour private conversation with this person: answer every message. Nobody else reads it."
      : "# Where you are\nA channel, where you were called by name: answer briefly. Never paste budgets or other agents' apps here, and offer to set things up in your DM with this person.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
