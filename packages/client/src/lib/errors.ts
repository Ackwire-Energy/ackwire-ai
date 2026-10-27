import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
import type { AuthConfig, OrgStanding } from "../api/types";
import { MAX_UPLOAD_MB } from "./files";

/**
 * Server error codes the app says in the person's language (the server's
 * own message is English). Anything else falls back to that message.
 */
const KNOWN = {
  "artifact.file_too_large": "errors.artifact.fileTooLarge",
  "artifact.file_required": "errors.artifact.fileRequired",
  "artifact.file_name_required": "errors.artifact.fileNameRequired",
  "artifact.not_found": "errors.artifact.notFound",
  "machine.no_lifecycle": "errors.machine.noLifecycle",
  "machine.forbidden": "errors.machine.forbidden",
  "machine.not_found": "errors.machine.notFound",
  "machine.name_required": "errors.machine.nameRequired",
  "machine.pairing_invalid": "errors.machine.pairingInvalid",
  "machine.pairing_off": "errors.machine.pairingOff",
  "machine.target_offline": "errors.machine.targetOffline",
  "machine.target_not_found": "errors.machine.targetNotFound",
  "machine.target_same": "errors.machine.targetSame",
  "machine.target_paused": "errors.machine.targetPaused",
  "machine.target_cloud_unavailable": "errors.machine.targetCloudUnavailable",
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
  "audience.plan_terms_required": "aiAccounts.errors.planTermsRequired",
  "plan.personal": "aiAccounts.errors.planPersonal",
  "org.create_refused": "standing.createRefused",
  "machine.managed": "computerSetup.managedNotRemovable",
  "machine.managed_access": "computerSetup.managedAccess",
  "join.link_closed": "errors.join.linkClosed",
  "join.full": "errors.join.full",
  "join.rate_limited": "errors.join.rateLimited",
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
  human_check: "errors.humanCheck",
  human_check_blocked: "errors.humanCheckBlocked",
} as const;

/** Refusals by the workspace's standing (ADR 0056 §8): the plain words, and the words with the reason told. */
const STANDING_REFUSALS = {
  "org.paused": ["standing.paused", "standing.onHold"],
  "org.suspended": ["standing.suspended", "standing.suspendedFor"],
  "agent.paused": ["standing.agentPaused", "standing.agentPaused"],
} as const;

/**
 * A refusal by the workspace's standing in the person's words, with the reason when the workspace is told
 * one: the API's `org.paused`, `org.suspended` and `agent.paused`, or a run's `run.org_paused`… Null for any
 * other code.
 */
export function standingRefusalText(
  t: TFunction,
  code: string | null | undefined,
  params?: Record<string, unknown> | null,
): string | null {
  const plain = code?.startsWith("run.") ? code.slice(4).replace("_", ".") : code;
  const keys = plain ? STANDING_REFUSALS[plain as keyof typeof STANDING_REFUSALS] : undefined;
  if (!keys) return null;
  const reason = typeof params?.reason === "string" ? params.reason.trim() : "";
  return reason ? t(keys[1], { reason }) : t(keys[0]);
}

/** The hold banner's line: the reason when the workspace is told one, else what a refused run says. Null unless on hold. */
export function holdText(t: TFunction, standing: OrgStanding | null | undefined): string | null {
  if (standing?.state !== "hold") return null;
  return standingRefusalText(t, "org.paused", { reason: standing.reason });
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

/** Better Auth's code when a blocked account tries to sign in (the server's `session.create.before` hook). */
export const ACCOUNT_BLOCKED = "ACCOUNT_BLOCKED";

/** A known server code in the person's language; null for anything else (the caller keeps its own words). */
export function knownErrorText(t: TFunction, error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const standing = standingRefusalText(t, error.code, error.params);
  if (standing) return standing;
  const key = KNOWN[error.code as keyof typeof KNOWN];
  return key ? t(key, { max: MAX_UPLOAD_MB, ...error.params }) : null;
}

/**
 * A sign-in, sign-up or reset Better Auth refused (`{ status, code, message }`) in the person's words: too many
 * tries, a blocked account and the bot check by their codes, else its own message.
 */
export function authErrorText(t: TFunction, refusal: { status: number; code?: string; message: string }): string {
  if (refusal.status === 429) return t("auth.tooManyTries");
  if (refusal.code === ACCOUNT_BLOCKED) return t("auth.accountBlocked");
  const known = knownErrorText(t, new ApiError(refusal.status, refusal.code ?? "", refusal.message));
  return known ?? (refusal.message || t("common.unknownError"));
}

/** Translated text for a failed request. */
export function errorText(t: TFunction, error: unknown): string {
  if (error instanceof ApiError) {
    const known = knownErrorText(t, error);
    if (known) return known;
    if (error.status === 413) return t("errors.artifact.fileTooLarge", { max: MAX_UPLOAD_MB });
    if (error.status === 403) return t("common.notAllowed");
  }
  return error instanceof Error && error.message ? error.message : t("common.unknownError");
}
