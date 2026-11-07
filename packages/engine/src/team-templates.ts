import { type Database, eq, schema } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import type { AppLocale } from "@agenteschat/i18n/locale";
import { takenHandles } from "./agents";
import type { AgentAppearance } from "./appearance";
import { CHANNEL_NAME_PATTERN } from "./channels";
import type { ContextDeps } from "./context/summaries";
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
 * "Criar o time" from a template (`POST …/team-templates/{id}/use`, ADR 0152 §6): the template's team, made at once as
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
  const held = (await billingHold(deps.db, orgId)) !== null;
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
    templateInput(id, locale, org, taken, blocked, held),
    locale,
  );
  const place = { orgId, channelId: dm.id, threadId: null, agentId: lodi.id, runId: null, hop: 0 };
  const card = await postTeamCard(deps, place, params, userId);
  const made = await createTeam(deps, userId, orgId, card.id);
  return { channelId: dm.id, messageId: card.id, state: made.card.state, error: made.card.error ?? null };
}
