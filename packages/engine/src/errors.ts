/** Domain errors. The HTTP layer maps them to status codes (`apps/server/src/http/errors.ts`). */
export class ForbiddenError extends Error {
  constructor(message = "You don't have permission to do this") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  /** The API error code (`conflict`, `version_conflict`, `slug_taken`…). */
  constructor(
    message: string,
    readonly code: string = "conflict",
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** The agent reached its monthly budget. Checked before every model call. */
export class BudgetExceededError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly spentNanoUsd: number,
    public readonly budgetNanoUsd: number,
  ) {
    super("This agent has used its monthly budget");
    this.name = "BudgetExceededError";
  }
}

/** No usable provider credential (none configured, revoked, or no platform key in this edition). */
export class MissingCredentialError extends Error {
  constructor(message = "This agent has no usable provider credential") {
    super(message);
    this.name = "MissingCredentialError";
  }
}

/** Unique-violation detection that works with postgres.js and PGlite. */
export function isUniqueViolation(error: unknown): boolean {
  let e: unknown = error;
  for (let i = 0; i < 4 && e; i++) {
    if ((e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
