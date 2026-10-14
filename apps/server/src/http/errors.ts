import {
  BudgetExceededError,
  ConflictError,
  ForbiddenError,
  MissingCredentialError,
  NotFoundError,
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
      code: z.string().openapi({ example: "invalid_request" }),
      message: z.string().openapi({ example: "name: Required" }),
    }),
  })
  .openapi("Error");

export function apiError<S extends ContentfulStatusCode>(c: Context, status: S, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
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
  if (error instanceof ForbiddenError) return apiError(c, 403, "forbidden", error.message);
  if (error instanceof NotFoundError) return apiError(c, 404, "not_found", error.message);
  if (error instanceof ConflictError) return apiError(c, 409, "conflict", error.message);
  if (error instanceof ValidationError) return apiError(c, 400, "invalid_request", error.message);
  if (error instanceof BudgetExceededError) return apiError(c, 402, "budget_exceeded", error.message);
  if (error instanceof MissingCredentialError) return apiError(c, 400, "missing_credential", error.message);
  return null;
}
