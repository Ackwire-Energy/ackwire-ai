import i18next, { type TFunction } from "i18next";
import { ApiError, NetworkError } from "../api/http";
import type { AuthConfig, OrgStanding } from "../api/types";
import { billingHoldOf } from "./billing";
import { MAX_UPLOAD_MB } from "./files";
import { limitRefusalText } from "./limits";
import { endSentence } from "./text";

/** No sign-in in the last 10 minutes, which adding a password takes. */
export const REAUTH_SIGN_IN = "reauth.sign_in";
/** No password, or a wrong one, where it proves it's the person (deleting on a server that sends no email). */
export const REAUTH_PASSWORD = "reauth.password";

/**
 * Server error codes the app says in the person's language (the server's
 * own message is English). Anything else falls back to that message.
 */
const KNOWN = {
  "agent.handle_taken": "newAgent.errors.handleTaken",
  "agent_proposal.decided": "errors.agentProposal.decided",
  "approval.always_unavailable": "errors.approval.alwaysUnavailable",
  "agent_proposal.expired": "errors.agentProposal.expired",
  "agent_proposal.routine_made": "errors.agentProposal.routineMade",
  "agent_proposal.no_routine": "errors.agentProposal.noRoutine",
  "mail.account_not_found": "errors.mail.accountNotFound",
  "mail.from_not_mailbox": "errors.mail.fromNotMailbox",
  "mail.owner_only": "errors.mail.ownerOnly",
  "org.last_owner": "errors.org.lastOwner",
  send_without_recipients: "mail.agent.saveError.send_without_recipients",
  "artifact.file_too_large": "errors.artifact.fileTooLarge",
  "artifact.file_required": "errors.artifact.fileRequired",
  "artifact.file_name_required": "errors.artifact.fileNameRequired",
  "artifact.not_found": "errors.artifact.notFound",
  "machine.forbidden": "errors.machine.forbidden",
  "machine.not_found": "errors.machine.notFound",
  "machine.name_required": "errors.machine.nameRequired",
  "machine.pairing_invalid": "errors.machine.pairingInvalid",
  "machine.pairing_off": "errors.machine.pairingOff",
  "machine.target_offline": "errors.machine.targetOffline",
  "machine.target_not_found": "errors.machine.targetNotFound",
  "machine.target_same": "errors.machine.targetSame",
  "machine.target_paused": "errors.machine.targetPaused",
  "agent_group.not_found": "errors.agentGroup.notFound",
  "agent_group.too_many": "errors.agentGroup.tooMany",
  "thread.context_not_visible": "errors.thread.contextNotVisible",
  "thread.archived": "errors.thread.archived",
  "thread.has_replies": "errors.thread.hasReplies",
  "thread.range_has_replies": "errors.thread.rangeHasReplies",
  "thread.move_other_channel": "errors.thread.moveOtherChannel",
  "thread.not_allowed": "errors.thread.notAllowed",
  "thread.range_invalid": "errors.thread.rangeInvalid",
  "thread.range_empty": "errors.thread.rangeEmpty",
  "thread.range_too_long": "errors.thread.rangeTooLong",
  "thread.title_too_long": "errors.thread.titleTooLong",
  "thread.no_context": "errors.thread.noContext",
  "thread.not_undoable": "errors.thread.notUndoable",
  "thread.forum": "errors.thread.forum",
  "mission.not_found": "errors.mission.notFound",
  "mission.not_owner": "errors.mission.notOwner",
  "mission.not_allowed": "errors.mission.notAllowed",
  "mission.not_participant": "errors.mission.notParticipant",
  "mission.agent_unavailable": "errors.mission.agentUnavailable",
  "mission.no_computer": "errors.mission.noComputer",
  "mission.computer_offline": "errors.mission.computerOffline",
  "mission.exec_disabled": "errors.mission.execDisabled",
  "mission.runner_outdated": "errors.mission.runnerOutdated",
  "mission.exists": "errors.mission.exists",
  "mission.closed": "errors.mission.closed",
  "mission.wrong_status": "errors.mission.wrongStatus",
  "mission.paused": "errors.mission.paused",
  "mission.invalid": "errors.mission.invalid",
  "mission.bad_folder": "errors.mission.badFolder",
  "mission.bad_option": "errors.mission.badOption",
  "mission.decision_taken": "errors.mission.decisionTaken",
  "mission.decision_not_found": "errors.mission.decisionNotFound",
  "mission.review_not_found": "errors.mission.reviewNotFound",
  "mission.review_note_required": "errors.mission.reviewNoteRequired",
  "mission.suggestion_not_found": "errors.mission.suggestionNotFound",
  "mission.is_owner": "errors.mission.isOwner",
  "mission.participant_cannot_see": "errors.mission.cannotSee",
  "mission.not_your_computer": "errors.mission.notYourComputer",
  "mission.needs_computer": "errors.mission.needsComputer",
  "mission.unavailable": "errors.mission.unavailable",
  "mission.machine_changed": "errors.mission.machineChanged",
  "run.not_continuable": "errors.run.notContinuable",
  "run.agent_busy": "errors.run.agentBusy",
  "run.continue_forbidden": "errors.run.continueForbidden",
  "run.not_restartable": "errors.run.notRestartable",
  "routine.too_frequent": "errors.routine.tooFrequent",
  "routine.too_many": "errors.routine.tooMany",
  "routine.creator_cannot_post": "errors.routine.creatorCannotPost",
  "routine.take_over_no_access": "errors.routine.takeOverNoAccess",
  "routine.act_take_over": "errors.routine.actTakeOver",
  "routine.agent_not_in_channel": "errors.routine.agentNotInChannel",
  "routine.webhook_paused": "errors.routine.webhookPaused",
  "audience.plan_owner_only": "aiAccounts.errors.planOwnerOnly",
  "wiki.no_access": "errors.wiki.noAccess",
  "wiki.audience_forbidden": "errors.wiki.audienceForbidden",
  "wiki.audience_excludes_you": "errors.wiki.audienceExcludesYou",
  "role.name_required": "errors.role.nameRequired",
  "role.name_long": "errors.role.nameLong",
  "role.too_many": "errors.role.tooMany",
  "role.grant_forbidden": "errors.role.grantForbidden",
  "role.above_you": "errors.role.aboveYou",
  "role.base": "errors.role.base",
  "role.unknown": "errors.role.unknown",
  "role.order_incomplete": "errors.role.orderIncomplete",
  "connector.label_taken": "errors.connector.labelTaken",
  "connector.label_invalid": "errors.connector.labelInvalid",
  "connector.other_account": "errors.connector.otherAccount",
  "connector.account_unknown": "errors.connector.accountUnknown",
  "connector.other_server": "errors.connector.otherServer",
  "connector.gone": "errors.connector.gone",
  "connector.unfinished": "errors.connector.unfinished",
  "connector.unavailable": "errors.connector.unavailable",
  // Facts only (the phone shows this one): the web's onboarding says `standing.createUnpaid` beside the way to pay.
  "org.create_unpaid": "standing.createInactive",
  "machine.managed": "computerSetup.managedNotRemovable",
  "machine.managed_access": "computerSetup.managedAccess",
  "join.link_closed": "errors.join.linkClosed",
  "join.full": "errors.join.full",
  "join.rate_limited": "errors.join.rateLimited",
  "join.link_busy": "errors.join.linkBusy",
  "join.member": "errors.join.member",
  "join.denied": "errors.join.denied",
  "join.answered": "errors.join.answered",
  "join.expired": "errors.join.expired",
  "join.code_wrong": "errors.code.wrong",
  "join.code_expired": "errors.code.expired",
  "join.code_tries": "errors.code.tries",
  "join.code_limit": "errors.code.limit",
  "join.code_wait": "errors.code.wait",
  "join.code_needed": "errors.join.codeNeeded",
  "reauth.code": "errors.reauth.code",
  "reauth.code_wrong": "errors.code.wrong",
  "reauth.code_expired": "errors.code.expired",
  "reauth.code_tries": "errors.code.tries",
  "reauth.code_limit": "errors.code.limit",
  "reauth.code_wait": "errors.code.wait",
  "invitation.ask_to_join": "errors.invitation.askToJoin",
  "org.create_invite_only": "errors.org.createInviteOnly",
  "org.not_restorable": "errors.org.notRestorable",
  [REAUTH_PASSWORD]: "errors.reauth.password",
  [REAUTH_SIGN_IN]: "errors.reauth.signIn",
  EARLY_ACCESS_OTHER_EMAIL: "auth.earlyAccess.otherEmail",
  EARLY_ACCESS_EMAIL_UNVERIFIED: "auth.earlyAccess.unverified",
  // A provider's sign-up on a closed server comes back to /login with this code.
  SIGNUP_CLOSED: "auth.flow.closedLead",
  account_not_linked: "auth.unconfirmed",
  // A provider that hasn't confirmed its own address, to a confirmed account here (apps/server auth.ts `authHandler`).
  provider_email_unverified: "auth.providerUnverified",
  human_check: "errors.humanCheck",
  human_check_blocked: "errors.humanCheckBlocked",
  // TypeSafe refused the key pasted for Jev: said under its field, nothing kept.
  jev_key_invalid: "jev.steps.invalid",
  // GIPHY refused the key pasted for GIFs (ADR 0091): said under its field, nothing kept.
  gif_key_invalid: "settings.media.giphy.invalid",
  // A provider's own check refused a key on save (OpenRouter's): nothing kept.
  provider_key_invalid: "settings.keyRefused",
  provider_key_management: "settings.keyManagement",
  "github.repo_missing": "errors.github.repoMissing",
  "github.ref_missing": "errors.github.refMissing",
  // `count`: minutes until GitHub stops limiting the server.
  "github.limited": "errors.github.limited",
  "github.unreachable": "errors.github.unreachable",
  "skill.no_skill_md": "errors.skill.noSkillMd",
  "skill.too_many_skills": "errors.skill.tooManySkills",
  "skill.invalid_name": "errors.skill.invalidName",
  "skill.invalid_description": "errors.skill.invalidDescription",
  "skill.too_large": "errors.skill.tooLarge",
  "skill.too_many_files": "errors.skill.tooManyFiles",
  "skill.connection_gone": "errors.skill.connectionGone",
  "handle.invalid": "errors.handle.invalid",
  "handle.taken": "errors.handle.taken",
  "handle.taken_by_agent": "errors.handle.takenByAgent",
  slug_taken: "errors.wiki.titleTaken",
  "wiki.title_characters": "errors.wiki.titleCharacters",
  "wiki.title_empty_slug": "errors.wiki.titleNoLetters",
  // GIFs and stickers (ADR 0091): off in the workspace (or no GIF search on this server), a GIF gone, or the GIF
  // search not answering.
  "message.media_off": "errors.media.off",
  "message.media_not_found": "errors.media.notFound",
  "gifs.off": "errors.media.gifsOff",
  "gifs.unavailable": "errors.media.gifsUnavailable",
} as const;

