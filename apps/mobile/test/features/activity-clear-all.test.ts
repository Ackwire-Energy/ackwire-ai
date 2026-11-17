import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canClearAll } from "@agenteschat/client/lib/notifications";
import { soundForEvent } from "@agenteschat/client/lib/sounds";
import type { ActivityFilter } from "../../src/features/activity/logic";

const src = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");

test("what the person brings back (the undo of Clear all) rings nothing on the phone; news does", () => {
  const events = src("features/shared/userEvents.ts");
  expect(events).toContain("soundForEvent(event, ");
  expect(events).not.toContain("soundForNotification(");
  const notification = {
    id: "n1",
    kind: "mention",
    waiting: false,
    readAt: null,
    doneAt: null,
    snoozedUntil: null,
  } as Parameters<typeof soundForEvent>[0]["notification"];
  expect(soundForEvent({ type: "notification.upserted", notification, alert: false }, false)).toBeNull();
  expect(soundForEvent({ type: "notification.upserted", notification }, false)).toBe("mention");
});

test("Clear all shows in Tudo only, and only with something beyond what waits on the person", () => {
  expect(src("features/activity/ActivityScreen.tsx")).toContain(
    "if (!canClearAll(filter, counts, items)) return null;",
  );
  const counts = { all: 5, mentions: 3, unread: 4, reactions: 1, waiting: 2 };
  const at = (filter: ActivityFilter) => canClearAll(filter, counts, []);
  expect(at("all")).toBe(true);
  expect(at("waiting")).toBe(false);
  expect(at("done")).toBe(false);
  expect(canClearAll("all", { ...counts, all: 2 }, [])).toBe(false);
});
