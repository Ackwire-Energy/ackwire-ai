import { keys, type Message } from "@agenteschat/client";
import { upsertMessage } from "@agenteschat/client/lib/timeline";
import type { QueryClient } from "@tanstack/react-query";
import { Directory, File, Paths } from "expo-file-system";
import { authedFetch } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { retryDelayMs, uploadVerdict } from "./logic";

/**
 * Recordings on their way to the server. A recording lands in the app's documents the moment it is sent and stays
 * there, across restarts, until the server took it: no signal only delays it. Its bubble is an optimistic message
 * that the real one replaces by `clientId`.
 */
export interface VoiceSend {
  clientId: string;
  orgId: string;
  channelId: string;
  threadId: string | null;
  replyTo: string | null;
  authorId: string;
  /** File name in the folder (a path would go stale: iOS moves the app's container on updates). */
  file: string;
  durationMs: number;
  peaks: number[];
  language: string | null;
  createdAt: string;
  /** The server it was recorded on: it goes there, with that server's session, whichever is open (ADR 0154). */
  server?: string;
  /** Why the last try didn't go (an HTTP status or the network's error), kept with the recording to tell it apart. */
  lastError?: string;
  tries?: number;
}

export type VoiceRefusal = "limit" | "refused";

const folder = () => new Directory(Paths.document, "voice-outbox");
const index = () => new File(folder(), "index.json");
let queue: VoiceSend[] | null = null;
let attempts = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
/** A flush asked for while one runs (a new recording): run once more when it ends, so nothing waits for the timer. */
let again = false;

function read(): VoiceSend[] {
  if (queue) return queue;
  try {
    const f = index();
    queue = f.exists ? (JSON.parse(f.textSync()) as VoiceSend[]) : [];
  } catch {
    queue = [];
  }
  return queue;
}

function write() {
  try {
    if (!folder().exists) folder().create({ intermediates: true });
    index().write(JSON.stringify(queue ?? []));
  } catch {
    // Not kept across a restart; it still goes while the app stays open.
  }
}

/** The bubble until the real message arrives: my audio, not playable yet, no words. */
export const localVoiceMessage = (item: VoiceSend): Message => ({
  id: `local-${item.clientId}`,
  channelId: item.channelId,
  threadId: item.threadId,
  author: { type: "person", id: item.authorId },
  body: "",
  mentionedAgentIds: [],
  agentRunId: null,
  meta: { voice: { clipId: `local:${item.clientId}`, durationMs: item.durationMs, peaks: item.peaks } },
  clientId: item.clientId,
  local: "pending",
  createdAt: item.createdAt,
});

const listKeys = (item: Pick<VoiceSend, "orgId" | "channelId" | "threadId">) => [
  keys.messages(item.orgId, item.channelId),
  ...(item.threadId ? [keys.thread(item.orgId, item.channelId, item.threadId)] : []),
];

export function showBubble(qc: QueryClient, item: VoiceSend) {
  const local = localVoiceMessage(item);
  for (const key of listKeys(item)) {
    qc.setQueryData<Message[]>(key, (list) => (list ? upsertMessage(list, local) : list));
  }
}

export function removeBubble(qc: QueryClient, item: Pick<VoiceSend, "orgId" | "channelId" | "threadId" | "clientId">) {
  for (const key of listKeys(item)) {
    qc.setQueryData<Message[]>(key, (list) => list?.filter((m) => !(m.local && m.clientId === item.clientId)));
  }
}

/** Keeps why a try failed with the recording, and how many tries it took so far. */
function note(item: VoiceSend, why: string) {
  queue = read().map((q) =>
    q.clientId === item.clientId ? { ...q, lastError: why.slice(0, 200), tries: (q.tries ?? 0) + 1 } : q,
  );
  write();
}

function forget(item: VoiceSend) {
  queue = read().filter((q) => q.clientId !== item.clientId);
  write();
  try {
    const f = new File(folder(), item.file);
    if (f.exists) f.delete();
  } catch {}
}