/** Better Auth's code when a blocked account tries to sign in (the server's `session.create.before` hook). */
export const ACCOUNT_BLOCKED = "ACCOUNT_BLOCKED";

/** Better Auth's code when an early-access link signs up another address than the one it was sent to. */
export const EARLY_ACCESS_OTHER_EMAIL = "EARLY_ACCESS_OTHER_EMAIL";

/**
 * Better Auth's refusal of a provider sign-in to an address whose password account isn't confirmed yet: it links none,
 * since whoever made that account may not own the address (mirrors apps/server auth.ts).
 */
export const ACCOUNT_NOT_LINKED = "account_not_linked";

/** Where a restriction on agentes.chat Cloud is contested. */
export const LEGAL_EMAIL = "legal@agentes.chat";

/** The reason agentes.chat Cloud's automatic hold is set with: it reads as the review line, never "on hold: review". */
const REVIEW_REASON = "review";

/**
 * Mirror of what agentes.chat Cloud's automatic hold names, as `review.<category>`: the review line says it. Any other
 * category reads as plain `review`.
 */
const REVIEW_FLAGGED = ["phishing_impersonation", "account_takeover", "fraud", "illegal_content"] as const;

/** The category a `review.<category>` reason names when the apps know it (`standing.cloud.reviewWhat`), else undefined. */
export const reviewFlaggedOf = (reason: string) =>
  REVIEW_FLAGGED.find((category) => reason === `${REVIEW_REASON}.${category}`);

