import type { BlobStore, EmailSender, InlinePart } from "@agenteschat/adapters";
import { and, count, type Database, type Executor, eq, gt, inArray, isNull, lt, schema } from "@agenteschat/db";
import { randomToken, sha256 } from "./crypto";
import { rethrowEmailError } from "./email";
import { NotFoundError, TooManyError, ValidationError } from "./errors";
import { enqueue, PermanentJobError } from "./outbox";

/*
 * Feedback from the apps (ADR 0160): what a person writes in the form goes, as one plain email, to the address
 * whoever runs the server set (`FEEDBACK_EMAIL`). With it go what the person chose to show (the thing they reported,
 * pictures, a video) and what the app knows of where they were. Nothing is stored beyond the outbox job and the
 * files, which expire.
 *
 * A server whose operator set no address sends it to the agentes.chat team instead (ADR 0160 §13): the same job posts
 * it to that team's inbox (`FEEDBACK_URL`), pictures included, and the inbox (on agentes.chat's own servers
 * only) mails it to its own address without keeping anything.
 */

export const FEEDBACK_JOB = "feedback.send";
export const FEEDBACK_FILE_PURGE_JOB = "feedback.file.purge";
/** As long as a careful bug report, short enough for one email. */
export const FEEDBACK_MAX = 4000;
/** What a reported thing says (an agent's answer, a card), as much as the email quotes. */
export const FEEDBACK_ABOUT_MAX = 4000;
/** Facts the app adds about where the person was: how many, and how long each. */
export const FEEDBACK_FACTS = 40;
export const FEEDBACK_FACT_MAX = 300;
/** A person's feedbacks in an hour, by the form or by an agent they asked: more than anyone writes, too few to flood. */
export const FEEDBACK_PER_HOUR = { limit: 10, windowMs: 60 * 60_000 } as const;

const MB = 1024 * 1024;
/** What one feedback takes: pictures a phone's screenshot fits in, one short screen recording. */
export const FEEDBACK_FILES = {
  imageBytes: 5 * MB,
  videoBytes: 50 * MB,
  images: 3,
  videos: 1,
  /** Uploaded and not sent yet, per person: more than a form holds, so a stuck one never blocks the next. */
  pending: 6,
} as const;
/** A file nobody sent goes after an hour; one that was sent stays a month behind its link. */
export const FEEDBACK_UNSENT_MS = 60 * 60_000;
export const FEEDBACK_SENT_MS = 30 * 86_400_000;
/** Pictures ride in the email itself up to this much; past it they are only links. */
const INLINE_BYTES = 12 * MB;
/** A file of a feedback that went to the inbox is only needed while its job may still run again. */
export const FEEDBACK_RELAYED_MS = 6 * 60 * 60_000;
/** The most the inbox reads: the pictures that fit an email, as base64 in JSON, and the text around them. */
export const FEEDBACK_INBOX_BYTES = Math.ceil((INLINE_BYTES * 4) / 3) + 2 * MB;
/** What the inbox takes in an hour: from one address (a whole server's people come from one), and in all. */
export const FEEDBACK_INBOX_PER_HOUR = { limit: 30, windowMs: 60 * 60_000 } as const;
export const FEEDBACK_INBOX_ALL_PER_HOUR = { limit: 60, windowMs: 60 * 60_000 } as const;
const RELAY_TIMEOUT_MS = 60_000;

/**
 * Where this server's feedback goes, or undefined when it takes none: its operator's address, else the agentes.chat
 * team's inbox unless the operator turned that off.
 */
export function feedbackDestination(config: {
  FEEDBACK_EMAIL?: string;
  FEEDBACK_RELAY: boolean;
  FEEDBACK_URL: string;
}) {
  return config.FEEDBACK_EMAIL ?? (config.FEEDBACK_RELAY ? config.FEEDBACK_URL : undefined);
}

/** Whether `to` is the inbox's address (a URL) rather than an email address. */
export const isFeedbackRelay = (to: string | null | undefined): to is string => /^https?:\/\//i.test(to ?? "");

export type FeedbackFileKind = "image" | "video";

/** A picture or a video of a sent feedback, as its email shows it. */
export interface FeedbackFileRef {
  id: string;
  name: string;
  contentType: string;
  size: number;
  kind: FeedbackFileKind;
  /** Opens the file until `expiresAt`, for whoever has the email; empty for a picture that only rides in the email. */
  url: string;
  expiresAt: string;
}

