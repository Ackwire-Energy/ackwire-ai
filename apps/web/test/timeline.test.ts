import { describe, expect, test } from "bun:test";
import type { Approval, Message } from "@/api/types";
import { tokenizeBody } from "@/chat/body";
import { buildTimeline, mergeTimeline, threadRootsToLoad, upsertMessage } from "@/chat/timeline";

const msg = (id: string, minute: number, author: Message["author"], threadId: string | null = null): Message => ({
  id,
  channelId: "c",
  threadId,
  author,
  body: id,
  mentionedAgentIds: [],
  agentRunId: null,
  createdAt: new Date(Date.UTC(2026, 9, 14, 10, minute)).toISOString(),
});
const joao = { type: "person" as const, id: "joao" };
const ada = { type: "agent" as const, id: "ada" };

describe("message body", () => {
  test("mentions, inline code and code blocks; emails are not mentions", () => {
    expect(tokenizeBody("@Ada olha `expires_at` e fala com joao@acme.com")).toEqual([
      { type: "mention", handle: "Ada" },
      { type: "text", text: " olha " },
      { type: "code", text: "expires_at" },
      { type: "text", text: " e fala com joao@acme.com" },
    ]);
    expect(tokenizeBody("antes\n```ts\nconst a = 1;\n```\ndepois")).toEqual([
      { type: "text", text: "antes\n" },
      { type: "codeblock", text: "const a = 1;" },
      { type: "text", text: "\ndepois" },
    ]);
    expect(tokenizeBody("<b>não é html</b>")).toEqual([{ type: "text", text: "<b>não é html</b>" }]);
  });
});

describe("timeline", () => {
  test("upsert keeps order and replaces duplicates (HTTP response + WebSocket event)", () => {
    const a = msg("a", 1, joao);
    const b = msg("b", 2, joao);
    let list = upsertMessage(undefined, b);
    list = upsertMessage(list, a);
    list = upsertMessage(list, { ...b, body: "edited" });
    expect(list.map((m) => [m.id, m.body])).toEqual([
      ["a", "a"],
      ["b", "edited"],
    ]);
  });

  test("agent replies live in threads; the channel shows them inline in time order", () => {
    const root = msg("root", 1, joao);
    const reply = msg("reply", 2, ada, "root");
    const later = msg("later", 3, joao);
    expect(mergeTimeline([root, later], [[root, reply], undefined]).map((m) => m.id)).toEqual([
      "root",
      "reply",
      "later",
    ]);
    expect(threadRootsToLoad([root, msg("x", 2, ada), later])).toEqual(["root", "later"]);
  });

  test("days, grouping by author within 5 minutes, approvals and live runs", () => {
    const yesterday = { ...msg("y", 0, joao), createdAt: "2026-10-13T10:00:00.000Z" };
    const m1 = msg("m1", 1, joao);
    const m2 = msg("m2", 2, joao);
    const m3 = msg("m3", 3, ada);
    const approval = { id: "ap", createdAt: msg("", 4, ada).createdAt } as Approval;
    const items = buildTimeline(
      [yesterday, m1, m2, m3],
      [approval],
      [{ runId: "r", agentId: "atlas", channelId: "c", threadId: "m1", status: "running", text: "Os 401", lastSeq: 1 }],
    );
    expect(items.map((i) => (i.kind === "message" ? `${i.key}${i.grouped ? "+" : ""}` : i.kind))).toEqual([
      "day",
      "y",
      "day",
      "m1",
      "m2+",
      "m3",
      "approval",
      "run",
    ]);
  });
});
