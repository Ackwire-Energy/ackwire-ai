/**
 * Mailboxes for agents (ADR 0038): the rules the screens share. DOM-free.
 */
import { ApiError } from "../api/http";
import type { AgentMailbox, MailAccount, MailConnectError, MailPolicy, MailPreset } from "../api/types";
import type { Level } from "./access-levels";

/** The cards in the catalog's "Email" group. */
export type MailChoice = "gmail" | "outlook" | "icloud" | "other";

/** `Outro email` with no preset: the person types the servers (under "Avançado"). */
export const CUSTOM_PRESET = "custom";

export const MAIL_ERRORS: MailConnectError[] = [
  "auth",
  "imap_unreachable",
  "smtp_unreachable",
  "tls",
  "blocked_host",
  "unknown",
];

/** The error code of a failed connect or reconnect (`422 { error }`); anything else is `unknown`. */
export function mailErrorOf(error: unknown): MailConnectError {
  if (error instanceof ApiError) {
    const code = error.code as MailConnectError;
    if (MAIL_ERRORS.includes(code)) return code;
  }
  return "unknown";
}

/** The catalog card a connected mailbox belongs to. */
export function choiceOf(account: Pick<MailAccount, "provider" | "preset">): MailChoice {
  if (account.provider === "gmail") return "gmail";
  if (account.provider === "outlook") return "outlook";
  return account.preset === "icloud" ? "icloud" : "other";
}

/** What to log in with for a preset: the address, or only the part before the @. */
export function loginOf(preset: Pick<MailPreset, "username"> | null | undefined, address: string): string {
  const a = address.trim();
  return preset?.username === "local" ? (a.split("@")[0] ?? a) : a;
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^@[^\s@]+\.[^\s@]+$/;

export const isAddress = (value: string) => ADDRESS.test(value.trim());

/** An address (`ana@empresa.com`) or a whole domain (`@empresa.com`). */
export const isAddressOrDomain = (value: string) => {
  const v = value.trim().toLowerCase();
  return ADDRESS.test(v) || DOMAIN.test(v);
};

/** Typed text → the addresses/domains in it (split on commas, spaces, semicolons), lowercased, valid only. */
export function splitAddresses(text: string): { valid: string[]; invalid: string[] } {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  return { valid: parts.filter(isAddressOrDomain), invalid: parts.filter((p) => !isAddressOrDomain(p)) };
}

export const DEFAULT_DAILY_CAP = 25;

/** The connectors' level (Sem acesso · Ler · Ler e escrever) as the mail API says it. */
export const toMailLevel = (level: Level): AgentMailbox["level"] => (level === "write" ? "read_write" : level);

/** A new agent's rules for a mailbox: every folder, anyone, asks before each send. */
export const defaultPolicy = (): MailPolicy => ({
  folders: [],
  senders: [],
  windowDays: null,
  allowedRecipients: [],
  dailySendCap: DEFAULT_DAILY_CAP,
  sendWithoutAsking: false,
  fromAddress: null,
});

/** "Enviar sem pedir aprovação" needs "Só enviar para"; without it, it is off. */
export function normalizePolicy(policy: MailPolicy): MailPolicy {
  return policy.allowedRecipients.length === 0 && policy.sendWithoutAsking
    ? { ...policy, sendWithoutAsking: false }
    : policy;
}

export const canSendWithoutAsking = (policy: Pick<MailPolicy, "allowedRecipients">) =>
  policy.allowedRecipients.length > 0;

/** What the email connector does, grouped as the connect flow's step 2 shows it. */
export const MAIL_ACTIONS = {
  read: ["search", "read", "folders"],
  write: ["draft", "organize"],
  approval: ["send", "reply", "forward"],
  off: ["delete"],
} as const;

export type MailAction = (typeof MAIL_ACTIONS)[keyof typeof MAIL_ACTIONS][number];

/** The newest mailbox (back from Gmail/Outlook: the one that just came in). */
export function newestAccount(accounts: MailAccount[]): MailAccount | null {
  return [...accounts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
