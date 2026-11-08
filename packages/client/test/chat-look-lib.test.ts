import { expect, test } from "bun:test";
import { chatLookOf, facesShown, firstUnreadId, mineOnRight, opensAtLastRead } from "../src/lib/chat-look";

const said = (id: string, author: { type: "person" | "agent"; id: string }, createdAt: string) => ({
  id,
  author,
  createdAt,
});

test("whoever hasn't chosen: channels on the left, DMs in light bubbles", () => {
  expect(chatLookOf(undefined, false)).toEqual({ style: "left", tone: "light" });
  expect(chatLookOf({}, true)).toEqual({ style: "bubbles", tone: "light" });
});

test("channels and DMs each keep their own choice", () => {
  const prefs = { channelStyle: "compact", dmStyle: "comfortable", channelTone: "strong" } as const;
  expect(chatLookOf(prefs, false)).toEqual({ style: "compact", tone: "strong" });
  expect(chatLookOf(prefs, true)).toEqual({ style: "comfortable", tone: "light" });
});

test("my rows stand apart only in the styles that keep the right side", () => {
  expect(["comfortable", "left", "bubbles", "compact"].map((s) => mineOnRight(s as never))).toEqual([
    true,
    false,
    true,
    false,
  ]);
});

test("a DM drops the other side's face where my rows keep the right side; channels and the other looks keep it", () => {
  const styles = ["comfortable", "left", "bubbles", "compact"] as const;
  expect(styles.map((s) => facesShown(s, true))).toEqual([false, true, false, true]);
  expect(styles.map((s) => facesShown(s, false))).toEqual([true, true, true, true]);
});

test("it opens at the last read message only when asked and with something unread", () => {
  expect(opensAtLastRead(undefined, 3)).toBe(false);
  expect(opensAtLastRead({ openAt: "latest" }, 3)).toBe(false);
  expect(opensAtLastRead({ openAt: "read" }, 0)).toBe(false);
  expect(opensAtLastRead({ openAt: "read" }, 3)).toBe(true);
});

test("the first unread message is past the read mark and not mine", () => {
  const list = [
    said("a", { type: "agent", id: "ada" }, "2026-11-05T10:00:00.000Z"),
    said("b", { type: "person", id: "me" }, "2026-11-05T11:00:00.000Z"),
    said("c", { type: "agent", id: "ada" }, "2026-11-05T12:00:00.000Z"),
  ];
  expect(firstUnreadId(list, "2026-11-05T10:30:00.000Z", "me")).toBe("c");
  expect(firstUnreadId(list, "2026-11-05T12:30:00.000Z", "me")).toBeNull();
  expect(firstUnreadId(list, null, "me")).toBe("a");
});
