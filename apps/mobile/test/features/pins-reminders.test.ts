import { describe, expect, test } from "bun:test";
import type { MessagePin } from "@agenteschat/client";
import { orderPins, pinTarget } from "../../src/features/chat/logic";
import {
  atDayTime,
  checkWhen,
  dayChoices,
  dayOffsetOf,
  defaultCustom,
  isoWithOffset,
  presetAt,
  reminderErrorKey,
  reminderPresets,
  stepTime,
} from "../../src/features/reminders/logic";
import { at, message } from "./fixtures";

const pin = (messageId: string, pinnedMinutesAgo: number, threadId: string | null = null): MessagePin => ({
  messageId,
  channelId: "c1",
  threadId,
  pinnedByUserId: "u1",
  pinnedAt: at(pinnedMinutesAgo),
  message: message({ id: messageId, threadId }),
});

describe("Fixadas", () => {
  test("the latest pin first, one entry per message", () => {
    const list = orderPins([pin("a", 30), pin("b", 5), pin("a", 2), pin("c", 60)]);
    expect(list.map((p) => [p.messageId, p.pinnedAt])).toEqual([
      ["a", at(2)],
      ["b", at(5)],
      ["c", at(60)],
    ]);
  });

  test("a pin on screen scrolls to it; else its thread opens (a top-level message as its own)", () => {
    const onScreen = new Set(["a", "b"]);
    expect(pinTarget(pin("a", 1), onScreen)).toEqual({ kind: "scroll", messageId: "a" });
    expect(pinTarget(pin("r", 1, "t1"), onScreen)).toEqual({ kind: "open", threadId: "t1" });
    expect(pinTarget(pin("old", 1), onScreen)).toEqual({ kind: "open", threadId: "old" });
  });
});

describe("Lembrar", () => {
  // Local time on the device (the tests don't depend on the machine's zone).
  const afternoon = new Date(2026, 9, 17, 15, 20, 42);
  const lateEvening = new Date(2026, 9, 17, 18, 50);

  test("quick times: in an hour, tonight at 19h, tomorrow at 9h", () => {
    const inHour = presetAt("inHour", afternoon);
    expect(inHour?.getTime()).toBe(new Date(2026, 9, 17, 16, 20, 0).getTime());
    expect(presetAt("tonight", afternoon)?.getTime()).toBe(new Date(2026, 9, 17, 19, 0).getTime());
    expect(presetAt("tomorrowMorning", afternoon)?.getTime()).toBe(new Date(2026, 9, 18, 9, 0).getTime());
  });

  test("tonight is not offered when 19h is too close or gone", () => {
    expect(presetAt("tonight", lateEvening)).toBeNull();
    expect(reminderPresets(lateEvening).map((p) => p.preset)).toEqual(["inHour", "tomorrowMorning"]);
    expect(reminderPresets(afternoon).map((p) => p.preset)).toEqual(["inHour", "tonight", "tomorrowMorning"]);
  });

  test("tomorrow morning crosses the end of the month", () => {
    expect(presetAt("tomorrowMorning", new Date(2026, 9, 31, 22, 0))?.getTime()).toBe(
      new Date(2026, 10, 1, 9, 0).getTime(),
    );
  });

  test("custom: seven days from today, a time that steps around the clock", () => {
    const days = dayChoices(afternoon, 7);
    expect(days).toHaveLength(7);
    expect(days[0]?.getTime()).toBe(new Date(2026, 9, 17).getTime());
    expect(days[6]?.getTime()).toBe(new Date(2026, 9, 23).getTime());
    expect(stepTime({ hour: 23, minute: 45 }, 15)).toEqual({ hour: 0, minute: 0 });
    expect(stepTime({ hour: 0, minute: 0 }, -60)).toEqual({ hour: 23, minute: 0 });
    expect(stepTime({ hour: 9, minute: 30 }, -15)).toEqual({ hour: 9, minute: 15 });
    expect(atDayTime(days[1] ?? afternoon, { hour: 14, minute: 30 }).getTime()).toBe(
      new Date(2026, 9, 18, 14, 30).getTime(),
    );
  });

  test("custom starts two hours ahead, or tomorrow at 9h late at night", () => {
    expect(defaultCustom(afternoon)).toEqual({ dayOffset: 0, time: { hour: 17, minute: 0 } });
    expect(defaultCustom(new Date(2026, 9, 17, 21, 10))).toEqual({ dayOffset: 1, time: { hour: 9, minute: 0 } });
  });

  test("today, tomorrow and the server's limits", () => {
    expect(dayOffsetOf(new Date(2026, 9, 17, 23, 59), afternoon)).toBe(0);
    expect(dayOffsetOf(new Date(2026, 9, 18, 0, 1), afternoon)).toBe(1);
    expect(checkWhen(new Date(2026, 9, 17, 15, 0), afternoon)).toBe("past");
    expect(checkWhen(new Date(2026, 9, 17, 15, 21), afternoon)).toBe("past");
    expect(checkWhen(new Date(2026, 9, 17, 16, 0), afternoon)).toBe("ok");
    expect(checkWhen(new Date(2027, 9, 18, 16, 0), afternoon)).toBe("tooFar");
  });

  test("the time goes to the server with its offset", () => {
    const utc = new Date(Date.UTC(2026, 9, 17, 22, 0, 0));
    expect(isoWithOffset(utc, -180)).toBe("2026-10-17T19:00:00-03:00");
    expect(isoWithOffset(utc, 0)).toBe("2026-10-17T22:00:00+00:00");
    expect(isoWithOffset(utc, 330)).toBe("2026-10-18T03:30:00+05:30");
    // With the device's own offset, it is the same instant.
    const local = new Date(2026, 9, 17, 19, 0);
    const iso = isoWithOffset(local);
    expect(iso).toMatch(/^2026-10-17T19:00:00[+-]\d{2}:\d{2}$/);
    expect(new Date(iso).getTime()).toBe(local.getTime());
  });

  test("error codes get friendly words", () => {
    expect(reminderErrorKey("reminder.no_agent")).toBe("noAgent");
    expect(reminderErrorKey("when.past")).toBe("past");
    expect(reminderErrorKey("when.too_far")).toBe("tooFar");
    expect(reminderErrorKey("reminder.text_required")).toBe("noText");
    expect(reminderErrorKey(undefined)).toBe("failed");
  });
});
