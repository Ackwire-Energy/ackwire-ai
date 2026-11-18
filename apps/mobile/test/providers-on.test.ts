import { describe, expect, test } from "bun:test";
import { socialProvidersOn } from "../src/ui/auth/providers-on";

describe("the providers a phone signs in with", () => {
  const on = { google: true, github: true, apple: false };

  test("Android offers what the server has configured, Apple first", () => {
    expect(socialProvidersOn(on, "android")).toEqual(["google", "github"]);
    expect(socialProvidersOn({ ...on, apple: true }, "android")).toEqual(["apple", "google", "github"]);
  });

  test("only the ones an account is linked to, when asked", () => {
    expect(socialProvidersOn(on, "android", ["github"])).toEqual(["github"]);
    expect(socialProvidersOn(on, "android", ["apple"])).toEqual([]);
  });

  test("iOS offers none: the app signs in by e-mail only there", () => {
    expect(socialProvidersOn(on, "ios")).toEqual([]);
    expect(socialProvidersOn({ google: true, github: true, apple: true }, "ios", ["google"])).toEqual([]);
  });

  test("none before the server's answer", () => {
    expect(socialProvidersOn(undefined, "android")).toEqual([]);
  });
});
