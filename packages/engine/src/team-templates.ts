import { type Database, eq, schema } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import type { AppLocale } from "@agenteschat/i18n/locale";
import { takenHandles } from "./agents";
import type { AgentAppearance } from "./appearance";
import { CHANNEL_NAME_PATTERN } from "./channels";
import type { ContextDeps } from "./context/summaries";
import { publishMessageCreated } from "./events";
import { getMessage, messageView } from "./messages";
import { requirePermission } from "./organizations";
import { billingHold } from "./standing";
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
import { isPersonalWorkspace } from "./workspace-mode";

/**
 * "See team templates" (ADR 0137 §10): six business types, each a team of the same few agents, kept in code with its
 * words in `@agenteschat/i18n` (`teamTemplates.*`, every language). "Create the team" makes it at once, as the right
 * hand's team card in its created state.
 */
export const BUSINESS_TEMPLATES = ["agency", "store", "clinic", "software", "support", "services"] as const;
/**
 * A personal workspace's templates (ADR 0158): areas of one person's life, each a few agents that work in their DM with
 * the person, so they make no channel.
 */
export const PERSONAL_TEMPLATES = ["life", "health", "studies", "home", "travel", "freelance"] as const;
/** Every template: either list can be used in either mode, the mode only picks the one the gallery shows. */
export const TEAM_TEMPLATES = [...BUSINESS_TEMPLATES, ...PERSONAL_TEMPLATES] as const;
export type TeamTemplateId = (typeof TEAM_TEMPLATES)[number];
export const isTeamTemplate = (v: unknown): v is TeamTemplateId => TEAM_TEMPLATES.includes(v as TeamTemplateId);
const isPersonalTemplate = (id: TeamTemplateId) => (PERSONAL_TEMPLATES as readonly string[]).includes(id);

type BusinessMember = "iara" | "caio" | "ada" | "lia" | "theo" | "nina" | "otto" | "bia";
type PersonalMember = "clara" | "duda" | "leo" | "mel" | "gabi" | "lu" | "rosa" | "vic" | "rui";
type Member = BusinessMember | PersonalMember;
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
  // A personal workspace's agents (ADR 0158): routines on one person's clock.
  clara: {
    name: "Clara",
    look: { color: "violet", eyes: "happy", accessory: "bow" },
    // Every morning, before the day starts.
    cron: "0 7 * * *",
    skill: null,
  },
  duda: {
    name: "Duda",
    look: { color: "green", eyes: "round", accessory: "cap" },
    // On the 5th of each month, when most bills come.
    cron: "0 9 5 * *",
    skill: null,
  },
  leo: {
    name: "Léo",
    look: { color: "amber", eyes: "wide", accessory: "headphones" },
    // Monday, Wednesday and Friday, early.
    cron: "0 6 * * 1,3,5",
    skill: null,
  },
  mel: {
    name: "Mel",
    look: { color: "rose", eyes: "dots", accessory: "scarf" },
    // Sunday morning, before the week's shopping.
    cron: "0 10 * * 0",
    skill: null,
  },
  gabi: {
    name: "Gabi",
    look: { color: "indigo", eyes: "wide", accessory: "antenna" },
    // Weekday evenings.
    cron: "0 19 * * 1-5",
    skill: null,
  },
  lu: {
    name: "Lu",
    look: { color: "violet", eyes: "sleepy", accessory: "beanie" },
    cron: "0 18 * * 0",
    skill: null,
  },
  rosa: {
    name: "Rosa",
    look: { color: "teal", eyes: "happy", accessory: "flower" },
    // Saturday morning.
    cron: "0 9 * * 6",
    skill: null,
  },
  vic: {
    name: "Vic",
    look: { color: "sky", eyes: "dots", accessory: "hat" },
    cron: "0 8 * * 1",
    skill: null,
  },
  rui: {
    name: "Rui",
    look: { color: "graphite", eyes: "round", accessory: "headset" },
    // Every weekday morning.
    cron: "0 9 * * 1-5",
    skill: null,
  },
};

const TEAMS: Record<TeamTemplateId, Member[]> = {
  agency: ["lia", "theo", "iara"],
  store: ["iara", "otto", "lia"],
  clinic: ["nina", "caio", "iara"],
  software: ["iara", "caio", "ada"],
  support: ["iara", "bia"],
  services: ["nina", "theo", "caio"],
  life: ["clara", "duda"],
  health: ["leo", "mel"],
  studies: ["gabi", "lu"],
  home: ["rosa", "duda"],
  travel: ["vic", "clara"],
  freelance: ["rui", "duda", "clara"],
};

