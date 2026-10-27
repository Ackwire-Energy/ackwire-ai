import {
  BudgetExceededError,
  ConflictError,
  ForbiddenError,
  MachineOfflineError,
  MachinePausedError,
  MachineRequestError,
  MissingCredentialError,
  NotFoundError,
  TooManyError,
  ValidationError,
} from "@agenteschat/engine";
import type { Hook } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { Context, Env } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Every API error has this shape. `code` is stable and machine-readable. */
export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "invalid_request", description: "Stable: the app translates it." }),
      message: z.string().openapi({ example: "name: Required", description: "English fallback." }),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .openapi({ description: "Values for the translated message (names, limits…)." }),
    }),
  })
  .openapi("Error");

export function apiError<S extends ContentfulStatusCode>(
  c: Context,
  status: S,
  code: string,
  message: string,
  params?: Record<string, unknown>,
) {
  return c.json({ error: { code, message, ...(params ? { params } : {}) } }, status);
}

/** OpenAPI response entry for an error status. */
export const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});

/** Turns request validation failures into our error format. */
export function validationHook<E extends Env>(): Hook<unknown, E, string, unknown> {
  return (result, c) => {
    if (!result.success) {
      const message = result.error.issues
        .map((i) => `${i.path.length > 0 ? i.path.join(".") : "body"}: ${i.message}`)
        .join("; ");
      return apiError(c, 400, "invalid_request", message);
    }
  };
}

/** Maps domain errors from `@agenteschat/engine` to HTTP responses. Returns null for unknown errors. */
export function domainErrorResponse(error: unknown, c: Context) {
  if (error instanceof ForbiddenError) return apiError(c, 403, error.code, error.message, error.params);
  if (error instanceof NotFoundError) return apiError(c, 404, error.code, error.message, error.params);
  if (error instanceof ConflictError) return apiError(c, 409, error.code, error.message, error.params);
  if (error instanceof ValidationError) return apiError(c, 400, error.code, error.message, error.params);
  if (error instanceof TooManyError) return apiError(c, 429, error.code, error.message, error.params);
  if (error instanceof BudgetExceededError) {
    return apiError(c, 402, "budget_exceeded", error.message, { agentId: error.agentId });
  }
  if (error instanceof MissingCredentialError) return apiError(c, 400, "missing_credential", error.message);
  // A connected computer (ADR 0025, ADR 0036) that can't take the request now.
  if (error instanceof MachineOfflineError) {
    return apiError(c, 409, "machine.offline", error.message, { name: error.machineName });
  }
  if (error instanceof MachinePausedError) {
    return apiError(c, 409, "machine.paused", error.message, { name: error.machineName, until: error.until });
  }
  if (error instanceof MachineRequestError) return apiError(c, 502, `machine.${error.code}`, error.message);
  return null;
}