/**
 * Reasons agentes.chat Cloud sets that rest on no Terms section, so nothing to contest: the automatic hold has a line
 * of its own, and `ended` holds a workspace whose plan ended, a billing matter.
 */
const UNCONTESTED: ReadonlySet<string> = new Set([REVIEW_REASON, "ended"]);

/**
 * What the server says of a restriction besides its code: the reason the workspace is told, and on agentes.chat
 * Cloud `cloud` (`"true"` in a run's values, which are text) with a held agent's or a blocked account's kind.
 */
export interface RestrictionFacts {
  reason?: unknown;
  kind?: unknown;
  cloud?: unknown;
}

/**
 * A restriction in the person's words, the one place the apps pick it: a workspace on hold, suspended or being
 * deleted and a held agent (the API's `org.paused`, `org.suspended`, `org.deleting` and `agent.paused`, or a run's
 * `run.org_paused`…), a refused workspace (`org.create_refused`) and a blocked account (`ACCOUNT_BLOCKED`). On
 * agentes.chat Cloud the line of its kind, with the Terms section and how to contest it. Elsewhere the words it always
 * had. Null for any other code.
 */
export function restrictionLine(
  t: TFunction,
  code: string | null | undefined,
  facts?: RestrictionFacts | null,
): string | null {
  const cloud = facts?.cloud === true || facts?.cloud === "true";
  const reason = typeof facts?.reason === "string" ? facts.reason.trim() : "";
  const kind = facts?.kind;
  const email = { email: LEGAL_EMAIL };
  const contested = (line: string) =>
    cloud && !UNCONTESTED.has(reason) ? `${endSentence(line)} ${t("standing.cloud.contest", email)}` : line;
  switch (code?.startsWith("run.") ? code.slice(4).replace("_", ".") : code) {
    case "org.paused": {
      // A billing hold (ADR 0079) is said in words of its own, never as the reason.
      const billing = billingHoldOf({ state: "hold", reason });
      if (billing) return t(`standing.billing.${billing}`);
      const flagged = reviewFlaggedOf(reason);
      if (cloud && flagged)
        return t("standing.cloud.reviewFor", { ...email, what: t(`standing.cloud.reviewWhat.${flagged}`) });
      if (cloud && (reason === REVIEW_REASON || reason.startsWith(`${REVIEW_REASON}.`)))
        return t("standing.cloud.review", email);
      return reason ? contested(t("standing.onHold", { reason })) : t("standing.paused");
    }
    case "org.suspended":
      return reason ? contested(t("standing.suspendedFor", { reason })) : t("standing.suspended");
    case "org.deleting":
      return t("errors.org.deleting");
    case "agent.paused":
      if (cloud && kind === "network") return t("standing.cloud.agentNetwork", email);
      if (cloud && kind === "operator") return t("standing.cloud.agentOperator", email);
      return t("standing.agentPaused");
    case "org.create_refused":
      return cloud ? t("standing.cloud.createRefused", email) : t("standing.createRefused");
    case ACCOUNT_BLOCKED:
      if (cloud && kind === "abuse") return t("standing.cloud.blockedAbuse", email);
      if (cloud && kind === "legal") return t("standing.cloud.blockedLegal", email);
      return contested(t("auth.accountBlocked"));
    default:
      return null;
  }
}