async function upload(item: VoiceSend) {
  const form = new FormData();
  form.append("file", {
    uri: new File(folder(), item.file).uri,
    name: "voice.m4a",
    type: "audio/mp4",
  } as unknown as Blob);
  form.append("durationMs", String(item.durationMs));
  form.append("peaks", JSON.stringify(item.peaks));
  form.append("clientId", item.clientId);
  if (item.threadId) form.append("threadId", item.threadId);
  if (item.replyTo) form.append("replyTo", item.replyTo);
  if (item.language) form.append("language", item.language);
  const server = item.server ?? serverUrl();
  const res = await authedFetch(
    `${server}/api/app/organizations/${item.orgId}/channels/${item.channelId}/voice`,
    { method: "POST", body: form },
    server,
  );
  if (res.status >= 400 && res.status < 500) {
    const body = (await res.json().catch(() => null)) as { code?: string } | null;
    if (body?.code === "voice_limit" || body?.code === "voice.limit") return "limit" as const;
  }
  const verdict = uploadVerdict(res.status);
  if (verdict === "retry") note(item, `HTTP ${res.status}`);
  return verdict;
}

/** Where an item's order matters: its conversation on its server (two conversations never wait on each other). */
const laneOf = (item: VoiceSend) => `${item.server ?? ""}|${item.orgId}|${item.channelId}|${item.threadId ?? ""}`;

/**
 * Sends what waits. Each conversation on each server is its own lane, sent oldest first and side by side with the
 * others: one that can't go now holds back only the ones after it in its lane, which must keep their order. (A
 * recording for a server out of reach, such as a team's own one behind a private network, used to hold back every
 * recording queued after it on every server, the network's timeout included: they all sat on "Enviando…".)
 */
export async function flushVoice(qc: QueryClient, onRefused: (reason: VoiceRefusal) => void) {
  if (flushing) {
    again = true;
    return;
  }
  flushing = true;
  again = false;
  if (timer) clearTimeout(timer);
  timer = null;
  const lanes = new Map<string, VoiceSend[]>();
  for (const item of read()) {
    const lane = laneOf(item);
    lanes.set(lane, [...(lanes.get(lane) ?? []), item]);
  }
  let held = false;
  try {
    await Promise.all(
      [...lanes.values()].map(async (items) => {
        for (const item of items) {
          const verdict = await upload(item).catch((error: unknown) => {
            note(item, error instanceof Error ? error.message : String(error));
            return "retry" as const;
          });
          if (verdict === "retry") {
            held = true;
            return;
          }
          forget(item);
          if (verdict === "done") continue;
          removeBubble(qc, item);
          onRefused(verdict === "limit" ? "limit" : "refused");
        }
      }),
    );
  } finally {
    flushing = false;
  }
  if (again) {
    void flushVoice(qc, onRefused);
    return;
  }
  if (held) {
    timer = setTimeout(() => void flushVoice(qc, onRefused), retryDelayMs(attempts));
    attempts++;
  } else {
    attempts = 0;
  }
}

/** Takes a finished recording: moved to the app's documents and queued. */
export function queueVoice(
  qc: QueryClient,
  uri: string,
  item: Omit<VoiceSend, "file" | "createdAt">,
  onRefused: (reason: VoiceRefusal) => void,
) {
  if (!folder().exists) folder().create({ intermediates: true });
  const file = `${item.clientId}.m4a`;
  new File(uri).move(new File(folder(), file));
  const full: VoiceSend = { ...item, file, createdAt: new Date().toISOString(), server: serverUrl() };
  queue = [...read(), full];
  write();
  showBubble(qc, full);
  void flushVoice(qc, onRefused);
}

/** What was still waiting when the app last closed: its bubbles back in the lists. */
export function restoreVoice(qc: QueryClient, orgId: string) {
  for (const item of read()) if (item.orgId === orgId) showBubble(qc, item);
}
