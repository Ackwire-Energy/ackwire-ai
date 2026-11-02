import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EmailError, type EmailSender } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, inArray, isNull, lt, schema } from "@agenteschat/db";
import { appLocale } from "@agenteschat/i18n/locale";
import { nanoUsdToUsd } from "@agenteschat/providers";
import { z } from "zod";
import { approverIds } from "./approvals";
import { invitationMailProof } from "./crypto";
import { inertText } from "./email/inert";
import {
  type Block,
  EMAIL_PICTURES,
  type EmailArt,
  type EmailDoc,
  type EmailLocale,
  type Inline,
  type Look,
  ONBOARDING_CREW,
  renderDoc,
  type Scene,
} from "./email/layout";
import { WORDS } from "./email/words";
import { dayAndTime } from "./format";
import { adminIds } from "./gateway";
import { publicHostAddress, type ResolveHost, resolveHostDns } from "./net-guard";
import { enqueue, PermanentJobError } from "./outbox";
import { isAgentesCloud } from "./telemetry";
import { budgetPercent } from "./usage";

export { EMAIL_PICTURES, type EmailArt, type EmailLocale } from "./email/layout";

const { users, organizations, organizationInvitations, agents, approvals } = schema;

/**
 * The sender's name when `EMAIL_FROM` is unset: the name on the logo and in the subjects. The self-host setup
 * writes the same into a new server's `.env` (`senderAt` in packages/setup/src/lib.ts).
 */
const SENDER_NAME = "agentes.chat";

/** The sender when `EMAIL_FROM` is unset, at this server's host (`loadConfig` sets the Cloud's: ping@agentes.chat). */
export const defaultEmailFrom = (publicUrl: string) => `${SENDER_NAME} <ping@${new URL(publicUrl).hostname}>`;

/** A stored or chosen language as an email locale: "en…" is English, anything else (or none) pt-BR. */
export const emailLocale = (value: unknown): EmailLocale =>
  (typeof value === "string" ? appLocale([value]) : null) ?? "pt-BR";

/**
 * Transactional emails in pt-BR or English (`locale`, the recipient's; jobs
 * queued before it existed have none and stay pt-BR), rendered when the
 * `email.send` job runs: a job queued before a deploy carries the payload of
 * its time, so every field added later is optional.
 */
