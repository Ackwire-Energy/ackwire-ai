import { describe, expect, test } from "bun:test";
import { chatHref, hrefForPush, hrefFromUrl, notificationHref } from "../../src/features/links/logic";
import { notification } from "./fixtures";

describe("deep links", () => {
  test("a conversation, with or without its thread", () => {
    expect(chatHref("c1")).toBe("/chat/c1");
    expect(chatHref("c1", "t1")).toBe("/chat/c1?thread=t1");
    expect(chatHref("c1", "c1")).toBe("/chat/c1");
  });

  test("agenteschat:// links map to routes, and nothing else does", () => {
    expect(hrefFromUrl("agenteschat://chat/abc")).toBe("/chat/abc");
    expect(hrefFromUrl("agenteschat://chat/abc?thread=t-9")).toBe("/chat/abc?thread=t-9");
    expect(hrefFromUrl("agenteschat://approval/a1")).toBe("/approval/a1");
    expect(hrefFromUrl("agenteschat://mission/m1")).toBe("/mission/m1");
    expect(hrefFromUrl("agenteschat://activity")).toBe("/activity");
    expect(hrefFromUrl("agenteschat://threads")).toBe("/threads");
    expect(hrefFromUrl("/agent/x1")).toBe("/agent/x1");
    expect(hrefFromUrl("agenteschat://chat/../../etc")).toBeNull();
    expect(hrefFromUrl("agenteschat://chat")).toBeNull();
    expect(hrefFromUrl("agenteschat://settings/x")).toBeNull();
    expect(hrefFromUrl("agenteschat://chat/abc?thread=<script>")).toBe("/chat/abc");
  });
});

describe("push payloads", () => {
  test("an approval always opens the request (never approved from the push)", () => {
    expect(hrefForPush({ kind: "approval", approvalId: "a1", channelId: "c1" })).toBe("/approval/a1");
  });
  test("a finished or stopped mission opens the mission", () => {
    expect(hrefForPush({ kind: "mission_stopped", missionId: "m1", channelId: "c1" })).toBe("/mission/m1");
  });
  test("messages open their conversation and thread", () => {
    expect(hrefForPush({ kind: "mention", channelId: "c1", threadId: "t1" })).toBe("/chat/c1?thread=t1");
    expect(hrefForPush({ kind: "dm", channelId: "d1" })).toBe("/chat/d1");
  });
  test("anything else opens Atividade", () => {
    expect(hrefForPush({ kind: "forum_turn" })).toBe("/activity");
    expect(hrefForPush({ channelId: 5 })).toBe("/activity");
  });
});

describe("inbox items", () => {
  test("approvals, missions, threads, DMs", () => {
    expect(notificationHref(notification({ id: "n", kind: "approval", source: { approvalId: "a1" } }))).toBe(
      "/approval/a1",
    );
    expect(notificationHref(notification({ id: "n", kind: "mission_finished", source: { missionId: "m1" } }))).toBe(
      "/mission/m1",
    );
    expect(
      notificationHref(notification({ id: "n", kind: "thread_reply", source: { channelId: "c1", threadId: "t1" } })),
    ).toBe("/chat/c1?thread=t1");
    expect(notificationHref(notification({ id: "n", kind: "dm", source: { dmId: "d1" } }))).toBe("/chat/d1");
  });
  test("issues, the forum and routines have no screen in the app", () => {
    expect(
      notificationHref(notification({ id: "n", kind: "issue_comment", source: { issueId: "i1", channelId: "c1" } })),
    ).toBeNull();
    expect(notificationHref(notification({ id: "n", kind: "forum_turn", source: { topicId: "f1" } }))).toBeNull();
    expect(notificationHref(notification({ id: "n", kind: "routine_failed", source: { routineId: "r1" } }))).toBeNull();
  });
});