/** The hold banner's line: the reason when the workspace is told one, else what a refused run says. Null unless on hold. */
export function holdText(t: TFunction, standing: OrgStanding | null | undefined): string | null {
  if (standing?.state !== "hold") return null;
  return restrictionLine(t, "org.paused", standing);
}

/** The suspended screen's line: why, when the workspace is told, else that it is closed for now. */
export function suspendedText(t: TFunction, standing: Pick<OrgStanding, "reason" | "cloud"> | null | undefined) {
  const told = standing?.reason ? restrictionLine(t, "org.suspended", standing) : null;
  return told ?? t("standing.screen.text");
}

/**
 * Where a workspace on hold or suspended asks for help: the server's address (`SUPPORT_EMAIL`), else "ask the
 * people who run this server" (`support.ask`). On the Cloud nobody else runs it, so without an address, nothing.
 * Nothing either until `auth-config` answers.
 */
export function supportLineOf(
  config: Pick<AuthConfig, "supportEmail" | "workspaceComputer"> | undefined,
): { email: string } | "ask" | null {
  if (!config) return null;
  if (config.supportEmail) return { email: config.supportEmail };
  return config.workspaceComputer ? null : "ask";
}

/** "Continuar" refused: these say why (anything else is a plain "couldn't continue"). */
export const CONTINUE_ERRORS: ReadonlySet<string> = new Set([
  "run.not_continuable",
  "run.agent_busy",
  "run.continue_forbidden",
]);