export type EmailTemplate =
  | {
      kind: "invitation";
      locale?: EmailLocale;
      orgName: string;
      /** Empty: the email names nobody. */
      inviterName: string;
      /** The inviter's account address, so the invitee can judge who sent it. */
      inviterEmail?: string;
      /** The workspace's agents, pictured over the headline (`emailCrew`); none: the onboarding's own. */
      crew?: Look[];
      url: string;
      role: string;
      /** The inviter's words (ADR 0090), made inert in the body. */
      note?: string | null;
    }
  | { kind: "password_reset"; locale?: EmailLocale; url: string }
  /** Someone invited you to an event (in-app too). `when` is already formatted in your time zone and language. */
  | {
      kind: "calendar_invite";
      locale?: EmailLocale;
      orgName: string;
      /** Empty: the email says "someone" in its language. */
      inviterName: string;
      title: string;
      when: string;
      url: string;
    }
  /**
   * Someone opened an expired email invitation and asked for a new one. `email` is empty only in jobs queued
   * from an invitation link before links asked to join instead.
   */
  | { kind: "invite_request"; locale?: EmailLocale; orgName: string; email: string; url: string }
  /**
   * Someone asks to join through the workspace's invitation link (ADR 0068), to its owners and admins at most
   * once an hour. Approve and Deny open the request in the app: a link in an email never acts by itself, because
   * mail scanners open every link. The note the person typed never goes out.
   */
  | {
      kind: "join_request";
      locale?: EmailLocale;
      orgName: string;
      name: string;
      email: string;
      url: string;
      denyUrl: string;
    }
  /**
   * The answer to a request to join (ADR 0068), to the address that asked: in (`url` the workspace), approved
   * with an invitation to accept (`url` the invitation), or not approved with the admin's `reason`.
   */
  | {
      kind: "join_answer";
      locale?: EmailLocale;
      outcome: "joined" | "invited" | "denied";
      orgName: string;
      /** Empty: "Someone" in the email's language. */
      approverName?: string;
      role?: string;
      url?: string;
      reason?: string | null;
      /** In or invited: the workspace's agents, pictured over the headline (`emailCrew`); none: the onboarding's own. */
      crew?: Look[];
    }
  | { kind: "verify_email"; locale?: EmailLocale; url: string }
  /**
   * A code to type on an invitation link's page (ADR 0072), to prove the address before asking to join. No
   * button: the page is already open. `url` is the server's own address, for the pictures. Its outbox row is
   * deleted once it can't be sent again (`email.send`), since it holds the code and the address.
   */
  | { kind: "join_code"; locale?: EmailLocale; orgName: string; code: string; url: string }
  /**
   * A code to type before deleting (ADR 0088 §2): the workspace `orgName`, or without it the account `email`. No
   * button: the dialog is already open. `support`: whom to write to if it wasn't them, as `account_deleted`'s. Its
   * outbox row goes like `join_code`'s.
   */
  | {
      kind: "deletion_code";
      locale: EmailLocale;
      code: string;
      email: string;
      orgName?: string;
      support: string | null;
      url: string;
    }
  /**
   * Double opt-in for the landing page's waiting list, in the language they
   * joined in. `email` is the address being confirmed (absent in jobs queued
   * before it existed).
   */
  | { kind: "waitlist_confirm"; locale: EmailLocale; url: string; email?: string }
  /**
   * Early access (ADR 0078): `email` may now create an account and workspaces, through `url` (the sign-up page
   * with the address filled in and the link's token), for `days` days.
   */
  | { kind: "early_access"; locale: EmailLocale; email: string; url: string; days: number }
  /** Early access for the account `email` already has (ADR 0078): it may make workspaces now, from `url`. */
  | { kind: "early_access_allowed"; locale: EmailLocale; email: string; url: string }
  | {
      kind: "budget";
      locale?: EmailLocale;
      level: "warning" | "exhausted";
      agentName: string;
      /** The agent's color (its face); none is sky. */
      agentColor?: string;
      orgName: string;
      /** Share of the budget used (owners who aren't admins never see money). */
      percent: number;
      url: string;
    }
  | {
      kind: "approval_digest";
      locale?: EmailLocale;
      orgName: string;
      /** `agentName` empty: "an agent" in the email's language. */
      items: { agentName: string; agentColor?: string; title: string; ageHours: number }[];
      url: string;
      /** `APPROVAL_REMINDER_HOURS` when it was queued: the footer says how often it comes. */
      afterHours?: number;
    }
  /**
   * An owner deleted a workspace the reader is in, one email per member: it's closed now and goes for good at `dueAt`
   * (ISO), shown in the reader's `timeZone`. Owners get a button to restore it. `url`: the workspace in the app.
   */
  | {
      kind: "workspace_deleting";
      locale: EmailLocale;
      orgName: string;
      /** Who deleted it. Empty: "Someone" in the email's language. */
      byName: string;
      dueAt: string;
      timeZone: string;
      owner: boolean;
      url: string;
    }
  /** An owner restored a workspace that was being deleted, one email per member. */
  | { kind: "workspace_restored"; locale: EmailLocale; orgName: string; byName: string; url: string }
  /** An AI app or a personal token got access to the person's account in a workspace (ADR 0119), to that person. */
  | { kind: "app_connected"; locale: EmailLocale; appName: string; orgName: string; url: string }
  /**
   * The account `email` was deleted. `orgNames`: the workspaces only they were in, which closed with it and go for
   * good at `dueAt` (ISO, shown in `timeZone`). `support`: whom to write to if it wasn't them (`SUPPORT_EMAIL`), else
   * the people who run the server. `url`: the server's own address, for the pictures.
   */
  | {
      kind: "account_deleted";
      locale: EmailLocale;
      email: string;
      orgNames: string[];
      dueAt: string | null;
      timeZone: string;
      support: string | null;
      url: string;
    }
  /** The workspace's own computer is ready after a long wait (ADR 0056 §10): what it is, and what to do next. */
  | {
      kind: "computer_ready";
      locale?: EmailLocale;
      orgName: string;
      /** Its size, when the provisioner said it. */
      specs: { cpus: number; memoryGb: number; diskGb: number } | null;
      /** No agent has an AI to think with yet: connecting one is a step. */
      needsAi: boolean;
      hasAgents: boolean;
      /** The agents around the computer in its picture (`emailCrew`); none: the onboarding's own. */
      crew?: Look[];
      /** The workspace in the app; the button adds its step's path. */
      url: string;
    }
  /**
   * The daily stall-and-noise report to the people who run the server (`OPS_REPORT_EMAIL`, `autonomy-report.ts`):
   * each count of the UTC `day` against its daily average over the 7 days before, and the workspaces with the most.
   * Workspace names and counts only. `url`: the server's own address, for the pictures.
   */
  | {
      kind: "autonomy_report";
      locale?: EmailLocale;
      day: string;
      /** The day's stalls, each once (a line can be part of the one above it). */
      totalStalls: number;
      stalls: { metric: string; today: number; average: number }[];
      noise: { metric: string; today: number; average: number }[];
      topStalls: { name: string; count: number }[];
      topNoise: { name: string; count: number; costNanoUsd: number }[];
      url: string;
    };

