import { expect, test } from "bun:test";
import type { WaitingItem } from "../src/api/types";
import { waitingAway, waitingNotification } from "../src/lib/waiting";

const item = (id: string, source: WaitingItem["source"]): WaitingItem => ({
  id,
  kind: "agent_question",
  asker: { type: "agent", id: "a1" },
  source,
  question: "Qual ambiente?",
  since: "2026-01-05T10:00:00.000Z",
});

test("only this conversation's items whose card isn't loaded count; a thread's view counts its own", () => {
  const items = [
    item("old", { channelId: "c1", messageId: "m-old" }),
    item("loaded", { channelId: "c1", messageId: "m-loaded" }),
    item("thread", { channelId: "c1", messageId: "m-thread", threadId: "t1" }),
    item("other", { channelId: "c2", messageId: "m-other" }),
    item("no-card", { channelId: "c1" }),
  ];
  const loaded = new Set(["m-loaded"]);
  expect(waitingAway(items, "c1", null, loaded).map((i) => i.id)).toEqual(["old", "thread"]);
  expect(waitingAway(items, "c1", "t1", loaded).map((i) => i.id)).toEqual(["thread"]);
  expect(waitingAway(undefined, "c1", null, loaded)).toEqual([]);
});

test("an item opens as its inbox row: same id, kind, asker and source", () => {
  const n = waitingNotification(item("q", { channelId: "c1", messageId: "m1", questionId: "q1" }));
  expect(n).toMatchObject({
    id: "q",
    kind: "agent_question",
    waiting: true,
    actors: [{ type: "agent", id: "a1" }],
    source: { channelId: "c1", messageId: "m1", questionId: "q1" },
  });
});
