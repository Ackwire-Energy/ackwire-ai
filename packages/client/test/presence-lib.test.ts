import { describe, expect, test } from "bun:test";
import type { Person } from "../src/api/types";
import { withMyConnection } from "../src/lib/presence";

const person = (userId: string, extra: Partial<Person>) =>
  ({ userId, name: userId, presence: "offline", online: false, status: null, ...extra }) as Person;

describe("withMyConnection", () => {
  test("my row, read before the server counted my open socket, reads connected as I picked", () => {
    const people = [person("me", { availability: "auto" }), person("bia", {})];
    const shown = withMyConnection(people, true);
    expect(shown[0]).toMatchObject({ presence: "online", online: true });
    expect(shown[1]).toBe(people[1] as Person);
    expect(withMyConnection([person("me", { availability: "busy" })], true)[0]?.presence).toBe("busy");
  });

  test("hidden and out of office stay as the server said; nothing changes while my socket is down", () => {
    for (const p of [
      person("me", { availability: "hidden", presence: "hidden" }),
      person("me", { availability: "out", presence: "out" }),
    ])
      expect(withMyConnection([p], true)[0]?.presence).toBe(p.presence);
    const people = [person("me", { availability: "auto" })];
    expect(withMyConnection(people, false)).toBe(people);
  });

  test("someone else offline stays offline: only my row has `availability`", () => {
    const people = [person("bia", {})];
    expect(withMyConnection(people, true)).toBe(people);
  });
});
