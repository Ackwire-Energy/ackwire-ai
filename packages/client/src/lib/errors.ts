import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
import type { AuthConfig, OrgStanding } from "../api/types";
import { billingHoldOf } from "./billing";
import { MAX_UPLOAD_MB } from "./files";
import { limitRefusalText } from "./limits";
import { endSentence } from "./text";

/**
 * Server error codes the app says in the person's language (the server's
 * own message is English). Anything else falls back to that message.
 */
const KNOWN = {
  "agent_proposal.decided": "errors.agentProposal.decided",
  "agent_proposal.expired": "errors.agentProposal.expired",
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
  "routine.agent_not_in_channel": "errors.routine.agentNotInChannel",
  "audience.plan_owner_only": "aiAccounts.errors.planOwnerOnly",
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
  "join.code_wrong": "errors.join.codeWrong",
  "join.code_expired": "errors.join.codeExpired",
  "join.code_tries": "errors.join.codeTries",
  "join.code_limit": "errors.join.codeLimit",
  "join.code_wait": "errors.join.codeWait",
  "join.code_needed": "errors.join.codeNeeded",
  "invitation.ask_to_join": "errors.invitation.askToJoin",
  "org.create_invite_only": "errors.org.createInviteOnly",
  EARLY_ACCESS_OTHER_EMAIL: "auth.earlyAccess.otherEmail",
  EARLY_ACCESS_EMAIL_UNVERIFIED: "auth.earlyAccess.unverified",
  // A provider's sign-up on a closed server comes back to /login with this code.
  SIGNUP_CLOSED: "auth.flow.closedLead",
  human_check: "errors.humanCheck",
  human_check_blocked: "errors.humanCheckBlocked",
  // TypeSafe refused the key pasted for Jev: said under its field, nothing kept.
  jev_key_invalid: "jev.steps.invalid",
} as const;

/** Better Auth's code when a blocked account tries to sign in (the server's `session.create.before` hook). */
export const ACCOUNT_BLOCKED = "ACCOUNT_BLOCKED";

/** Better Auth's code when an early-access link signs up another address than the one it was sent to. */
export const EARLY_ACCESS_OTHER_EMAIL = "EARLY_ACCESS_OTHER_EMAIL";

/** Where a restriction on agentes.chat Cloud is contested. */
export const LEGAL_EMAIL = "legal@agentes.chat";

/** The reason agentes.chat Cloud's automatic hold is set with: it reads as the review line, never "on hold: review". */
const REVIEW_REASON = "review";

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
 * A restriction in the person's words, the one place the apps pick it: a workspace on hold or suspended and a held
 * agent (the API's `org.paused`, `org.suspended` and `agent.paused`, or a run's `run.org_paused`…), a refused
 * workspace (`org.create_refused`) and a blocked account (`ACCOUNT_BLOCKED`). On agentes.chat Cloud the line of its
 * kind, with the Terms section and how to contest it. Elsewhere the words it always had. Null for any other code.
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
      if (cloud && reason === REVIEW_REASON) return t("standing.cloud.review", email);
      return reason ? contested(t("standing.onHold", { reason })) : t("standing.paused");
    }
    case "org.suspended":
      return reason ? contested(t("standing.suspendedFor", { reason })) : t("standing.suspended");
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
 * Cloudflare's 520 to 524. The server's own errors carry a code of theirs (its 502 for a computer's error does).
 */
const UNREACHABLE = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

/** No answer from the server itself, only from the proxy in front of it: it may be back in a moment. */
export const serverUnreachable = (error: unknown) =>
  error instanceof ApiError && UNREACHABLE.has(error.status) && error.code === `http_${error.status}`;

/**
 * A message that failed to go out with no answer at all (`fetch` throws a `TypeError`: no network), or only the
 * proxy's while the server restarts: it waits for the connection instead of failing. The server refusing it, or a
 * bug, fails it.
 */
export const sendWaits = (error: unknown) => error instanceof TypeError || serverUnreachable(error);

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
  const key = KNOWN[error.code as keyof typeof KNOWN];
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
 * A sign-in, sign-up or reset Better Auth refused (`{ status, code, message }`, a block's kind on agentes.chat Cloud)
 * in the person's words: too many tries, a blocked account and the bot check by their codes, else its own message.
 */
export function authErrorText(
  t: TFunction,
  refusal: { status: number; code?: string; message: string } & RestrictionFacts,
): string {
  if (refusal.status === 429) return t("auth.tooManyTries");
  const { kind, cloud } = refusal;
  const known = knownErrorText(t, new ApiError(refusal.status, refusal.code ?? "", refusal.message, { kind, cloud }));
  return known ?? (refusal.message || t("common.unknownError"));
}

/** Translated text for a failed request. */
export function errorText(t: TFunction, error: unknown, locale?: string): string {
  if (error instanceof ApiError) {
    const known = knownErrorText(t, error, locale);
    if (known) return known;
    if (error.status === 413) return t("errors.artifact.fileTooLarge", { max: MAX_UPLOAD_MB });
    if (error.status === 403) return t("common.notAllowed");
  }
  return error instanceof Error && error.message ? error.message : t("common.unknownError");
}
