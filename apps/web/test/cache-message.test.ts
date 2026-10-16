import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { keys } from "@/api/keys";
import { cacheMessage } from "@/api/queries";
import type { Message } from "@/api/types";

const msg = (over: Partial<Message>): Message => ({
  id: "m",
  channelId: "c1",
  threadId: null,
  author: { type: "person", id: "u1" },
  body: "muito bom",
  mentionedAgentIds: [],
  agentRunId: null,
  meta: {},
  createdAt: "2026-10-16T04:24:00.000Z",
  ...over,
});

test("a reply that starts a thread replaces its 'sending…' copy (which waits in the channel list)", () => {
  const qc = new QueryClient();
  const root = msg({ id: "root", body: "carrossel pronto", createdAt: "2026-10-16T04:19:00.000Z" });
  const local = msg({ id: "local-k1", threadId: "root", clientId: "k1", local: "pending" });
  qc.setQueryData(keys.messages("o1", "c1"), [root, local]);

  cacheMessage(qc, "o1", msg({ id: "real", threadId: "root", clientId: "k1" }));

  expect(qc.getQueryData<Message[]>(keys.messages("o1", "c1"))?.map((m) => m.id)).toEqual(["root"]);
  expect(qc.getQueryData<Message[]>(keys.thread("o1", "c1", "root"))?.map((m) => m.id)).toEqual(["real"]);
});
