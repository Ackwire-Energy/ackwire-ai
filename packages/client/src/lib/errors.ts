import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
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
  "routine.too_frequent": "errors.routine.tooFrequent",
  "routine.too_many": "errors.routine.tooMany",
  "routine.creator_cannot_post": "errors.routine.creatorCannotPost",
  "routine.take_over_no_access": "errors.routine.takeOverNoAccess",
  "routine.agent_not_in_channel": "errors.routine.agentNotInChannel",
  "org.paused": "standing.paused",
  "org.suspended": "standing.suspended",
  "org.create_refused": "standing.createRefused",
  "agent.paused": "standing.agentPaused",
} as const;

/** "Continuar" refused: these say why (anything else is a plain "couldn't continue"). */
export const CONTINUE_ERRORS: ReadonlySet<string> = new Set([
  "run.not_continuable",
  "run.agent_busy",
  "run.continue_forbidden",
]);

export const errorCode = (error: unknown) => (error instanceof ApiError ? error.code : undefined);

/** A known server code in the person's language; null for anything else (the caller keeps its own words). */
export function knownErrorText(t: TFunction, error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const key = KNOWN[error.code as keyof typeof KNOWN];
  return key ? t(key, { max: MAX_UPLOAD_MB, ...error.params }) : null;
}

/** Translated text for a failed request. */
export function errorText(t: TFunction, error: unknown): string {
  if (error instanceof ApiError) {
    const key = KNOWN[error.code as keyof typeof KNOWN];
    if (key) return t(key, { max: MAX_UPLOAD_MB, ...error.params });
    if (error.status === 413) return t("errors.artifact.fileTooLarge", { max: MAX_UPLOAD_MB });
    if (error.status === 403) return t("common.notAllowed");
  }
  return error instanceof Error && error.message ? error.message : t("common.unknownError");
}