/** The agents of the business templates: the only ones with a channel each. */
const CHANNEL_MEMBERS = [...new Set(BUSINESS_TEMPLATES.flatMap((id) => TEAMS[id]))];

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
  const names = [...new Set(CHANNEL_MEMBERS.map((m) => channelName(locale, m)))];
  return new Set((await channelPlaces(db, orgId, userId, names)).blocked);
}

/**
 * The tool's input for a template, in `locale`, with a free handle for each agent (`iara-2` when Iara is taken) and a
 * usable channel name (`financeiro-2` when #financeiro is a private channel this person isn't in). A personal
 * template's agents get no channel: each lives in its DM with the person (ADR 0158).
 */
function templateInput(
  id: TeamTemplateId,
  locale: AppLocale,
  org: string,
  taken: Set<string>,
  blocked: Set<string>,
  /** A billing hold: nobody can answer yet, so the card shows what its first agent delivers. */
  held = false,
) {
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
  const personal = isPersonalTemplate(id);
  return {
    lead: t(personal ? "teamTemplates.leadPersonal" : "teamTemplates.lead"),
    agents: members.map((m) => ({
      name: MEMBERS[m].name,
      handle: handles.get(m),
      role: t(`teamTemplates.agents.${m}.role`),
      line: t(`teamTemplates.agents.${m}.line`),
      look: MEMBERS[m].look,
      channel: personal ? "" : channelOf(m),
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
    approvals: t(personal ? "teamTemplates.approvalsPersonal" : "teamTemplates.approvals"),
    // The right hand's weekly check reports on a team's work: one person's agents don't need it (ADR 0158).
    weekly_check: !personal,
    template: id,
    ...(held ? { example: t(`teamTemplates.example.${members[0]}`) } : {}),
  };
}

async function orgName(db: Database, orgId: string) {
  const [org] = await db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  return org?.name ?? "";
}

/**
 * The gallery (`GET …/team-templates`), for who may create agents, read in the person's language and time zone: a
 * personal workspace's templates there (ADR 0158), the business ones anywhere else.
 */
export async function listTeamTemplates(
  deps: { db: Database; context?: ContextDeps },
  userId: string,
  orgId: string,
  preferred?: string | null,
): Promise<TeamTemplateView[]> {
  await requirePermission(deps.db, userId, orgId, "create_agents");
  const [locale, org, taken, personal] = await Promise.all([
    personLocale(deps.db, userId, preferred),
    orgName(deps.db, orgId),
    takenHandles(deps.db, orgId),
    isPersonalWorkspace(deps.db, orgId),
  ]);
  const blocked = personal ? new Set<string>() : await blockedChannels(deps.db, orgId, userId, locale);
  // Read only: no card goes anywhere yet.
  const place = { orgId, channelId: "", personId: userId };
  return Promise.all(
    (personal ? PERSONAL_TEMPLATES : BUSINESS_TEMPLATES).map(async (id) => ({
      id,
      name: serverText(locale, `teamTemplates.${id}.name`),
      sub: serverText(locale, `teamTemplates.${id}.sub`),
      description: serverText(locale, `teamTemplates.${id}.desc`),
      team: await checkTeam(deps, place, templateInput(id, locale, org, taken, blocked), locale),
    })),
  );
}

/**
 * "Create the team" from a template (`POST …/team-templates/{id}/use`, ADR 0155 §6): the template's team, made at once
 * as the right hand's card in the person's DM with it, which then reads created with Undo. No model call and no
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
  const held = (await billingHold(deps.db, orgId)) !== null;
  const [locale, org, taken, { lodi, dm }] = await Promise.all([
    personLocale(deps.db, userId, preferred),
    orgName(deps.db, orgId),
    takenHandles(deps.db, orgId),
    rightHandDm(deps.db, orgId, userId),
  ]);
  const blocked = isPersonalTemplate(id) ? new Set<string>() : await blockedChannels(deps.db, orgId, userId, locale);
  const params = await checkTeam(
    deps,
    { orgId, channelId: dm.id, personId: userId },
    templateInput(id, locale, org, taken, blocked, held),
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
  return { channelId: dm.id, messageId: card.id, state: made.card.state, error: made.card.error ?? null };
}
