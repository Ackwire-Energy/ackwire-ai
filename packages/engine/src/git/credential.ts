import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveSecret } from "../crypto";

/**
 * The credential a computer uses with our git proxy (D35). It is ours, not
 * GitHub's: an HMAC over org, agent, computer, a revocation generation and
 * an expiry. GitHub's token stays on the server and never enters a computer.
 */
export interface GitTokenClaims {
  orgId: string;
  agentId: string;
  /** `sandboxes.id` of the computer it was issued to (a connected machine: `machines.id`). */
  sandboxId: string;
  /**
   * `sandboxes.git_token_gen` when issued: bumping it revokes every token of
   * that computer. A connected machine: a number from its machine token's
   * hash (`machineGitGen`), so re-pairing or deleting it revokes them.
   */
  gen: number;
  /** `machine`: issued to a connected machine (ADR 0024 addendum); absent: a cloud computer. */
  kind?: "machine";
  /** Unix seconds. */
  exp: number;
}

/** Tokens live 6 hours and are re-issued on each start and every 3 hours of use. */
export const GIT_TOKEN_TTL_SECONDS = 6 * 3600;
export const GIT_TOKEN_REFRESH_MS = 3 * 3600_000;

const PREFIX = "agtgit1";

function key(masterSecret: string) {
  return Buffer.from(deriveSecret(masterSecret, "git-proxy"), "hex");
}

export function issueGitToken(masterSecret: string, claims: GitTokenClaims): string {
  const body = Buffer.from(
    JSON.stringify({
      o: claims.orgId,
      a: claims.agentId,
      s: claims.sandboxId,
      g: claims.gen,
      e: claims.exp,
      ...(claims.kind === "machine" ? { k: "m" } : {}),
    }),
  ).toString("base64url");
  const mac = createHmac("sha256", key(masterSecret)).update(`${PREFIX}.${body}`).digest("base64url");
  return `${PREFIX}.${body}.${mac}`;
}

/** The claims of a valid, unexpired token; null otherwise (never throws on bad input). */
export function verifyGitToken(masterSecret: string, token: string, now = new Date()): GitTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, body, mac] = parts as [string, string, string];
  const expected = createHmac("sha256", key(masterSecret)).update(`${PREFIX}.${body}`).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const claims: GitTokenClaims = {
      orgId: String(c.o),
      agentId: String(c.a),
      sandboxId: String(c.s),
      gen: Number(c.g),
      exp: Number(c.e),
      ...(c.k === "m" ? { kind: "machine" as const } : {}),
    };
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now.getTime()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** A connected machine's revocation generation: from its token's hash (re-pairing or deleting it changes it). */
export const machineGitGen = (tokenHash: string) => Number.parseInt(tokenHash.slice(0, 8), 16);

/** The proxy's base URL for one org's GitHub connection: `https://HOST/api/git/{orgId}/{connectionId}/`. */
export const gitProxyBase = (publicUrl: string, orgId: string, connectionId: string) =>
  `${publicUrl.replace(/\/$/, "")}/api/git/${orgId}/${connectionId}/`;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Configures git in the computer (as its user, in `$HOME`):
 * - our proxy token in `~/.config/agentes/git-token` (mode 600) and a tiny
 *   credential helper that returns it, only for our host;
 * - `url.<proxy>.insteadOf https://github.com/` (and `git@github.com:`), so
 *   `git clone https://github.com/owner/repo` goes through the proxy;
 * - the commit author: "Theo (agentes) <theo@agents.agentes.chat>".
 * Nothing goes in the environment, and no GitHub token is ever here.
 */
export function gitSetupScript(input: { base: string; token: string; agentName: string; agentHandle: string }) {
  const helper = [
    "#!/bin/sh",
    "# agentes.chat: the git proxy credential for this computer (not a GitHub token).",
    '[ "$1" = get ] || exit 0',
    "echo username=agentes",
    'printf "password=%s\\n" "$(cat "$HOME/.config/agentes/git-token")"',
  ].join("\n");
  const origin = new URL(input.base).origin;
  return [
    "set -e",
    'mkdir -p "$HOME/.config/agentes"',
    'chmod 700 "$HOME/.config/agentes"',
    `printf %s ${shq(input.token)} > "$HOME/.config/agentes/git-token"`,
    'chmod 600 "$HOME/.config/agentes/git-token"',
    `printf '%s\\n' ${shq(helper)} > "$HOME/.config/agentes/git-credential"`,
    'chmod 700 "$HOME/.config/agentes/git-credential"',
    // Replace earlier settings of ours (another connection, an old host).
    "git config --global --remove-section credential.https://github.com 2>/dev/null || true",
    `for k in $(git config --global --name-only --get-regexp '^url\\..*/api/git/.*\\.insteadof$' 2>/dev/null); do git config --global --unset-all "$k" || true; done`,
    `git config --global ${shq(`credential.${origin}.helper`)} "$HOME/.config/agentes/git-credential"`,
    `git config --global ${shq(`credential.${origin}.useHttpPath`)} false`,
    `git config --global --add ${shq(`url.${input.base}.insteadOf`)} https://github.com/`,
    `git config --global --add ${shq(`url.${input.base}.insteadOf`)} git@github.com:`,
    `git config --global user.name ${shq(`${input.agentName} (agentes)`)}`,
    `git config --global user.email ${shq(`${input.agentHandle}@agents.agentes.chat`)}`,
    "git config --global init.defaultBranch main",
    "git config --global push.autoSetupRemote true",
    "echo ok",
  ].join("\n");
}
