import type { TFunction } from "i18next";
import { ApiError } from "@/api/http";
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
} as const;

export const errorCode = (error: unknown) => (error instanceof ApiError ? error.code : undefined);

/** Translated text for a failed request. */
export function errorText(t: TFunction, error: unknown): string {
  if (error instanceof ApiError) {
    const key = KNOWN[error.code as keyof typeof KNOWN];
    if (key) return t(key, { max: MAX_UPLOAD_MB });
    if (error.status === 413) return t("errors.artifact.fileTooLarge", { max: MAX_UPLOAD_MB });
    if (error.status === 403) return t("common.notAllowed");
  }
  return error instanceof Error && error.message ? error.message : t("common.unknownError");
}
