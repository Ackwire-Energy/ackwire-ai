import type { EmailSender } from "@agenteschat/adapters";
import type { Executor } from "@agenteschat/db";
import { rethrowEmailError } from "./email";
import { enqueue, PermanentJobError } from "./outbox";

/*
 * Feedback from the apps (ADR 0160): what a person writes in the form behind the Beta mark goes, as one plain email,
 * to the address whoever runs the server set (`FEEDBACK_EMAIL`). Nothing is stored beyond the outbox job, and only
 * what the person typed and what helps answer them is sent: never a conversation.
 */

export const FEEDBACK_JOB = "feedback.send";
/** As long as a careful bug report, short enough for one email. */
export const FEEDBACK_MAX = 4000;

export interface Feedback {
  /** Whoever runs the server (`FEEDBACK_EMAIL`). */
  to: string;
  /** Who wrote it: the reply goes to their address. */
  name: string;
  email: string;
  /** The workspace they were in, when they were in one. */
  orgName?: string;
  text: string;
  /** The screen they were on (a path, without ids' meaning), and the app that sent it ("web", "desktop 0.6.1"). */
  where?: string;
  app?: string;
  /** This server's version. */
  version: string;
}

/** One line, without the characters that would start another header or another line of the summary. */
const line = (value: string, max: number) =>
  value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .trim()
    .slice(0, max);

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The email a feedback becomes: the person's words first, then who wrote them and from where. */
export function renderFeedback(f: Feedback) {
  const name = line(f.name, 80) || line(f.email, 120);
  const facts = [
    ["From", `${name} <${line(f.email, 120)}>`],
    ...(f.orgName ? [["Workspace", line(f.orgName, 80)]] : []),
    ...(f.where ? [["Screen", line(f.where, 200)]] : []),
    ...(f.app ? [["App", line(f.app, 60)]] : []),
    ["Server", line(f.version, 40)],
  ] as [string, string][];
  const text = f.text.trim().slice(0, FEEDBACK_MAX);
  return {
    subject: `Feedback from ${name}`,
    text: `${text}\n\n--\n${facts.map(([k, v]) => `${k}: ${v}`).join("\n")}\n`,
    html: `<div style="font:15px/1.5 system-ui,sans-serif;color:#151514"><p style="white-space:pre-wrap;margin:0 0 20px">${escapeHtml(text)}</p><table style="font-size:13px;color:#5c5c58;border-top:1px solid #e5e5e2;padding-top:10px">${facts
      .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0">${k}</td><td>${escapeHtml(v)}</td></tr>`)
      .join("")}</table></div>`,
  };
}

/** Queues a feedback (outbox job `feedback.send`): sent once per `key`, never inline in the request. */
export async function queueFeedback(tx: Executor, input: { orgId: string | null; key: string; feedback: Feedback }) {
  await enqueue(tx, {
    orgId: input.orgId,
    kind: FEEDBACK_JOB,
    payload: { key: input.key, feedback: input.feedback },
    dedupeKey: `feedback:${input.key}`,
    maxAttempts: 6,
  });
}

/** Job `feedback.send`. Retries on transient provider errors; permanent ones fail the job. */
export async function sendQueuedFeedback(sender: EmailSender, payload: Record<string, unknown>) {
  const f = payload.feedback as Feedback | undefined;
  if (!f?.to || !f.text) throw new PermanentJobError("feedback without a recipient or text");
  await sender
    .send({
      ...renderFeedback(f),
      to: [f.to],
      replyTo: line(f.email, 120),
      idempotencyKey: `feedback:${String(payload.key)}`,
      tags: [{ name: "kind", value: "feedback" }],
    })
    .catch(rethrowEmailError);
}
