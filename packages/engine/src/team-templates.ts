import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, eq, isNull, schema, sql } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import type { AppLocale } from "@agenteschat/i18n/locale";
import { takenHandles } from "./agents";
import { type AiStatusDeps, orgHasAi } from "./ai-status";
import type { AgentAppearance } from "./appearance";
import { addChannelMember, CHANNEL_NAME_PATTERN } from "./channels";
import type { ContextDeps } from "./context/summaries";
import { publishMessageCreated } from "./events";
import { firstName } from "./format";
import { getMessage, insertMessage, messageView } from "./messages";
import { requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { billingHold, TEAM_HELLO_JOB } from "./standing";
import {
  channelPlaces,
  checkTeam,
  createTeam,
  personLocale,
  postTeamCard,
  rightHandDm,
  type TeamDeps,
  type TeamParams,
} from "./team-proposals";

/**
 * "Ver modelos de time" (ADR 0137 §10): six business types, each a team of the same few agents, kept in code with its
 * words in `@agenteschat/i18n` (`teamTemplates.*`, every language). "Criar o time" makes it at once, as the right
 * hand's team card in its created state.
 */
export const TEAM_TEMPLATES = ["agency", "store", "clinic", "software", "support", "services"] as const;
export type TeamTemplateId = (typeof TEAM_TEMPLATES)[number];
export const isTeamTemplate = (v: unknown): v is TeamTemplateId => TEAM_TEMPLATES.includes(v as TeamTemplateId);

type Member = "iara" | "caio" | "ada" | "lia" | "theo" | "nina" | "otto" | "bia";
type SkillKey = "voice" | "dunning" | "answers" | "proposal" | "schedule" | "review";

/** Each agent of the templates: its fixed name and look, its routine's schedule (cron, read as a rule) and skill. */
const MEMBERS: Record<Member, { name: string; look: AgentAppearance; cron: string; skill: SkillKey | null }> = {
  iara: {
    name: "Iara",
    look: { color: "rose", eyes: "happy", accessory: "flower" },
    cron: "0 9 * * *",
    skill: "voice",
  },
  caio: {
    name: "Caio",
    look: { color: "amber", eyes: "round", accessory: "hat" },
    cron: "0 8 * * 1",
    skill: "dunning",
  },
  ada: {
    name: "Ada",
    look: { color: "green", eyes: "wide", accessory: "headphones" },
    cron: "0 9 * * *",
    skill: "review",
  },
  lia: { name: "Lia", look: { color: "violet", eyes: "dots", accessory: "bow" }, cron: "0 10 * * 1", skill: "voice" },
  theo: {
    name: "Theo",
    look: { color: "indigo", eyes: "round", accessory: "cap" },
    cron: "0 17 * * *",
    skill: "proposal",
  },
  nina: {
    name: "Nina",
    look: { color: "sky", eyes: "happy", accessory: "scarf" },
    cron: "0 18 * * *",
    skill: "schedule",
  },
  otto: {
    name: "Otto",
    look: { color: "graphite", eyes: "sleepy", accessory: "beanie" },
    cron: "0 8 * * *",
    skill: null,
  },
  bia: {
    name: "Bia",
    look: { color: "teal", eyes: "dots", accessory: "headset" },
    cron: "0 16 * * 5",
    skill: "answers",
  },
};

const TEAMS: Record<TeamTemplateId, Member[]> = {
  agency: ["lia", "theo", "iara"],
  store: ["iara", "otto", "lia"],
  clinic: ["nina", "caio", "iara"],
  software: ["iara", "caio", "ada"],
  support: ["iara", "bia"],
  services: ["nina", "theo", "caio"],
};

/** A template as the gallery shows it: its words in one language, and the team as its card would propose it. */
export interface TeamTemplateView {
  id: TeamTemplateId;
  name: string;
  sub: string;
  description: string;
  team: TeamParams;
}

/** A channel name in one language, or its English one where that language's isn't a valid name. */
const channelName = (locale: AppLocale, m: Member) => {
  const key = `teamTemplates.channels.${m}`;
  const name = serverText(locale, key);
  return CHANNEL_NAME_PATTERN.test(name) ? name : serverText("en", key);
};

/**
 * The template channel names this person can't use in `locale` (a private channel they aren't in, or one archived by
 * someone else): those get a free name instead, as taken handles do.
 */
async function blockedChannels(db: Database, orgId: string, userId: string, locale: AppLocale) {
  const names = [...new Set((Object.keys(MEMBERS) as Member[]).map((m) => channelName(locale, m)))];
  return new Set((await channelPlaces(db, orgId, userId, names)).blocked);
}

/**
 * The tool's input for a template, in `locale`, with a free handle for each agent (`iara-2` when Iara is taken) and a
 * usable channel name (`financeiro-2` when #financeiro is a private channel this person isn't in).
 */
function templateInput(id: TeamTemplateId, locale: AppLocale, org: string, taken: Set<string>, blocked: Set<string>) {
  const t = (key: string, vars: Record<string, string> = {}) => serverText(locale, key, { org, ...vars });
  const members = TEAMS[id];
  const handleOf = (m: Member) => {
    let h: string = m;
    for (let n = 2; taken.has(h); n++) h = `${m}-${n}`;
    return h;
  };
  const handles = new Map(members.map((m) => [m, handleOf(m)]));
  const channelOf = (m: Member) => {
    const base = channelName(locale, m);
    let name = base;
    for (let n = 2; blocked.has(name); n++) name = `${base}-${n}`;
    return name;
  };
  const skillKeys = [...new Set(members.flatMap((m) => (MEMBERS[m].skill ? [MEMBERS[m].skill] : [])))].slice(0, 2);
  return {
    lead: t("teamTemplates.lead"),
    agents: members.map((m) => ({
      name: MEMBERS[m].name,
      handle: handles.get(m),
      role: t(`teamTemplates.agents.${m}.role`),
      line: t(`teamTemplates.agents.${m}.line`),
      look: MEMBERS[m].look,
      channel: channelOf(m),
      routines: [
        {
          schedule: MEMBERS[m].cron,
          title: t(`teamTemplates.agents.${m}.routine`),
          prompt: t(`teamTemplates.agents.${m}.routine`),
        },
      ],
      first_task: t(`teamTemplates.agents.${m}.task`),
    })),
    skills: skillKeys.map((k) => ({
      title: t(`teamTemplates.skills.${k}.name`),
      line: t(`teamTemplates.skills.${k}.line`),
      agents: members.filter((m) => MEMBERS[m].skill === k).map((m) => handles.get(m)),
    })),
    approvals: t("teamTemplates.approvals"),
    weekly_check: true,
    template: id,
  };
}

async function orgName(db: Database, orgId: string) {
  const [org] = await db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  return org?.name ?? "";
}

/** The gallery (`GET …/team-templates`), for who may create agents, read in the person's language and time zone. */
export async function listTeamTemplates(
  deps: { db: Database; context?: ContextDeps },
  userId: string,
  orgId: string,
  preferred?: string | null,
): Promise<TeamTemplateView[]> {
  await requirePermission(deps.db, userId, orgId, "create_agents");
  const [locale, org, taken] = await Promise.all([
    personLocale(deps.db, userId, preferred),
    orgName(deps.db, orgId),
    takenHandles(deps.db, orgId),
  ]);
  const blocked = await blockedChannels(deps.db, orgId, userId, locale);
  // Read only: no card goes anywhere yet.
  const place = { orgId, channelId: "", personId: userId };
  return Promise.all(
    TEAM_TEMPLATES.map(async (id) => ({
      id,
      name: serverText(locale, `teamTemplates.${id}.name`),
      sub: serverText(locale, `teamTemplates.${id}.sub`),
      description: serverText(locale, `teamTemplates.${id}.desc`),
      team: await checkTeam(deps, place, templateInput(id, locale, org, taken, blocked), locale),
    })),
  );
}

/**
 * "Criar o time" from a template (`POST …/team-templates/{id}/use`, ADR 0155 §6): the template's team, made at once as
 * the right hand's card in the person's DM with it, which then reads created with Desfazer. No model call and no
 * question after, so it works on a billing hold too. A step that fails leaves the card open with its reason, as
 * `createTeam` does for any team card.
 */
export async function useTeamTemplate(
  deps: TeamDeps & { context?: ContextDeps },
  userId: string,
  orgId: string,
  id: TeamTemplateId,
  preferred?: string | null,
) {
  await requirePermission(deps.db, userId, orgId, "create_agents");
  const [locale, org, taken, { lodi, dm }] = await Promise.all([
    personLocale(deps.db, userId, preferred),
    orgName(deps.db, orgId),
    takenHandles(deps.db, orgId),
    rightHandDm(deps.db, orgId, userId),
  ]);
  const blocked = await blockedChannels(deps.db, orgId, userId, locale);
  const params = await checkTeam(
    deps,
    { orgId, channelId: dm.id, personId: userId },
    templateInput(id, locale, org, taken, blocked),
    locale,
  );
  const place = { orgId, channelId: dm.id, threadId: null, agentId: lodi.id, runId: null, hop: 0 };
  // The conversation hears of the card once it is made (or failed), so no device shows it open for a moment.
  const card = await postTeamCard(deps, place, params, userId, undefined, false);
  let made: Awaited<ReturnType<typeof createTeam>>;
  try {
    made = await createTeam(deps, userId, orgId, card.id);
  } finally {
    const now = await getMessage(deps.db, orgId, card.id);
    if (deps.pubsub && now) await publishMessageCreated(deps.pubsub, messageView(now));
  }
  // With no plan to wait for, the team can work now: it says hi (on a hold, once the first plan starts).
  if (made.card.state === "created" && (await billingHold(deps.db, orgId)) === null)
    await enqueue(deps.db, {
      orgId,
      kind: TEAM_HELLO_JOB,
      payload: { how: "created", userId },
      dedupeKey: `${TEAM_HELLO_JOB}:${orgId}`,
    });
  return { channelId: dm.id, messageId: card.id, state: made.card.state, error: made.card.error ?? null };
}

/* ---------- The team's hello (ADR 0158) ---------- */

/** Between two lines in #general: one after the other, as people type. */
export const HELLO_GAP_MS = 1100;

/** The template agent an agent is, by its handle (`iara-2` is Iara's), or null for any other. */
const memberOf = (handle: string): Member | null => {
  const m = handle.replace(/-\d+$/, "");
  return m in MEMBERS ? (m as Member) : null;
};

/**
 * `TEAM_HELLO_JOB` (ADR 0158): the team says hi in #general, one line each, with no model call, once the team can work
 * (the first plan started, or a template team was made where no plan is waited for). Its first job lines the
 * greeters up, the right hand first, then each template agent in the order it was made, `HELLO_GAP_MS` apart; a custom
 * agent says nothing. Each greeter's job: a template agent joins #general answering only when called (`autoReply`
 * off), the right hand speaks there from no channel as always, then its line, marked `meta.greeting`, starting no run
 * and notifying nobody, in the language of whoever paid or made the team. The computer clause only while the
 * workspace's computer is still on its way. The plan brings no AI: while nothing here thinks, the right hand's line
 * asks for one instead of starting the work (the bar under the lines connects it).
 */
export async function sayTeamHello(
  deps: { db: Database; pubsub?: PubSub; workspaceComputer?: unknown } & Partial<
    Pick<AiStatusDeps, "gateway" | "machines">
  >,
  orgId: string,
  payload: Record<string, unknown>,
) {
  const { agents, channelMembers, channels, machineProvisioning, messages, organizationMembers, users } = schema;
  const how = payload.how === "paid" ? "paid" : "created";
  const [general] = await deps.db
    .select({ id: channels.id, creator: channels.createdByUserId })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.name, "general"), isNull(channels.archivedAt)));
  if (!general) return;
  if (typeof payload.agentId !== "string") {
    // Paid: in the language of whoever made the workspace (#general's creator) while they own it, else an owner's.
    const owners = await deps.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "owner")));
    const userId =
      typeof payload.userId === "string"
        ? payload.userId
        : (owners.find((o) => o.userId === general.creator) ?? owners[0])?.userId;
    if (!userId) return;
    const rows = await deps.db
      .select({ id: agents.id, handle: agents.handle, builtin: agents.builtin, createdAt: agents.createdAt })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
      .orderBy(asc(agents.createdAt));
    const made = rows.flatMap((a) => {
      const member = a.builtin ? null : memberOf(a.handle);
      return member ? [{ ...a, member, at: a.createdAt.getTime() }] : [];
    });
    // A team is made in one transaction, so its agents share a creation time: among them, their template's order.
    const rank = (a: (typeof made)[number]) => {
      const group = made.filter((b) => b.at === a.at).map((b) => b.member);
      return (Object.values(TEAMS).find((team) => group.every((m) => team.includes(m))) ?? group).indexOf(a.member);
    };
    const greeters = [
      ...rows.filter((a) => a.builtin === "right_hand"),
      ...made.sort((a, b) => a.at - b.at || rank(a) - rank(b)),
    ];
    const now = Date.now();
    for (const [i, a] of greeters.entries()) {
      await enqueue(deps.db, {
        orgId,
        kind: TEAM_HELLO_JOB,
        payload: { agentId: a.id, userId, how },
        dedupeKey: `${TEAM_HELLO_JOB}:${orgId}:${a.id}`,
        runAt: new Date(now + i * HELLO_GAP_MS),
      });
    }
    return;
  }
  const agentId = payload.agentId;
  const userId = String(payload.userId);
  const [agent] = await deps.db
    .select({ handle: agents.handle, builtin: agents.builtin })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)));
  const member = agent && !agent.builtin ? memberOf(agent.handle) : null;
  if (!agent || (!agent.builtin && !member)) return;
  const [said] = await deps.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, general.id),
        eq(messages.authorAgentId, agentId),
        sql`${messages.meta}->>'greeting' = 'true'`,
      ),
    )
    .limit(1);
  if (said) return;
  // A seat someone already gave it in #general keeps its own auto-reply.
  const [seated] = member
    ? await deps.db
        .select({ agentId: channelMembers.agentId })
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, general.id), eq(channelMembers.agentId, agentId)))
        .limit(1)
    : [];
  if (member && !seated)
    await addChannelMember(deps.db, userId, orgId, general.id, { agentId, autoReply: false }, deps);
  const [[person], [computer], locale] = await Promise.all([
    deps.db.select({ name: users.name }).from(users).where(eq(users.id, userId)),
    deps.db
      .select({ state: machineProvisioning.state })
      .from(machineProvisioning)
      .where(eq(machineProvisioning.orgId, orgId)),
    personLocale(deps.db, userId),
  ]);
  const lodiWord =
    how !== "paid" ? "created" : deps.workspaceComputer && computer?.state !== "ready" ? "starting" : "ready";
  const thinks =
    member !== null ||
    !deps.gateway ||
    (await orgHasAi({ db: deps.db, gateway: deps.gateway, machines: deps.machines }, orgId));
  const body = member
    ? serverText(locale, `teamTemplates.agents.${member}.hello`, { first: firstName(person?.name ?? "") })
    : serverText(locale, `teamTemplates.hello.${thinks ? "lodi" : "lodiNoAi"}.${lodiWord}`);
  const message = await insertMessage(deps.db, {
    orgId,
    channelId: general.id,
    author: { type: "agent", agentId, runId: null, hop: 0, stretchId: null },
    body,
    meta: { greeting: true },
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
}
