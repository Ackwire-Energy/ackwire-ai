import { createHmac, timingSafeEqual } from "node:crypto";
import type { KeyWrapper } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { openSecret, randomToken, sealSecret } from "./crypto";
import { NotFoundError, ValidationError } from "./errors";
import { requirePermission } from "./organizations";
import { fireRoutineEvent, type RoutineEvent } from "./routines";

const { webhookEndpoints } = schema;

export type WebhookProvider = "github" | "sentry";
export const WEBHOOK_PROVIDERS: readonly WebhookProvider[] = ["github", "sentry"];

export interface WebhookDeps {
  db: Database;
  keyWrappers: KeyWrapper[];
}

const aadFor = (orgId: string, id: string) => `webhook|${orgId}|${id}`;

/** A webhook whose signature doesn't match (401). */
export class ForbiddenSignatureError extends Error {
  constructor() {
    super("Invalid signature");
    this.name = "ForbiddenSignatureError";
  }
}

/**
 * A new incoming webhook for the org (admins). The secret is shown once, to
 * paste into GitHub or Sentry; we keep it sealed to check signatures.
 */
export async function createWebhookEndpoint(
  deps: WebhookDeps,
  actorId: string,
  orgId: string,
  provider: WebhookProvider,
  publicUrl: string,
) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  if (!WEBHOOK_PROVIDERS.includes(provider)) throw new ValidationError("Unknown provider");
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const id = crypto.randomUUID();
  const secret = randomToken(32);
  const sealed = await sealSecret(wrapper, secret, aadFor(orgId, id));
  await deps.db.insert(webhookEndpoints).values({
    id,
    orgId,
    provider,
    secretCiphertext: sealed.ciphertext,
    wrappedDataKey: sealed.wrappedDataKey,
    kekId: sealed.kekId,
    createdByUserId: actorId,
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "webhook.created",
    target: { type: "webhook_endpoint", id },
    details: { provider },
  });
  return { id, provider, url: `${publicUrl.replace(/\/$/, "")}/api/webhooks/${provider}/${id}`, secret };
}

function validSignature(secret: string, body: string, given: string | null, prefix: string) {
  if (!given) return false;
  const expected = `${prefix}${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(given.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What happened, in our event names, with a one-line summary. Null = not something routines listen to. */
export function webhookEvent(
  provider: WebhookProvider,
  headers: Headers,
  payload: Record<string, unknown>,
): { event: RoutineEvent; summary: string; data: Record<string, unknown> } | null {
  const get = (o: unknown, ...path: string[]): unknown =>
    path.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
  if (provider === "github") {
    const kind = headers.get("x-github-event");
    const repo = String(get(payload, "repository", "full_name") ?? "");
    if (kind === "pull_request" && payload.action === "opened") {
      const number = Number(get(payload, "pull_request", "number"));
      const title = String(get(payload, "pull_request", "title") ?? "");
      const url = String(get(payload, "pull_request", "html_url") ?? "");
      return {
        event: "github.pr_opened",
        summary: `PR #${number} opened in ${repo}: ${title}`,
        data: { repo, number, url },
      };
    }
    if (kind === "deployment_status" && get(payload, "deployment_status", "state") === "success") {
      const environment = String(get(payload, "deployment", "environment") ?? "");
      return {
        event: "deploy.succeeded",
        summary: `Deploy to ${environment} finished (${repo})`,
        data: { repo, environment },
      };
    }
    return null;
  }
  const resource = headers.get("sentry-hook-resource");
  if (resource === "issue" && payload.action === "created") {
    const title = String(get(payload, "data", "issue", "title") ?? "");
    const url = String(get(payload, "data", "issue", "web_url") ?? get(payload, "data", "issue", "permalink") ?? "");
    return { event: "sentry.issue_created", summary: `New Sentry error: ${title}`, data: { title, url } };
  }
  return null;
}

/**
 * An incoming webhook: the signature must match the endpoint's secret
 * (GitHub `X-Hub-Signature-256: sha256=…`, Sentry `Sentry-Hook-Signature`);
 * then routines listening to the event run.
 */
export async function handleWebhook(
  deps: WebhookDeps,
  provider: WebhookProvider,
  endpointId: string,
  headers: Headers,
  rawBody: string,
): Promise<{ fired: number; event: RoutineEvent | null }> {
  const [endpoint] = await deps.db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.provider, provider),
        isNull(webhookEndpoints.revokedAt),
      ),
    );
  if (!endpoint) throw new NotFoundError("Webhook not found");
  const secret = await openSecret(
    deps.keyWrappers,
    { ciphertext: endpoint.secretCiphertext, wrappedDataKey: endpoint.wrappedDataKey, kekId: endpoint.kekId },
    aadFor(endpoint.orgId, endpoint.id),
  );
  const ok =
    provider === "github"
      ? validSignature(secret, rawBody, headers.get("x-hub-signature-256"), "sha256=")
      : validSignature(secret, rawBody, headers.get("sentry-hook-signature"), "");
  if (!ok) throw new ForbiddenSignatureError();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new ValidationError("The body is not JSON");
  }
  const what = webhookEvent(provider, headers, payload);
  if (!what) return { fired: 0, event: null };
  const fired = await fireRoutineEvent(deps, endpoint.orgId, what.event, { summary: what.summary, ...what.data });
  return { fired, event: what.event };
}
