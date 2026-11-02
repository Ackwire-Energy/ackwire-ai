import type { TFunction } from "i18next";
import type { AppNotification, SecretRequest } from "../api/types";
import { MAX_SECRET_BYTES } from "./secret-box";

/**
 * An agent's request for a secret (ADR 0027), as the web's card and the phone's both read it: where the value
 * goes (said truly for each kind), and what is wrong with a value before it is sealed.
 */

/** `https://app.example.com` → `app.example.com`. */
export function siteHost(site: string): string {
  try {
    return new URL(site).host;
  } catch {
    return site;
  }
}

/**
 * Where the value goes, in the person's words: a variable in the agent's commands, a file in its folder, or only its
 * browser's typing on one site; and, while it is asked, that it replaces the key the agent holds under that name.
 */
export function secretWhere(
  t: TFunction,
  r: Pick<SecretRequest, "name" | "target" | "replaces" | "status">,
  agent: string,
): string {
  const target = r.target;
  const where =
    target.kind === "file"
      ? t("secret.targetFile", { path: target.path, agent })
      : target.kind === "site"
        ? t("secret.targetSite", { host: siteHost(target.site), agent })
        : t("secret.targetEnv", { name: r.name, agent });
  // Only while it is asked: once it is answered or closed, nothing is replacing anything.
  return r.replaces && r.status === "pending" ? `${where} ${t("secret.replaces", { agent })}` : where;
}

/** A request's notification (`secret_request`) in one line, as its card says it: the secret's name, what it is for. */
export const secretNoticeLine = (n: Pick<AppNotification, "latest">) =>
  [n.latest.title, n.latest.text].filter(Boolean).join(" · ");

/** Why a value can't go yet, as the i18n key that says it, or null. */
export function secretValueProblem(value: string): "secret.empty" | "secret.tooLarge" | null {
  if (!value) return "secret.empty";
  return new TextEncoder().encode(value).byteLength > MAX_SECRET_BYTES ? "secret.tooLarge" : null;
}

const TARGETS = new Set(["env", "file", "site"]);
const STATUSES = new Set(["pending", "delivered", "declined", "expired", "canceled"]);

/** The request a message's card carries (`meta.secretRequest`), or null when it isn't one. */
export function secretRequestOf(meta: Record<string, unknown> | null | undefined): SecretRequest | null {
  const r = meta?.secretRequest as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return null;
  const target = r.target as Record<string, unknown> | undefined;
  if (
    typeof r.id !== "string" ||
    typeof r.name !== "string" ||
    typeof r.agentId !== "string" ||
    typeof r.requestedForUserId !== "string" ||
    typeof r.expiresAt !== "string" ||
    !STATUSES.has(String(r.status)) ||
    !target ||
    !TARGETS.has(String(target.kind))
  ) {
    return null;
  }
  return r as unknown as SecretRequest;
}