/** Pictures linked from this server's own `/email/`. */
export function emailArtAt(publicUrl: string): EmailArt {
  const home = publicUrl.replace(/\/+$/, "");
  return { home, base: `${home}/email/`, files: null };
}

/**
 * Where this server's emails get their pictures (`EMAIL_ART`). `auto`: from its own `/email/` when its
 * address is public, else attached to each message, since recipients' clients and Gmail's image proxy
 * can't reach a private, loopback or CGNAT address (a Tailscale name), or a name that resolves to one.
 * `attach`: always attached, for a public address outsiders still can't open (an access proxy, a VPN, an
 * IP allowlist). With no pictures in `webDir` (a server without the web app) they stay linked.
 * `attached` says why they are attached: `attach` asked, or the host is private (`blocked`) or didn't
 * resolve (`unreachable`); the choice holds until a restart.
 */
export async function emailArtFor(
  publicUrl: string,
  webDir: string | undefined,
  mode: "auto" | "attach",
  resolve: ResolveHost = resolveHostDns,
): Promise<EmailArt & { attached?: "attach" | "blocked" | "unreachable" }> {
  const art = emailArtAt(publicUrl);
  const host = mode === "auto" ? await publicHostAddress(new URL(publicUrl).hostname, resolve) : null;
  if (host?.ok) return art;
  const files = webDir ? await readPictures(join(webDir, "email")) : null;
  return files ? { ...art, base: null, files, attached: host?.reason ?? "attach" } : art;
}

async function readPictures(dir: string) {
  try {
    return new Map(
      await Promise.all(EMAIL_PICTURES.map(async (f) => [f, new Uint8Array(await readFile(join(dir, f)))] as const)),
    );
  } catch {
    return null;
  }
}

/** How many agents a picture shows: two on each side of the computer still fit a 320 px phone. */
const CREW = 4;

/** The workspace's agents its emails picture: the `CREW` oldest, each with its look. */
export async function emailCrew(db: Executor, orgId: string): Promise<Look[]> {
  const rows = await db
    .select({ appearance: agents.appearance })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .orderBy(asc(agents.createdAt), asc(agents.id))
    .limit(CREW);
  return rows.map(({ appearance: a }) => ({ color: a?.color, eyes: a?.eyes, accessory: a?.accessory }));
}

/** A picture's agents: a job's own (cut to `CREW`), or the onboarding's when it has none. */
const crewOr = (crew: Look[] | undefined) => (crew?.length ? crew.slice(0, CREW) : ONBOARDING_CREW);

/** The inviter's note as the invitation shows it (ADR 0090). */
const INVITE_NOTE_SHOWN = 300;
/** A name typed on an invitation link's page, as the admins' email shows it (ADR 0068). */
const JOIN_NAME_SHOWN = 60;
/** An admin's reason for denying a request to join, as long as it is kept. */
const JOIN_REASON_SHOWN = 300;

/**
 * One email's content: our words in the subject, preheader, headline and buttons; what people typed or
 * agents wrote only in the body, made inert. `sender`: the self-hosted server's host, or null on agentes.chat.
 */
