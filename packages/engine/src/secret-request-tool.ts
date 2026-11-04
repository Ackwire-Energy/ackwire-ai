import { isReservedSecretName } from "@agenteschat/adapters";
import { and, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { type ComputerHandle, requireComputerManager } from "./sandbox";
import {
  MAX_PENDING_SECRETS,
  REQUEST_SECRET_TOOL,
  requesterOfRun,
  SECRET_TTL_MS,
  secretOnComputer,
  secretStillHeld,
} from "./secrets";
import type { ToolContext, ToolDefinition, ToolOutput } from "./tools/types";

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A one-time code's boxes on the card (ADR 0142): one per digit. */
export const CODE_DIGITS = { min: 4, max: 12 } as const;
/** Longest username a request may carry (the Vault keeps the same). */
export const MAX_SECRET_USERNAME = 200;

/** A `request_secret` site as its origin (`https://host[:port]`), or null when it isn't a web address. */
export function secretSite(raw: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Asking again under a held name is how a refused key gets replaced: the newest delivery wins on the computer. */
const AGAIN =
  "If a key you were given is refused (a 401, or a 403 saying the key is invalid or expired), first check you sent it as the API's docs say (header, prefix, test or live address); if you did, ask once for a new one under the same `name`, with a `purpose` that says in one line, in the person's language, what failed: it replaces the old one. If the new one is refused too, don't ask again: say what failed and stop.";

const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/**
 * `request_secret` (ADR 0027), shared by the computer's tools (env/file, any
 * secret) and the agent browser's (ADR 0040: a password bound to one site, for
 * an agent that may only use the browser). One definition, two shapes.
 */
export function requestSecretTool(opts: {
  scope: string;
  /** The browser's variant: `site` required, only an env secret, typed by `browser_type_secret`. */
  browserOnly: boolean;
  /** A workspace path for `target: file` (the computer's variant). */
  toolPath?: (raw: string) => string;
  /** The computer the key is made on (and the secret later delivered to). */
  onComputer: <T>(ctx: ToolContext, fn: (computer: ComputerHandle) => Promise<T>) => Promise<T>;
}): ToolDefinition {
  const site = {
    type: "string",
    maxLength: 300,
    description:
      "For a password your browser types (browser_type_secret): the address of the page it goes into (https://…). It will only ever be typed on that site, and it stays out of your commands; leave `site` out for a secret a command uses.",
  } as const;
  // ADR 0142: what the card shows besides the field, and what it lets the person save to the Vault.
  const username = {
    type: "string",
    maxLength: MAX_SECRET_USERNAME,
    description:
      "With `site`: the account's username or email when you know it. The card shows it, and saves it with the password when the person keeps it in the Vault.",
  } as const;
  const code = {
    type: "object",
    properties: { digits: { type: "integer", minimum: CODE_DIGITS.min, maximum: CODE_DIGITS.max } },
    required: ["digits"],
    additionalProperties: false,
    description:
      "With `site`: a one-time code (sent by text message or email) instead of a password: the card shows one box per digit. Never saved; type it at once.",
  } as const;
  return {
    name: REQUEST_SECRET_TOOL,
    description: [
      opts.browserOnly
        ? "Ask the person who asked you for a password or code to sign in on a site in your browser. They type it in a private card; it goes encrypted straight to your computer, never through the chat or you, and it will only ever be typed on that one site (`site`, the login page's address). Never ask for passwords or codes in a normal message. `name` is UPPER_SNAKE_CASE. Give `username` when you know the account, and `code` for a one-time code. Your run pauses until they answer (15 minutes at most); you then get only whether it arrived. Type it with `browser_type_secret`. Look in the Vault first (`vault_list`) when you have it: a saved login needs no request."
        : "Ask the person who asked you for a secret your computer needs: a token or password for a CLI, the code that finishes a sign-in, .env values. They type it in a private card; it goes encrypted straight to your computer, never through the chat or you. Never ask for passwords, tokens or codes in a normal message. `name` is UPPER_SNAKE_CASE; `target` is `env` (an environment variable in your commands) or `file` (a path in your workspace, e.g. `.npmrc` or `.env`, written with mode 600). For a site your browser signs in to, give `site` (and `username` when you know it, or `code` for a one-time code). Your run pauses until they answer (15 minutes at most); you then get only whether it arrived. Use it by name, never print it. Look in the Vault first (`vault_list`) when you have it: a saved login or key needs no request.",
      AGAIN,
    ].join(" "),
    scope: opts.scope,
    inputSchema: opts.browserOnly
      ? {
          type: "object",
          properties: {
            name: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
            purpose: {
              type: "string",
              minLength: 1,
              maxLength: 300,
              description: "What it is for, shown to the person",
            },
            site,
            username,
            code,
          },
          required: ["name", "purpose", "site"],
          additionalProperties: false,
        }
      : {
          type: "object",
          properties: {
            name: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
            purpose: {
              type: "string",
              minLength: 1,
              maxLength: 300,
              description: "What it is for, shown to the person",
            },
            target: { enum: ["env", "file"] },
            path: { type: "string", maxLength: 300, description: "With target file: where it goes in your workspace" },
            site,
            username,
            code,
          },
          required: ["name", "purpose", "target"],
          additionalProperties: false,
        },
    describe: (input) => ({ title: `Ask for the secret ${str(input.name)}` }),
    async execute(input, ctx) {
      try {
        const requester = await requesterOfRun(ctx);
        if (!requester) {
          return {
            content: "Only a person's own request can ask them for a secret (not a routine or another agent).",
            isError: true,
          };
        }
        const name = str(input.name);
        if (isReservedSecretName(name)) {
          return {
            content: `${name} is reserved: it would change where an AI sign-in or its requests go. Pick another name.`,
            isError: true,
          };
        }
        const file = !opts.browserOnly && input.target === "file";
        const path = file ? (opts.toolPath?.(str(input.path)) ?? "") : "";
        if (file && (!path || path === ".agentes" || path.startsWith(".agentes/"))) {
          return { content: "With target file, give a path inside your workspace (e.g. .npmrc).", isError: true };
        }
        const rawSite = str(input.site).trim();
        const origin = rawSite ? secretSite(rawSite) : null;
        if ((rawSite || opts.browserOnly) && !origin) {
          return { content: "`site` must be a web address (https://example.com/login).", isError: true };
        }
        // A username and a code go with a site's sign-in only (ADR 0142).
        const user = str(input.username).trim().slice(0, MAX_SECRET_USERNAME);
        const digits = codeDigitsOf(input.code);
        if ((user || input.code !== undefined) && (!origin || file)) {
          return {
            content: "`username` and `code` go with `site` (the sign-in page your browser types it on).",
            isError: true,
          };
        }
        if (input.code !== undefined && digits === null) {
          return {
            content: `\`code\` takes \`digits\`, from ${CODE_DIGITS.min} to ${CODE_DIGITS.max}.`,
            isError: true,
          };
        }
        const open = await ctx.db
          .select({ id: schema.secretRequests.id })
          .from(schema.secretRequests)
          .where(and(eq(schema.secretRequests.runId, ctx.runId), eq(schema.secretRequests.status, "pending")));
        if (open.length >= MAX_PENDING_SECRETS) {
          return { content: `At most ${MAX_PENDING_SECRETS} secret requests at a time.`, isError: true };
        }
        const row = await opts.onComputer(ctx, async (computer) => {
          const [held] = await ctx.db
            .select({
              runId: schema.secretRequests.runId,
              replaces: schema.secretRequests.replaces,
              givenBy: schema.secretRequests.requestedForUserId,
              giver: schema.users.name,
            })
            .from(schema.secretRequests)
            .leftJoin(schema.users, eq(schema.users.id, schema.secretRequests.requestedForUserId))
            .where(
              and(
                eq(schema.secretRequests.orgId, ctx.orgId),
                eq(schema.secretRequests.agentId, ctx.agentId),
                eq(schema.secretRequests.name, name),
                eq(schema.secretRequests.machineId, computer.machineId),
                eq(schema.secretRequests.status, "delivered"),
                isNull(schema.secretRequests.removedAt),
                // A site's password past the minutes its runner keeps it is gone: nothing to replace (ADR 0142 §6).
                secretStillHeld(),
              ),
            )
            .limit(1);
          // The replacement this run asked for was refused too: a second one would only loop.
          if (held?.replaces && held.runId === ctx.runId) {
            return {
              refused: `The ${name} you were just given was refused too. Don't ask for it again: say in one line what failed and stop.`,
            };
          }
          // A key is shared by every run of the agent: only its giver, the agent's owner or an admin swaps it.
          if (
            held &&
            held.givenBy !== requester &&
            !(await requireComputerManager(ctx.db, requester, ctx.orgId, ctx.agentId).then(
              () => true,
              () => false,
            ))
          ) {
            const giver = held.giver ?? "the person who gave it";
            return {
              refused: `${name} was given by ${giver}; only ${giver}, your owner or an admin can replace it. Don't ask for it: say in the conversation what failed with it and that ${giver} gave it.`,
            };
          }
          const id = Bun.randomUUIDv7();
          const { publicKey, sites } = await secretOnComputer(computer, { action: "keypair", requestId: id });
          if (!publicKey) throw new Error("the computer made no key");
          // A site's password is for the browser alone where the runner keeps it so; an older one gets a variable.
          const kind = file ? "file" : origin && sites === true ? "site" : "env";
          const [inserted] = await ctx.db
            .insert(schema.secretRequests)
            .values({
              id,
              orgId: ctx.orgId,
              runId: ctx.runId,
              agentId: ctx.agentId,
              channelId: ctx.channelId,
              toolUseId: ctx.toolUseId ?? id,
              requestedForUserId: requester,
              name,
              // The person sees the one site a browser password may be typed on.
              purpose: origin ? `${str(input.purpose).trim()} (${new URL(origin).host})` : str(input.purpose).trim(),
              site: origin,
              username: user || null,
              codeDigits: digits,
              targetKind: kind,
              targetPath: file ? path : null,
              machineId: computer.machineId,
              publicKey,
              replaces: held !== undefined,
              expiresAt: new Date(Date.now() + SECRET_TTL_MS),
            })
            .returning();
          if (!inserted) throw new Error("the request was not saved");
          await recordAudit(ctx.db, {
            orgId: ctx.orgId,
            actor: { type: "agent", id: ctx.agentId },
            action: "secret.requested",
            target: { type: "agent", id: ctx.agentId },
            details: {
              requestId: id,
              name,
              target: kind === "file" ? { kind, path } : kind === "site" && origin ? { kind, site: origin } : { kind },
              requestedFor: requester,
              ...(held ? { replaces: true } : {}),
              ...(digits ? { codeDigits: digits } : {}),
            },
          });
          return inserted;
        });
        if ("refused" in row) return { content: row.refused, isError: true };
        return { content: "", waitForSecret: { requestId: row.id } };
      } catch (error) {
        return failed(error);
      }
    },
  };
}

/** `code.digits` as the request keeps it, or null when it isn't a whole number of boxes the card can show. */
export function codeDigitsOf(raw: unknown): number | null {
  const digits = (raw as { digits?: unknown } | null | undefined)?.digits;
  return typeof digits === "number" &&
    Number.isInteger(digits) &&
    digits >= CODE_DIGITS.min &&
    digits <= CODE_DIGITS.max
    ? digits
    : null;
}
