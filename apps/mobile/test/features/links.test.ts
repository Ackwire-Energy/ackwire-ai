import { describe, expect, test } from "bun:test";
import {
  chatHref,
  computerReadyHref,
  hrefForPush,
  hrefFromUrl,
  notificationHref,
  routineHref,
} from "../../src/features/links/logic";
import { notification } from "./fixtures";

describe("deep links", () => {
  test("a conversation, with or without its thread", () => {
    expect(chatHref("c1")).toBe("/chat/c1");
    expect(chatHref("c1", "t1")).toBe("/chat/c1?thread=t1");
    expect(chatHref("c1", null, "m1")).toBe("/chat/c1?m=m1");
    expect(chatHref("c1", "t1", "m1")).toBe("/chat/c1?thread=t1&m=m1");
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
    expect(hrefFromUrl("agenteschat://join-requests")).toBe("/join-requests");
    expect(hrefFromUrl("/join-requests/")).toBe("/join-requests");
    expect(hrefFromUrl("agenteschat://join")).toBeNull();
  });

  test("Rotinas and a routine", () => {
    expect(hrefFromUrl("agenteschat://routines")).toBe("/routines");
    expect(hrefFromUrl("agenteschat://routines/r-1")).toBe("/routines/r-1");
    expect(hrefFromUrl("/routines/r1/")).toBe("/routines/r1");
    expect(hrefFromUrl("agenteschat://routines/<script>")).toBeNull();
    expect(routineHref("r1")).toBe("/routines/r1");
    expect(routineHref(undefined)).toBe("/routines");
    expect(routineHref("../x")).toBe("/routines");
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
  test("someone asking to join opens the requests (never answered from the push)", () => {
    expect(hrefForPush({ kind: "join_request", orgId: "o1", notificationId: "n1" })).toBe("/join-requests");
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
  test("a request to join opens the requests, whoever asked", () => {
    const n = notification({ id: "n", kind: "join_request", actors: [], count: 3, source: { label: "Alves Studio" } });
    expect(notificationHref({ ...n, latest: { title: "Ana Souza" } })).toBe("/join-requests");
  });
  test("issues and the forum have no screen in the app", () => {
    expect(
      notificationHref(notification({ id: "n", kind: "issue_comment", source: { issueId: "i1", channelId: "c1" } })),
    ).toBeNull();
    expect(notificationHref(notification({ id: "n", kind: "forum_turn", source: { topicId: "f1" } }))).toBeNull();
  });

  test("routines: what one found opens the agent's message; its trouble opens the routine (as on the web)", () => {
    const dev = [{ type: "agent" as const, id: "dev" }];
    const finished = notification({
      id: "n",
      kind: "routine_finished",
      actors: dev,
      source: { routineId: "r1", channelId: "c1", messageId: "m1" },
    });
    expect(notificationHref(finished)).toBe("/chat/c1");
    expect(notificationHref({ ...finished, source: { ...finished.source, threadId: "t1" } })).toBe(
      "/chat/c1?thread=t1",
    );
    // What it found without a message to open: the routine.
    expect(notificationHref({ ...finished, source: { routineId: "r1", channelId: "c1" } })).toBe("/routines/r1");
    for (const kind of ["routine_failed", "routine_paused", "routine_stalled"] as const) {
      const n = notification({ id: "n", kind, actors: dev, source: { routineId: "r1", channelId: "c1" } });
      expect(notificationHref(n)).toBe("/routines/r1");
      // Without the routine's id, Rotinas itself.
      expect(notificationHref({ ...n, source: { channelId: "c1" } })).toBe("/routines");
    }
  });

  test("a routine that couldn't call an agent opens the agent's page (who talks to it), not the report", () => {
    const n = notification({
      id: "n",
      kind: "agent_unreached",
      actors: [{ type: "agent" as const, id: "a1" }],
      source: { routineId: "r1", agentId: "a1", userId: "u1", channelId: "c1", messageId: "m1" },
    });
    expect(notificationHref(n)).toBe("/agent/a1");
  });

  test("asking for one more browser profile opens the agent's page", () => {
    const n = notification({
      id: "n",
      kind: "browser_profile_request",
      actors: [{ type: "user" as const, id: "u1" }],
      source: { agentId: "a1", label: "Ada" },
    });
    expect(notificationHref(n)).toBe("/agent/a1");
  });

  test("a computer's disk almost full opens that computer, where the shared folder's size shows (ADR 0115)", () => {
    const n = notification({
      id: "n",
      kind: "computer_disk_full",
      actors: [],
      source: { machineId: "m1", label: "Build box" },
    });
    expect(notificationHref(n)).toBe("/settings/computers/m1");
    expect(notificationHref({ ...n, source: { label: "Build box" } })).toBeNull();
    // A computer without Google Chrome (ADR 0133) opens it too.
    expect(notificationHref({ ...n, kind: "computer_no_chrome" })).toBe("/settings/computers/m1");
  });
});

describe("the workspace's computer is ready", () => {
  const noAi = { any: false, agents: [{ agentId: "a1", state: "no_ai" as const }] };
  const someAi = { any: true, agents: [{ agentId: "a1", state: "ready" as const }] };

  test("Connect an AI, saying it's ready, while no agent has an AI; else the computer's wait", () => {
    expect(computerReadyHref(noAi)).toBe("/connect-ai?ready=1");
    expect(computerReadyHref(someAi)).toBe("/computer-setup");
    // No agents yet, or the status not known: nothing to connect for, the computer.
    expect(computerReadyHref({ any: false, agents: [] })).toBe("/computer-setup");
    expect(computerReadyHref(undefined)).toBe("/computer-setup");
  });

  test("its push and its row in Atividade open the same place", () => {
    expect(hrefForPush({ kind: "computer_ready", orgId: "o1", notificationId: "n1" }, noAi)).toBe(
      "/connect-ai?ready=1",
    );
    expect(hrefForPush({ kind: "computer_ready", orgId: "o1" })).toBe("/computer-setup");
    const n = notification({ id: "n", kind: "computer_ready", actors: [], source: { machineId: "m1", label: "Acme" } });
    expect(notificationHref(n, noAi)).toBe("/connect-ai?ready=1");
    expect(notificationHref(n, someAi)).toBe("/computer-setup");
  });
});