/** The thing a feedback is about, picked with a right click: what it is, and what it says. */
export interface FeedbackAbout {
  /** `message`, `card`, `button`…: the app's own word for it. */
  kind: string;
  /** Its name on screen (an author, a title). */
  label?: string;
  /** What it says, as the person saw it and agreed to send. */
  text?: string;
}

export interface Feedback {
  /** Whoever runs the server (`FEEDBACK_EMAIL`), or the agentes.chat team's inbox (a URL, `isFeedbackRelay`). */
  to: string;
  /** Who wrote it: the reply goes to their address. */
  name: string;
  email: string;
  /** The workspace they were in, when they were in one. */
  orgName?: string;
  text: string;
  /** The screen they were on (a path), and the app that sent it ("web", "desktop 0.6.1"; "agent" for `send_feedback`). */
  where?: string;
  app?: string;
  about?: FeedbackAbout;
  /** What the app knew of where the person was, as label and value, in the order the form listed them. */
  facts?: [string, string][];
  files?: FeedbackFileRef[];
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

const sizeOf = (bytes: number) =>
  bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The pictures that ride in the email: each one's `cid`, while they fit together. */
function inlineOf(files: readonly FeedbackFileRef[]) {
  const out = new Map<string, string>();
  let total = 0;
  for (const f of files) {
    if (f.kind !== "image" || f.contentType === "image/heic") continue;
    if (total + f.size > INLINE_BYTES) continue;
    total += f.size;
    out.set(f.id, `feedback-${out.size + 1}`);
  }
  return out;
}

/** The email a feedback becomes: the person's words first, then what they reported, who they are and from where. */
export function renderFeedback(f: Feedback) {
  const name = line(f.name, 80) || line(f.email, 120);
  const facts = [
    ["From", `${name} <${line(f.email, 120)}>`],
    ...(f.orgName ? [["Workspace", line(f.orgName, 80)]] : []),
    ...(f.where ? [["Screen", line(f.where, 200)]] : []),
    ...(f.app ? [["App", line(f.app, 60)]] : []),
    ...(f.facts ?? [])
      .slice(0, FEEDBACK_FACTS)
      .map(([k, v]) => [line(k, 40), line(v, FEEDBACK_FACT_MAX)])
      .filter(([k, v]) => k && v),
    ["Server", line(f.version, 40)],
  ] as [string, string][];
  const text = f.text.trim().slice(0, FEEDBACK_MAX);
  const about = f.about
    ? {
        title: [line(f.about.kind, 40), f.about.label ? line(f.about.label, 120) : ""].filter(Boolean).join(": "),
        text: (f.about.text ?? "").trim().slice(0, FEEDBACK_ABOUT_MAX),
      }
    : null;
  const files = f.files ?? [];
  const inline = inlineOf(files);
  const linked = files.some((x) => x.url);
  const until = files[0] ? files[0].expiresAt.slice(0, 10) : "";
  const heading = linked ? `Files (the links open until ${until})` : "Pictures";
  const quoted = (s: string) =>
    s
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
  const listed = files.map((x) => `- ${line(x.name, 80)} (${sizeOf(x.size)})${x.url ? `: ${x.url}` : ""}`).join("\n");

  const plain = [
    text,
    ...(about ? [`About ${about.title}`, ...(about.text ? [quoted(about.text)] : [])] : []),
    ...(files.length ? [`${heading}:\n${listed}`] : []),
    `--\n${facts.map(([k, v]) => `${k}: ${v}`).join("\n")}\n`,
  ].join("\n\n");

  const quiet = "font-size:13px;color:#5c5c58";
  const picture = (x: FeedbackFileRef) =>
    inline.has(x.id)
      ? `<br><img src="cid:${inline.get(x.id)}" alt="" style="max-width:560px;margin:6px 0 10px;border:1px solid #e5e5e2">`
      : "";
  const html = [
    `<div style="font:15px/1.5 system-ui,sans-serif;color:#151514">`,
    `<p style="white-space:pre-wrap;margin:0 0 20px">${escapeHtml(text)}</p>`,
    about ? `<p style="${quiet};margin:0 0 6px">About ${escapeHtml(about.title)}</p>` : "",
    about?.text
      ? `<blockquote style="white-space:pre-wrap;margin:0 0 20px;padding:0 0 0 12px;border-left:3px solid #e5e5e2">${escapeHtml(about.text)}</blockquote>`
      : "",
    files.length
      ? `<p style="${quiet};margin:0 0 6px">${escapeHtml(heading)}</p><ul style="margin:0 0 20px;padding-left:18px">${files
          .map((x) => {
            const name = escapeHtml(line(x.name, 80));
            const title = x.url ? `<a href="${escapeHtml(x.url)}">${name}</a>` : name;
            return `<li>${title} <span style="${quiet}">${sizeOf(x.size)}</span>${picture(x)}</li>`;
          })
          .join("")}</ul>`
      : "",
    `<table style="${quiet};border-top:1px solid #e5e5e2;padding-top:10px">${facts
      .map(
        ([k, v]) =>
          `<tr><td style="padding:2px 12px 2px 0;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`,
      )
      .join("")}</table>`,
    `</div>`,
  ].join("");
  return { subject: `Feedback from ${name}`, text: plain, html };
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

/**
 * Job `feedback.send`. Retries on transient provider errors; permanent ones fail the job. With `blobs`, the pictures
 * ride in the email too; a picture that is gone by then stays a link.
 */
export async function sendQueuedFeedback(sender: EmailSender, payload: Record<string, unknown>, blobs?: BlobStore) {
  const f = payload.feedback as Feedback | undefined;
  if (!f?.to || !f.text) throw new PermanentJobError("feedback without a recipient or text");
  const cids = inlineOf(f.files ?? []);
  const inline = [];
  for (const file of blobs ? (f.files ?? []) : []) {
    const cid = cids.get(file.id);
    if (!cid) continue;
    const blob = await blobs?.get(feedbackBlobKey(file.id)).catch(() => null);
    if (blob) inline.push({ cid, filename: line(file.name, 80), contentType: file.contentType, content: blob.body });
  }
  await sender
    .send({
      ...renderFeedback(f),
      ...(inline.length ? { inline } : {}),
      to: [f.to],
      replyTo: line(f.email, 120),
      idempotencyKey: `feedback:${String(payload.key)}`,
      tags: [{ name: "kind", value: "feedback" }],
    })
    .catch(rethrowEmailError);
}

/* ---------- to the agentes.chat team, from a server someone else runs ---------- */

/** What a server posts to the inbox: the feedback without an address, and its pictures as base64. */
export interface RelayedFeedback {
  /** The sender's own key for this message: sent again, the inbox mails it once. */
  id: string;
  feedback: Omit<Feedback, "to" | "files">;
  pictures?: { name: string; data: string }[];
}

/** The pictures that go to the inbox: in the order added, while they fit an email together. Never a video. */
function relayedFiles(files: readonly FeedbackFileRef[]) {
  const out: FeedbackFileRef[] = [];
  let total = 0;
  for (const f of files) {
    if (f.kind !== "image" || total + f.size > INLINE_BYTES) continue;
    total += f.size;
    out.push(f);
  }
  return out;
}

/**
 * Job `feedback.send` on a server whose feedback goes to the agentes.chat team: one POST to the inbox (`to`). A
 * refusal of what was sent fails the job; anything else (no network, the inbox busy or down) runs it again.
 */
export async function relayQueuedFeedback(post: typeof fetch, payload: Record<string, unknown>, blobs?: BlobStore) {
  const f = payload.feedback as Feedback | undefined;
  if (!f || !isFeedbackRelay(f.to) || !f.text) throw new PermanentJobError("feedback without an inbox or text");
  const { to, files, ...feedback } = f;
  const going = relayedFiles(files ?? []);
  const pictures = [];
  let left = 0;
  for (const file of files ?? []) {
    const blob = going.includes(file) ? await blobs?.get(feedbackBlobKey(file.id)).catch(() => null) : null;
    if (blob) pictures.push({ name: file.name, data: Buffer.from(blob.body).toString("base64") });
    else left++;
  }
  const body: RelayedFeedback = {
    id: String(payload.key),
    feedback: {
      ...feedback,
      facts: [...(feedback.facts ?? []), ...(left ? ([["Files left out", String(left)]] as [string, string][]) : [])],
    },
    ...(pictures.length ? { pictures } : {}),
  };
  const res = await post(to, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  if (res.ok) return;
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
    throw new PermanentJobError(`the feedback inbox refused it (HTTP ${res.status})`);
  throw new Error(`the feedback inbox answered HTTP ${res.status}`);
}

/**
 * The inbox's side: a feedback another server posted becomes one email to `to`, its pictures riding in it. Nothing is
 * kept. Who wrote it is only what that server said, so the email says where it came from; a picture is taken by its
 * own bytes, as an upload is.
 */
export async function sendRelayedFeedback(sender: EmailSender, to: string, input: RelayedFeedback) {
  const pictures = input.pictures ?? [];
  if (pictures.length > FEEDBACK_FILES.images)
    throw new ValidationError("Too many files for one feedback", "feedback.files_many");
  const files: FeedbackFileRef[] = [];
  const bytes = new Map<string, Uint8Array>();
  let total = 0;
  for (const [i, picture] of pictures.entries()) {
    const body = new Uint8Array(Buffer.from(picture.data, "base64"));
    const type = sniffFeedbackFile(body);
    if (type?.kind !== "image") throw new ValidationError("Only pictures can be attached", "feedback.file_type");
    total += body.byteLength;
    if (body.byteLength > FEEDBACK_FILES.imageBytes || total > INLINE_BYTES)
      throw new ValidationError("The file is too large", "feedback.file_too_large");
    const id = `picture-${i + 1}`;
    bytes.set(id, body);
    files.push({
      id,
      name: safeName(picture.name, type.ext),
      contentType: type.contentType,
      size: body.byteLength,
      kind: "image",
      url: "",
      expiresAt: "",
    });
  }
  const f: Feedback = {
    ...input.feedback,
    to,
    files,
    facts: [
      ...(input.feedback.facts ?? []).slice(0, FEEDBACK_FACTS - 1),
      ["Sent from", "another server (not verified)"],
    ],
  };
  // The ones an email shows where its HTML says; the rest (HEIC) are attached all the same.
  const cids = inlineOf(files);
  const inline: InlinePart[] = files.map((file) => ({
    cid: cids.get(file.id) ?? `feedback-${file.id}`,
    filename: file.name,
    contentType: file.contentType,
    content: bytes.get(file.id) ?? new Uint8Array(),
  }));
  await sender
    .send({
      ...renderFeedback(f),
      ...(inline.length ? { inline } : {}),
      to: [to],
      replyTo: line(f.email, 120),
      idempotencyKey: `feedback:inbox:${sha256(`${f.email}\n${input.id}`)}`,
      tags: [{ name: "kind", value: "feedback" }],
    })
    .catch(rethrowEmailError);
}

/* ---------- files ---------- */

export const feedbackBlobKey = (id: string) => `feedback/${id}`;

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
/** ISO base media brands that are still pictures (an iPhone's HEIC). */
const HEIC = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]);
/**
 * The brands a video says it is: what phones, screen recorders and browsers write. The same container also holds
 * sound alone (`M4A `), books and other things, which are not taken.
 */
const MP4 = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "MSNV",
  "dash",
  "mmp4",
  "3gp4",
  "3gp5",
]);

/**
 * What a file is by its first bytes: a picture or a video the email's reader can open, else null. What the upload
 * calls itself is never trusted, and nothing a browser would run (SVG, HTML) is among them. Only the start is read:
 * a file that begins as a picture and holds something else after it is kept as that picture, which is why a file is
 * only ever handed out as a download of its sniffed type, never shown by this origin.
 */
export function sniffFeedbackFile(
  bytes: Uint8Array,
): { kind: FeedbackFileKind; contentType: string; ext: string } | null {
  if (bytes.length < 12) return null;
  const [a, b, c, d] = bytes;
  if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47)
    return { kind: "image", contentType: "image/png", ext: "png" };
  if (a === 0xff && b === 0xd8 && c === 0xff) return { kind: "image", contentType: "image/jpeg", ext: "jpg" };
  if (ascii(bytes, 0, 4) === "GIF8") return { kind: "image", contentType: "image/gif", ext: "gif" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP")
    return { kind: "image", contentType: "image/webp", ext: "webp" };
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (HEIC.has(brand)) return { kind: "image", contentType: "image/heic", ext: "heic" };
    if (brand === "qt  ") return { kind: "video", contentType: "video/quicktime", ext: "mov" };
    return MP4.has(brand) ? { kind: "video", contentType: "video/mp4", ext: "mp4" } : null;
  }
  if (a === 0x1a && b === 0x45 && c === 0xdf && d === 0xa3)
    return { kind: "video", contentType: "video/webm", ext: "webm" };
  return null;
}

/** A file name safe to print and to download as: no path, no control characters, its real extension. */
function safeName(name: string, ext: string) {
  const base = line(name.split(/[\\/]/).pop() ?? "", 80)
    .replace(/[<>:"|?*]/g, "")
    .replace(/\.[^.]*$/, "")
    .trim();
  return `${base || "file"}.${ext}`;
}

export interface FeedbackFileDeps {
  db: Database;
  blobs: BlobStore;
}

export interface StoredFeedbackFile {
  id: string;
  name: string;
  size: number;
  kind: FeedbackFileKind;
  contentType: string;
}

/**
 * Keeps a file a person adds to the feedback they are writing: a picture or a video by its own bytes, within its
 * size, while they have room for one more. It goes by itself in an hour unless a feedback is sent with it.
 */
export async function storeFeedbackFile(
  deps: FeedbackFileDeps,
  userId: string,
  input: {
    name: string;
    bytes: Uint8Array;
    /** Where a feedback takes no video (it goes to the inbox). */
    picturesOnly?: boolean;
  },
  now = new Date(),
): Promise<StoredFeedbackFile> {
  const type = sniffFeedbackFile(input.bytes);
  if (!type) throw new ValidationError("Only pictures and videos can be attached", "feedback.file_type");
  if (input.picturesOnly && type.kind !== "image")
    throw new ValidationError("Only pictures can be attached", "feedback.file_type");
  const max = type.kind === "image" ? FEEDBACK_FILES.imageBytes : FEEDBACK_FILES.videoBytes;
  if (input.bytes.byteLength > max)
    throw new ValidationError("The file is too large", "feedback.file_too_large", { mb: max / MB });
  const [pending] = await deps.db
    .select({ n: count() })
    .from(schema.feedbackFiles)
    .where(
      and(
        eq(schema.feedbackFiles.userId, userId),
        isNull(schema.feedbackFiles.sentAt),
        gt(schema.feedbackFiles.expiresAt, now),
      ),
    );
  if ((pending?.n ?? 0) >= FEEDBACK_FILES.pending)
    throw new TooManyError("Too many files waiting", "feedback.files_pending");
  const expiresAt = new Date(now.getTime() + FEEDBACK_UNSENT_MS);
  const [row] = await deps.db
    .insert(schema.feedbackFiles)
    .values({
      userId,
      name: safeName(input.name, type.ext),
      contentType: type.contentType,
      size: input.bytes.byteLength,
      expiresAt,
    })
    .returning();
  if (!row) throw new Error("feedback file not stored");
  await deps.blobs.put(feedbackBlobKey(row.id), input.bytes, { contentType: type.contentType });
  await queuePurge(deps.db, row.id, expiresAt);
  return { id: row.id, name: row.name, size: row.size, kind: type.kind, contentType: row.contentType };
}

/** The purge of a file once its time is up; one per time it was given, the early ones finding it still wanted. */
const queuePurge = (tx: Executor, id: string, at: Date) =>
  enqueue(tx, {
    orgId: null,
    kind: FEEDBACK_FILE_PURGE_JOB,
    payload: { id },
    dedupeKey: `feedback.file:${id}:${at.getTime()}`,
    runAt: new Date(at.getTime() + 60_000),
  });

/** The person takes a file back before sending: gone at once. Only their own, and only one not sent yet. */
export async function dropFeedbackFile(deps: FeedbackFileDeps, userId: string, id: string) {
  const [row] = await deps.db
    .delete(schema.feedbackFiles)
    .where(
      and(
        eq(schema.feedbackFiles.id, id),
        eq(schema.feedbackFiles.userId, userId),
        isNull(schema.feedbackFiles.sentAt),
      ),
    )
    .returning({ id: schema.feedbackFiles.id });
  if (!row) throw new NotFoundError("Not found");
  await deps.blobs.delete(feedbackBlobKey(id));
}

const kindOf = (contentType: string): FeedbackFileKind => (contentType.startsWith("video/") ? "video" : "image");

/**
 * The files a feedback is sent with, in the caller's transaction: each must be the person's own, still waiting, and
 * together within what one feedback takes. Each gets its link (`publicUrl` + a token only the email holds) and a
 * month to live.
 */
export async function attachFeedbackFiles(
  tx: Executor,
  input: {
    userId: string;
    orgId: string | null;
    ids: readonly string[];
    publicUrl: string;
    /** How long they are kept once sent; a month unless the caller needs them for less. */
    keepMs?: number;
  },
  now = new Date(),
): Promise<FeedbackFileRef[]> {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(schema.feedbackFiles)
    .where(
      and(
        inArray(schema.feedbackFiles.id, ids),
        eq(schema.feedbackFiles.userId, input.userId),
        isNull(schema.feedbackFiles.sentAt),
        gt(schema.feedbackFiles.expiresAt, now),
      ),
    );
  if (rows.length !== ids.length) throw new ValidationError("A file is gone: add it again", "feedback.files_gone");
  const videos = rows.filter((r) => kindOf(r.contentType) === "video").length;
  if (videos > FEEDBACK_FILES.videos || rows.length - videos > FEEDBACK_FILES.images)
    throw new ValidationError("Too many files for one feedback", "feedback.files_many");
  const expiresAt = new Date(now.getTime() + (input.keepMs ?? FEEDBACK_SENT_MS));
  const base = input.publicUrl.replace(/\/$/, "");
  const out: FeedbackFileRef[] = [];
  // In the order the person added them.
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row) continue;
    const token = randomToken(32);
    await tx
      .update(schema.feedbackFiles)
      .set({ sentAt: now, expiresAt, tokenHash: sha256(token), orgId: input.orgId })
      .where(eq(schema.feedbackFiles.id, id));
    await queuePurge(tx, id, expiresAt);
    out.push({
      id,
      name: row.name,
      contentType: row.contentType,
      size: row.size,
      kind: kindOf(row.contentType),
      url: `${base}/api/feedback-files/${token}`,
      expiresAt: expiresAt.toISOString(),
    });
  }
  return out;
}

/** The file a link's token opens, while it lasts; null for any other token. */
export async function feedbackFileByToken(deps: FeedbackFileDeps, token: string, now = new Date()) {
  if (!/^[\w-]{20,100}$/.test(token)) return null;
  const [row] = await deps.db
    .select()
    .from(schema.feedbackFiles)
    .where(and(eq(schema.feedbackFiles.tokenHash, sha256(token)), gt(schema.feedbackFiles.expiresAt, now)));
  if (!row) return null;
  const blob = await deps.blobs.get(feedbackBlobKey(row.id));
  return blob ? { name: row.name, contentType: row.contentType, size: row.size, body: blob.body } : null;
}

/**
 * Job `feedback.file.purge`: the file and its row go once its time is up. A file given more time since (it was sent)
 * is left for the later purge; a row already gone (its person deleted their account) still loses its bytes.
 */
export async function purgeFeedbackFile(deps: FeedbackFileDeps, id: string, now = new Date()) {
  const [row] = await deps.db
    .select({ expiresAt: schema.feedbackFiles.expiresAt })
    .from(schema.feedbackFiles)
    .where(eq(schema.feedbackFiles.id, id));
  if (row && row.expiresAt.getTime() > now.getTime()) return;
  await deps.blobs.delete(feedbackBlobKey(id));
  if (row) await deps.db.delete(schema.feedbackFiles).where(eq(schema.feedbackFiles.id, id));
}

/** How long past its time a file may sit before the sweep takes it: its own purge job runs a minute after. */
const SWEEP_AFTER_MS = 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The net under the purge jobs, run every few hours: a file an hour past its time (its job failed for good) goes,
 * and so do bytes with no row left (a job lost after its row went). Returns how many it removed.
 */
export async function sweepFeedbackFiles(deps: FeedbackFileDeps, now = new Date()) {
  const late = await deps.db
    .select({ id: schema.feedbackFiles.id })
    .from(schema.feedbackFiles)
    .where(lt(schema.feedbackFiles.expiresAt, new Date(now.getTime() - SWEEP_AFTER_MS)))
    .limit(500);
  for (const { id } of late) {
    await deps.blobs.delete(feedbackBlobKey(id));
    await deps.db.delete(schema.feedbackFiles).where(eq(schema.feedbackFiles.id, id));
  }
  const prefix = feedbackBlobKey("");
  const stored = (await deps.blobs.list(prefix, 1000)).map((key) => key.slice(prefix.length));
  const ids = stored.filter((id) => UUID.test(id));
  const kept = ids.length
    ? await deps.db
        .select({ id: schema.feedbackFiles.id })
        .from(schema.feedbackFiles)
        .where(inArray(schema.feedbackFiles.id, ids))
    : [];
  const have = new Set(kept.map((r) => r.id));
  const orphans = ids.filter((id) => !have.has(id));
  for (const id of orphans) await deps.blobs.delete(feedbackBlobKey(id));
  return late.length + orphans.length;
}