function docOf(t: EmailTemplate, sender: string | null): EmailDoc {
  const lang = emailLocale(t.locale);
  const w = WORDS[lang];
  const doc = (
    subject: string,
    preheader: string,
    headline: string,
    blocks: Block[],
    why: string,
    scene?: Scene,
  ): EmailDoc => ({
    lang,
    subject,
    preheader,
    headline,
    scene,
    blocks,
    footer: [why, w.sentBy(sender)],
  });
  const fallback = (url: string): Block => ({ fallback: w.fallback, url });
  switch (t.kind) {
    case "verify_email": {
      const c = w.verify;
      return doc(
        c.subject,
        c.preheader,
        c.headline,
        [{ p: c.body }, { button: c.button, url: t.url }, { small: c.small }, fallback(t.url)],
        c.why,
      );
    }
    case "password_reset": {
      const c = w.reset;
      return doc(
        c.subject,
        c.preheader,
        c.headline,
        [{ p: c.body }, { button: c.button, url: t.url }, { note: c.note }, { small: c.small }, fallback(t.url)],
        c.why,
      );
    }
    case "invitation": {
      const c = w.invitation;
      const org = inertText(t.orgName);
      const role = w.role[t.role] ?? inertText(t.role);
      return doc(
        c.subject,
        c.preheader,
        c.headline,
        [
          { p: c.body(inertText(t.inviterName), t.inviterEmail ? inertText(t.inviterEmail) : null, org, role) },
          ...(t.note?.trim()
            ? [{ note: c.noteFrom(inertText(t.inviterName), inertText(t.note, INVITE_NOTE_SHOWN)) }]
            : []),
          { p: c.what },
          { button: c.button, url: t.url },
          { small: c.small },
          fallback(t.url),
        ],
        c.why(org),
        { crew: crewOr(t.crew) },
      );
    }
    case "invite_request": {
      const c = w.inviteRequest;
      const org = inertText(t.orgName);
      return doc(
        c.subject,
        c.preheader,
        c.headline,
        [{ p: c.body(inertText(t.email), org) }, { p: c.next }, { button: c.button, url: t.url }],
        c.why(org),
      );
    }
    case "calendar_invite": {
      const c = w.calendar;
      const org = inertText(t.orgName);
      return doc(
        c.subject,
        c.preheader(t.when),
        c.headline,
        [
          {
            facts: [
              [c.facts.event, inertText(t.title, 120)],
              [c.facts.when, t.when],
              [c.facts.org, org],
              [c.facts.by, inertText(t.inviterName) || c.someone],
            ],
          },
          { button: c.button, url: t.url },
        ],
        c.why(org),
      );
    }
    case "waitlist_confirm": {
      const c = w.waitlist;
      return doc(
        c.subject,
        c.preheader,
        c.headline,
        [
          { p: c.body(t.email ? inertText(t.email) : null) },
          { p: c.approve },
          { button: c.button, url: t.url },
          { small: c.small },
          fallback(t.url),
        ],
        c.why,
      );
    }
    case "early_access": {
      const c = w.earlyAccess;
      return doc(
        c.subject,
        c.preheader(t.days),
        c.headline,
        [
          { p: c.body(inertText(t.email)) },
          { p: c.what },
          { button: c.button, url: t.url },
          { small: c.small(t.days) },
          fallback(t.url),
        ],
        c.why,
        { crew: ONBOARDING_CREW },
      );
    }
    case "early_access_allowed": {
      const c = w.earlyAccessAllowed;
      return doc(
        c.subject,
        c.preheader,
        c.headline,
        [{ p: c.body(inertText(t.email)) }, { button: c.button, url: t.url }, fallback(t.url)],
        c.why,
        { crew: ONBOARDING_CREW },
      );
    }
    case "budget": {
      const c = w.budget;
      const org = inertText(t.orgName);
      return doc(
        c.subject[t.level],
        c.preheader[t.level],
        c.headline[t.level],
        [
          {
            people: [
              {
                name: inertText(t.agentName) || w.anAgent,
                agent: t.agentColor ?? "sky",
                detail: c.used(`${Math.round(t.percent)}%`, org),
              },
            ],
          },
          t.level === "warning" ? { p: c.warning } : { note: c.exhausted, tone: "warn" },
          { button: c.button, url: t.url },
        ],
        c.why(org),
      );
    }
    case "approval_digest": {
      const c = w.digest;
      const org = inertText(t.orgName);
      const n = t.items.length;
      const shown = t.items.slice(0, 10);
      return doc(
        c.subject(n),
        c.preheader,
        c.headline(n),
        [
          { p: c.body(n, org) },
          {
            people: shown.map((i) => ({
              name: inertText(i.agentName) || w.anAgent,
              agent: i.agentColor ?? "sky",
              detail: `${inertText(i.title, 120)} · ${c.age(Math.max(1, Math.round(i.ageHours)))}`,
            })),
          },
          ...(n > shown.length ? [{ small: c.more(n - shown.length) }] : []),
          { button: c.button(n), url: t.url },
        ],
        c.why(org, t.afterHours),
      );
    }
    case "computer_ready": {
      const c = w.ready;
      const org = inertText(t.orgName);
      // A plan signs in for an agent, so with no agent the first step is making one.
      const first = !t.hasAgents ? "create" : t.needsAi ? "ai" : "task";
      const order: (keyof typeof c.steps)[] = t.hasAgents
        ? [...(t.needsAi ? (["ai"] as const) : []), "task", "watch"]
        : ["create", ...(t.needsAi ? (["ai"] as const) : [])];
      // `url` is the workspace in every job, however old: the button's address follows its step.
      const home = t.url.replace(/[?#].*$/, "").replace(/\/$/, "");
      const url = { ai: `${home}?connect=ai`, task: home, create: `${home}/agents/new` }[first];
      const num = (v: number) => v.toLocaleString(lang, { maximumFractionDigits: 1 });
      return doc(
        c.subject,
        c.preheader[first],
        c.headline,
        [
          { p: c.body(org) },
          ...(t.specs
            ? [
                {
                  facts: [
                    [c.facts.cpus, num(t.specs.cpus)],
                    [c.facts.memory, `${num(t.specs.memoryGb)} GB`],
                    [c.facts.disk, `${num(t.specs.diskGb)} GB`],
                  ] as [string, string][],
                },
              ]
            : []),
          { h2: c.next },
          { steps: order.map((s) => c.steps[s]) },
          { button: c.button[first], url },
        ],
        c.why(org),
        { crew: crewOr(t.crew), computer: c.computer },
      );
    }
    case "join_request": {
      const c = w.joinRequest;
      const org = inertText(t.orgName);
      // The address proved itself with a code (ADR 0072), so it is a mailto link, which copies whole. Only an address
      // the ask route would accept (`z.email()`): its characters stand as they are in a mailto URL. Anything else
      // stays typed text.
      const address = z.email().safeParse(t.email).success ? { mail: t.email } : inertText(t.email);
      return doc(
        c.subject,
        c.preheader,
        c.headline,
        [
          { people: [{ name: inertText(t.name, JOIN_NAME_SHOWN), detail: address }] },
          { p: c.body(org) },
          { note: c.note },
          { button: c.approve, url: t.url, also: { label: c.deny, url: t.denyUrl, danger: true } },
          { small: c.more },
        ],
        c.why(org),
      );
    }
    case "join_answer": {
      const a = w.joinAnswer;
      const org = inertText(t.orgName);
      const who = inertText(t.approverName ?? "") || a.someone;
      const url = t.url ?? "";
      if (t.outcome === "joined") {
        const c = a.joined;
        return doc(
          c.subject,
          c.preheader,
          c.headline,
          [{ p: c.body(who, org, w.role[t.role ?? "member"] ?? "") }, { button: c.button, url }],
          a.why(org),
          { crew: crewOr(t.crew) },
        );
      }
      if (t.outcome === "invited") {
        const c = a.invited;
        return doc(
          c.subject,
          c.preheader,
          c.headline,
          [{ p: c.body(who, org) }, { p: c.next }, { button: c.button, url }, fallback(url)],
          a.why(org),
          { crew: crewOr(t.crew) },
        );
      }
      const c = a.denied;
      const reason = t.reason?.trim();
      return doc(
        c.subject,
        c.preheader,
        c.headline,
        [
          { p: c.body(org) },
          ...(reason ? [{ note: c.reason(inertText(reason, JOIN_REASON_SHOWN)) }] : []),
          { small: c.small },
        ],
        a.why(org),
      );
    }
    case "join_code": {
      const c = w.joinCode;
      const org = inertText(t.orgName);
      return doc(
        c.subject(t.code),
        c.preheader,
        c.headline,
        [{ p: c.body(org) }, { code: t.code }, { small: c.small }],
        c.why(org),
      );
    }
    case "deletion_code": {
      const c = w.deletionCode;
      const org = t.orgName === undefined ? null : inertText(t.orgName);
      return doc(
        org === null ? c.subjectAccount(t.code) : c.subjectWorkspace(t.code),
        c.preheader,
        c.headline,
        [
          { p: org === null ? c.account(inertText(t.email)) : c.workspace(org) },
          { code: t.code },
          { small: t.support ? c.support(t.support) : c.noSupport },
        ],
        org === null ? c.whyAccount : c.whyWorkspace(org),
      );
    }
    case "autonomy_report": {
      const c = w.autonomy;
      const num = (v: number, digits = 0) => v.toLocaleString(lang, { maximumFractionDigits: digits });
      const money = (nano: number) =>
        `US$\u00a0${nanoUsdToUsd(nano).toLocaleString(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      // An average keeps a decimal, except a count of tokens.
      const shown = (metric: string, v: number, average = false) =>
        metric === "noiseCostNanoUsd" ? money(v) : num(v, average && metric !== "noiseTokens" ? 1 : 0);
      const counts = (list: { metric: string; today: number; average: number }[]): Block => ({
        facts: list.map((m) => [
          c.metric[m.metric] ?? m.metric,
          c.value(shown(m.metric, m.today), shown(m.metric, m.average, true)),
        ]),
      });
      // A workspace's name is typed text: a fact's value, which wraps, never its label.
      const top = (list: { name: string; count: number; costNanoUsd?: number }[]): Block =>
        list.length > 0
          ? {
              facts: list.map((x) => [
                num(x.count),
                x.costNanoUsd === undefined ? inertText(x.name) : `${inertText(x.name)} · ${money(x.costNanoUsd)}`,
              ]),
            }
          : { small: c.none };
      const noise = t.noise.find((m) => m.metric === "noiseRuns")?.today ?? 0;
      return doc(
        c.subject(t.day, num(t.totalStalls), num(noise)),
        c.preheader,
        c.headline(t.day),
        [
          { p: c.body },
          { h2: c.stalls },
          counts(t.stalls),
          { h2: c.noise },
          counts(t.noise),
          { h2: c.topStalls },
          top(t.topStalls),
          { h2: c.topNoise },
          top(t.topNoise),
          { small: c.table(t.day) },
        ],
        c.why,
      );
    }
    case "workspace_deleting": {
      const c = w.deleting;
      const org = inertText(t.orgName);
      const { day, time } = dayAndTime(new Date(t.dueAt), t.timeZone, lang);
      return doc(
        c.subject(day),
        c.preheader,
        c.headline,
        [
          { p: c.body(inertText(t.byName) || w.someone, org, day, time) },
          ...(t.owner ? [{ p: c.owner }, { button: c.button, url: t.url }] : [{ small: c.member }]),
        ],
        c.why(org),
      );
    }
    case "workspace_restored": {
      const c = w.restored;
      const org = inertText(t.orgName);
      return doc(
        c.subject,
        c.preheader,
        c.headline,
        [{ p: c.body(inertText(t.byName) || w.someone, org) }, { button: c.button, url: t.url }],
        c.why(org),
      );
    }
    case "app_connected": {
      const c = w.appConnected;
      const org = inertText(t.orgName);
      return doc(
        c.subject,
        c.preheader,
        c.headline,
        [{ p: c.body(inertText(t.appName), org) }, { note: c.note }, { button: c.button, url: t.url }],
        c.why(org),
      );
    }
    case "account_deleted": {
      const c = w.accountDeleted;
      const names = new Intl.ListFormat(lang, { type: "conjunction" })
        .formatToParts(t.orgNames.map((name) => inertText(name)))
        .map((part): Inline => (part.type === "element" ? { b: part.value } : part.value));
      return doc(
        c.subject,
        c.preheader,
        c.headline,
        [
          { p: c.body(inertText(t.email)) },
          ...(t.dueAt && t.orgNames.length > 0
            ? [{ p: c.closes(t.orgNames.length, dayAndTime(new Date(t.dueAt), t.timeZone, lang).day, names) }]
            : []),
          { small: t.support ? c.support(t.support) : c.noSupport },
        ],
        c.why,
      );
    }
  }
}

/**
 * An email in our look, in its language. `art`: where its pictures come from; without one (a direct
 * call), from its link's own server.
 */
export function renderEmail(
  t: EmailTemplate,
  art: EmailArt = emailArtAt(t.url && URL.canParse(t.url) ? new URL(t.url).origin : ""),
) {
  const sender = URL.canParse(art.home) && !isAgentesCloud(art.home) ? new URL(art.home).host : null;
  const doc = docOf(t, sender);
  return { subject: doc.subject, preheader: doc.preheader, ...renderDoc(doc, art) };
}

/**
 * Recipients grouped by language, one email per group. The pt-BR group keeps
 * `key` as is (jobs queued before locales existed dedupe the same); others add ":en".
 */
export function emailsByLocale(recipients: { email: string; locale: EmailLocale }[], key: string) {
  const groups = new Map<EmailLocale, string[]>();
  for (const r of recipients) groups.set(r.locale, [...(groups.get(r.locale) ?? []), r.email]);
  return [...groups].map(([locale, to]) => ({ locale, to, key: locale === "pt-BR" ? key : `${key}:${locale}` }));
}

/**
 * Queues an email (outbox job `email.send`), in the caller's transaction.
 * `key` is the idempotency key: the same key is sent once (outbox dedupe and
 * the provider's Idempotency-Key).
 */
export async function queueEmail(
  tx: Executor,
  input: {
    orgId: string | null;
    key: string;
    to: string[];
    template: EmailTemplate;
    maxAttempts?: number;
    runAt?: Date;
  },
) {
  await enqueue(tx, {
    orgId: input.orgId,
    kind: "email.send",
    payload: { key: input.key, to: input.to, template: input.template },
    dedupeKey: `email:${input.key}`,
    maxAttempts: input.maxAttempts ?? 6,
    runAt: input.runAt,
  });
}

/** Job `email.send`. Retries on transient provider errors; permanent ones fail the job. */
export async function sendQueuedEmail(sender: EmailSender, payload: Record<string, unknown>, art?: EmailArt) {
  const to = Array.isArray(payload.to) ? payload.to.map(String) : [];
  if (to.length === 0) throw new PermanentJobError("email without recipients");
  const { subject, html, text, inline } = renderEmail(payload.template as EmailTemplate, art);
  try {
    await sender.send({
      subject,
      html,
      text,
      ...(inline.length > 0 ? { inline } : {}),
      to,
      idempotencyKey: String(payload.key),
      tags: [{ name: "kind", value: (payload.template as EmailTemplate).kind }],
    });
  } catch (error) {
    if (error instanceof EmailError && !error.retryable) throw new PermanentJobError(error.message);
    throw error;
  }
}

/** The 80%/100% budget email to the agent's owner, or the admins without one (once per agent, month and level). */
export async function queueBudgetEmail(
  db: Database,
  publicUrl: string,
  e: {
    agent: { id: string; orgId: string; name: string; ownerUserId: string | null };
    level: "warning" | "exhausted";
    spentNanoUsd: number;
    budgetNanoUsd: number;
  },
) {
  // The owner, or the org's admins when the agent has none.
  const recipientIds = e.agent.ownerUserId ? [e.agent.ownerUserId] : await adminIds(db, e.agent.orgId);
  if (recipientIds.length === 0) return;
  const recipients = await db
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(inArray(users.id, recipientIds));
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, e.agent.orgId));
  if (recipients.length === 0 || !org) return;
  const [look] = await db.select({ appearance: agents.appearance }).from(agents).where(eq(agents.id, e.agent.id));
  const month = new Date().toISOString().slice(0, 7);
  const groups = emailsByLocale(
    recipients.map((r) => ({ email: r.email, locale: emailLocale(r.locale) })),
    `budget:${e.agent.id}:${month}:${e.level}`,
  );
  for (const group of groups) {
    await queueEmail(db, {
      orgId: e.agent.orgId,
      key: group.key,
      to: group.to,
      template: {
        kind: "budget",
        locale: group.locale,
        level: e.level,
        agentName: e.agent.name,
        agentColor: look?.appearance?.color,
        orgName: org.name,
        percent: budgetPercent(e.spentNanoUsd, e.budgetNanoUsd),
        url: `${publicUrl.replace(/\/$/, "")}/org/${e.agent.orgId}/agents/${e.agent.id}?tab=settings&sec=budget`,
      },
    });
  }
}

/**
 * Worker: approvals pending longer than `afterHours` get one digest email per
 * approver (owner of the agent + admins), and are marked so nobody is emailed
 * twice about the same request.
 */
export async function queueApprovalDigests(db: Database, publicUrl: string, afterHours: number, now = new Date()) {
  const due = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.status, "pending"),
        isNull(approvals.remindedAt),
        lt(approvals.createdAt, new Date(now.getTime() - afterHours * 3600_000)),
      ),
    )
    .limit(500);
  if (due.length === 0) return 0;
  const agentRows = await db
    .select({ id: agents.id, name: agents.name, appearance: agents.appearance })
    .from(agents)
    .where(inArray(agents.id, [...new Set(due.map((a) => a.agentId))]));
  const agentOf = new Map(agentRows.map((a) => [a.id, a]));
  let queued = 0;
  for (const orgId of new Set(due.map((a) => a.orgId))) {
    const mine = due.filter((a) => a.orgId === orgId);
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    const byUser = new Map<string, typeof mine>();
    for (const a of mine) for (const u of await approverIds(db, a)) byUser.set(u, [...(byUser.get(u) ?? []), a]);
    const people = new Map(
      (byUser.size
        ? await db
            .select({ id: users.id, email: users.email, locale: users.locale })
            .from(users)
            .where(inArray(users.id, [...byUser.keys()]))
        : []
      ).map((u) => [u.id, u]),
    );
    await db.transaction(async (tx) => {
      for (const [userId, items] of byUser) {
        const person = people.get(userId);
        if (!person) continue;
        await queueEmail(tx, {
          orgId,
          key: `approval-digest:${userId}:${items
            .map((i) => i.id)
            .sort()
            .join(",")
            .slice(0, 200)}`,
          to: [person.email],
          template: {
            kind: "approval_digest",
            locale: emailLocale(person.locale),
            orgName: org?.name ?? "",
            items: items.map((i) => ({
              agentName: agentOf.get(i.agentId)?.name ?? "",
              agentColor: agentOf.get(i.agentId)?.appearance?.color,
              title: i.title,
              ageHours: (now.getTime() - i.createdAt.getTime()) / 3600_000,
            })),
            // One request: the button opens it.
            url: `${publicUrl.replace(/\/$/, "")}/org/${orgId}/approvals${items.length === 1 ? `?open=${items[0]?.id}` : ""}`,
            afterHours,
          },
        });
        queued++;
      }
      await tx
        .update(approvals)
        .set({ remindedAt: now })
        .where(
          inArray(
            approvals.id,
            mine.map((a) => a.id),
          ),
        );
    });
  }
  return queued;
}

/** The query parameter an emailed invitation link carries its `invitationMailProof` in (ADR 0090). */
export const INVITATION_MAIL_PARAM = "mail";

/**
 * An invitation's link as its own email carries it (ADR 0090): `url` (the link anyone it's shown to can copy) with the
 * proof that only the message has, so accepting from it confirms the address.
 */
export function invitationMailLink(secret: string, invitationId: string, url: string): string {
  return `${url}?${INVITATION_MAIL_PARAM}=${invitationMailProof(secret, invitationId)}`;
}

/**
 * Invitation email (create, batch and resend). The key changes with each new link.
 * In the invitee's language when they already have an account, else the inviter's. With `secret` (`AGENTES_SECRET`,
 * always there on a server), its link carries the proof that it came by email (`invitationMailLink`); without it, the
 * link alone, which confirms no address.
 */
export async function queueInvitationEmail(
  db: Executor,
  input: {
    orgId: string;
    invitationId: string;
    email: string;
    role: string;
    url: string;
    inviterId: string;
    secret?: string;
  },
) {
  const [invitation] = await db
    .select({ note: organizationInvitations.note, expiresAt: organizationInvitations.expiresAt })
    .from(organizationInvitations)
    .where(eq(organizationInvitations.id, input.invitationId));
  const [inviter] = await db
    .select({ name: users.name, email: users.email, locale: users.locale })
    .from(users)
    .where(eq(users.id, input.inviterId));
  const [invitee] = await db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.email, input.email.trim().toLowerCase()));
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, input.orgId));
  await queueEmail(db, {
    orgId: input.orgId,
    // One per sending: the link stays the same when sent again (ADR 0090), its expiry doesn't.
    key: `invite:${input.invitationId}:${invitation?.expiresAt.getTime() ?? input.url.slice(-16)}`,
    to: [input.email],
    template: {
      kind: "invitation",
      locale: emailLocale(invitee?.locale ?? inviter?.locale),
      orgName: org?.name ?? "",
      inviterName: inviter?.name ?? "",
      inviterEmail: inviter?.email,
      crew: await emailCrew(db, input.orgId),
      url: input.secret ? invitationMailLink(input.secret, input.invitationId, input.url) : input.url,
      role: input.role,
      note: invitation?.note ?? null,
    },
  });
}