export const errorCode = (error: unknown) => (error instanceof ApiError ? error.code : undefined);

/**
 * What the proxy in front answers while the server restarts, is down or too slow: Caddy's 502, 503 and 504, and
 * Cloudflare's 520 to 527 and 530 (as apps/web/public/unavailable.html reads them). The server's own errors carry a
 * code of theirs (its 503 for a computer's error does).
 */
const UNREACHABLE = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

/** No answer from the server itself, only from the proxy in front of it: it may be back in a moment. */
export const serverUnreachable = (error: unknown) =>
  error instanceof ApiError && UNREACHABLE.has(error.status) && error.code === `http_${error.status}`;

/**
 * A message that failed to go out with no answer at all (`fetch` throws a `TypeError`: no network), or only the
 * proxy's while the server restarts: it waits for the connection instead of failing. The server refusing it, or a
 * bug, fails it.
 */
export const sendWaits = (error: unknown) => error instanceof TypeError || serverUnreachable(error);

/** No answer from the server: none at all (`NetworkError`), or only the proxy's while it restarts or is down. */
export const noAnswer = (error: unknown) => error instanceof NetworkError || serverUnreachable(error);

/**
 * A known server code in the person's language, and any other limit (a 429, or `rate_limited`) as "too many tries",
 * since the server says those in English. Null for anything else (the caller keeps its own words). `locale`
 * writes the sizes a limit's refusal names.
 */
export function knownErrorText(t: TFunction, error: unknown, locale = "en"): string | null {
  if (!(error instanceof ApiError)) return null;
  const restriction = restrictionLine(t, error.code, error.params);
  if (restriction) return restriction;
  const limit = limitRefusalText(t, locale, error.code, error.params);
  if (limit) return limit;
  // The person who connected the mailbox is gone or unnamed: no blank name in the sentence.
  if (error.code === "mail.owner_only" && !error.params?.ownerName)
    return t("errors.mail.ownerOnlyUnknown", error.params);
  // Own keys only: a code from an address (`/login?error=toString`) names no line of Object's.
  const key = Object.hasOwn(KNOWN, error.code) ? KNOWN[error.code as keyof typeof KNOWN] : undefined;
  if (key) return t(key, { max: MAX_UPLOAD_MB, ...error.params });
  return error.status === 429 || error.code === "rate_limited" ? t("common.tooMany") : null;
}

/**
 * `knownErrorText` for the person an invitation is for: a full workspace says whom to tell, never its numbers,
 * which are for its admins.
 */
export const invitedErrorText = (t: TFunction, error: unknown, locale?: string): string | null =>
  errorCode(error) === "org.members_full" ? t("errors.org.membersFull") : knownErrorText(t, error, locale);

/**
 * The device says it has no network: a browser's `navigator.onLine`. React Native has none, so the phone says the
 * server is out of reach instead.
 */
const deviceOffline = () => (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine === false;

/** No answer at all, in the person's words: offline, or the server out of reach. */
const noAnswerText = (t: TFunction) => t(deviceOffline() ? "common.offline" : "common.unreachable");

/**
 * The words of a refusal the app doesn't translate: the server's own only for English readers and a 4xx, which the
 * server writes for people (a 5xx's are for the log). The language: `locale`, else `useTranslation`'s `t` (its
 * `lng`), else the app's i18next instance.
 */
function untranslatedText(t: TFunction, error: ApiError, locale?: string): string {
  const language = locale ?? (t as { lng?: unknown }).lng ?? i18next.language;
  const english = typeof language === "string" && language.startsWith("en");
  return english && error.status < 500 && error.message ? error.message : t("common.unknownError");
}

/**
 * A sign-in, sign-up or reset Better Auth refused (`{ status, code, message }`, a block's kind on agentes.chat Cloud)
 * in the person's words: too many tries, a blocked account and the bot check by their codes, no answer (status 0, or
 * only the proxy's), else `untranslatedText`.
 */
export function authErrorText(
  t: TFunction,
  refusal: { status: number; code?: string; message: string } & RestrictionFacts,
): string {
  if (refusal.status === 429) return t("auth.tooManyTries");
  if (refusal.status === 0) return noAnswerText(t);
  const { kind, cloud } = refusal;
  const error = new ApiError(refusal.status, refusal.code ?? `http_${refusal.status}`, refusal.message, {
    kind,
    cloud,
  });
  return knownErrorText(t, error) ?? (noAnswer(error) ? noAnswerText(t) : untranslatedText(t, error));
}

type ProviderRefusal = "cancelled" | "linked" | "noEmail" | "expired" | "server" | "other";

/** Better Auth's codes for a provider sign-in that didn't finish (`/login?error=`), by what the person can do. */
const PROVIDER_REFUSALS: Record<string, ProviderRefusal> = {
  access_denied: "cancelled",
  account_not_linked: "linked",
  unable_to_link_account: "linked",
  account_already_linked_to_different_user: "linked",
  email_does_not_match: "linked",
  email_not_found: "noEmail",
  email_not_verified: "noEmail",
  state_mismatch: "expired",
  state_not_found: "expired",
  invalid_code: "expired",
  no_code: "expired",
  please_restart_the_process: "expired",
  invalid_callback_request: "expired",
  nonce_binding_missing: "expired",
  issuer_mismatch: "expired",
  issuer_missing: "expired",
  server_error: "server",
  internal_server_error: "server",
  unable_to_get_user_info: "server",
  oauth_provider_not_found: "server",
  no_callback_url: "server",
};

/**
 * A provider sign-in the server refused (its code on `/login?error=`), in the person's words, or null for a code the
 * apps don't know. `emails`: the server sends email, so an unconfirmed account can be confirmed (else only its password
 * signs in).
 */
export function providerRefusalText(t: TFunction, code: string, emails: boolean): string | null {
  if (code === ACCOUNT_NOT_LINKED && !emails) return t("auth.unconfirmedNoEmail");
  return knownErrorText(t, new ApiError(403, code, ""));
}

/** A provider sign-in that didn't finish: a code the apps know, else Better Auth's by what the person can do. */
export function signInRefusalText(t: TFunction, code: string, emails: boolean): string {
  const known = providerRefusalText(t, code, emails);
  if (known) return known;
  const refusal: ProviderRefusal = (Object.hasOwn(PROVIDER_REFUSALS, code) && PROVIDER_REFUSALS[code]) || "other";
  return t(`auth.refused.${refusal}`);
}

/**
 * Why a provider's return didn't connect: the code the server's callback sends back (`?connector_error=`,
 * `?github_app_error=`), or the API's own code when the app finished it (the desktop app's window).
 */
const OAUTH_RETURNS = {
  cancelled: "oauthReturn.cancelled",
  expired: "oauthReturn.expired",
  "oauth.link_expired": "oauthReturn.expired",
  used: "oauthReturn.used",
  "oauth.link_used": "oauthReturn.used",
  other_account: "oauthReturn.otherAccount",
  "oauth.other_account": "oauthReturn.otherAccount",
  not_allowed: "common.notAllowed",
  forbidden: "common.notAllowed",
  not_visible: "githubApp.notVisible",
  "github_app.not_visible": "githubApp.notVisible",
  requested: "githubApp.requested",
} as const;

/** A provider's return that didn't connect, by its code, in the person's words (any other code: it failed). */
export const oauthReturnText = (t: TFunction, code: string): string => {
  if (Object.hasOwn(OAUTH_RETURNS, code)) return t(OAUTH_RETURNS[code as keyof typeof OAUTH_RETURNS]);
  // A connector account's own refusal comes as its full code (`connector.other_account`).
  if (code.startsWith("connector.") && Object.hasOwn(KNOWN, code)) return t(KNOWN[code as keyof typeof KNOWN]);
  return t("oauthReturn.failed");
};

/**
 * A failed request in the person's words: a code the app knows, a file too big, a refusal, no answer (offline or the
 * server out of reach), else `untranslatedText`. Never a raw error's own words ("Failed to fetch", "Bad Gateway").
 */
export function errorText(t: TFunction, error: unknown, locale?: string): string {
  if (error instanceof ApiError) {
    const known = knownErrorText(t, error, locale);
    if (known) return known;
    if (error.status === 413) return t("errors.artifact.fileTooLarge", { max: MAX_UPLOAD_MB });
    if (error.status === 403) return t("common.notAllowed");
  }
  if (noAnswer(error)) return noAnswerText(t);
  return error instanceof ApiError ? untranslatedText(t, error, locale) : t("common.unknownError");
}
