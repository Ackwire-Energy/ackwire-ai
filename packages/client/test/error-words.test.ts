import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { ApiError, createFileRequester, createRequester, invitationQuery, NetworkError } from "../src/index";
import { authErrorText, errorText, noAnswer, sendWaits, signInRefusalText } from "../src/lib/errors";

const failure = new TypeError("Failed to fetch");
const unreachable = async () => {
  throw failure;
};

describe("a request that got no answer", () => {
  test("is a NetworkError with fetch's words and fetch's error as its cause, still a TypeError", async () => {
    const request = createRequester({ fetch: unreachable });
    const error = await request("/api/app/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as NetworkError).message).toBe("Failed to fetch");
    expect((error as NetworkError).cause).toBe(failure);
    // A message that waits for the connection still does.
    expect(sendWaits(error)).toBe(true);
    const files = createFileRequester({ fetch: unreachable });
    expect(await files.upload("/x", new FormData()).catch((e: unknown) => e)).toBeInstanceOf(NetworkError);
    expect(await files.blob("/x").catch((e: unknown) => e)).toBeInstanceOf(NetworkError);
  });

  test("a request the app stopped stays what it was", async () => {
    const stopped = new DOMException("The operation was aborted.", "AbortError");
    const request = createRequester({
      fetch: async () => {
        throw stopped;
      },
    });
    expect(await request("/x").catch((e: unknown) => e)).toBe(stopped);
  });

  test("noAnswer: none at all, or only the proxy's; never the server's own refusal or a bug", () => {
    expect(noAnswer(new NetworkError(new TypeError("Load failed")))).toBe(true);
    for (const status of [502, 503, 504, 520, 522, 524]) {
      expect(noAnswer(new ApiError(status, `http_${status}`, "Bad Gateway"))).toBe(true);
    }
    // The server's own 503 says why (a computer that can't take it now).
    expect(noAnswer(new ApiError(503, "machine.target_offline", "That computer is offline"))).toBe(false);
    expect(noAnswer(new ApiError(500, "internal_error", "Something went wrong on our side"))).toBe(false);
    expect(noAnswer(new ApiError(404, "not_found", "Not found"))).toBe(false);
    expect(noAnswer(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(noAnswer(undefined)).toBe(false);
  });
});

/** `useTranslation`'s `t` in `lng`: the key itself, for the words to check. */
const tIn = (lng: string) => Object.assign((key: string) => key, { lng }) as unknown as TFunction;
const pt = tIn("pt-BR");
const en = tIn("en");

/** The browser offline while `run` runs (React Native says nothing: never offline). */
function offline<T>(run: () => T): T {
  const own = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
  try {
    return run();
  } finally {
    if (own) Object.defineProperty(globalThis, "navigator", own);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

describe("a failed request in the person's words (errorText)", () => {
  test("no answer: offline, else the server out of reach; never fetch's or the proxy's own words", () => {
    const network = new NetworkError(new TypeError("Failed to fetch"));
    const proxy = new ApiError(502, "http_502", "Bad Gateway");
    for (const t of [pt, en]) {
      expect(errorText(t, network)).toBe("common.unreachable");
      expect(errorText(t, proxy)).toBe("common.unreachable");
      expect(errorText(t, new ApiError(530, "http_530", ""))).toBe("common.unreachable");
      expect(offline(() => errorText(t, network))).toBe("common.offline");
      expect(offline(() => errorText(t, proxy))).toBe("common.offline");
    }
  });

  test("a 500 says it failed on our side in both languages, never the server's own line", () => {
    const error = new ApiError(500, "internal_error", "Something went wrong on our side");
    expect(errorText(pt, error)).toBe("common.ourSide");
    expect(errorText(en, error)).toBe("common.ourSide");
  });

  test("a computer that can't take it: offline, paused, too slow or commands off in words; its own refusal as said", () => {
    expect(errorText(pt, new ApiError(409, "machine.offline", "Mac is offline", { name: "Mac" }))).toBe(
      "errors.machine.offline",
    );
    expect(errorText(pt, new ApiError(409, "machine.paused", "Mac is paused", { name: "Mac" }))).toBe(
      "errors.machine.paused",
    );
    expect(errorText(pt, new ApiError(503, "machine.timeout", "the computer Mac did not answer in time"))).toBe(
      "errors.machine.timeout",
    );
    expect(errorText(pt, new ApiError(503, "machine.exec_disabled", "Commands are off"))).toBe(
      "errors.mission.execDisabled",
    );
    const own = "This folder is outside the folders this agent may use.";
    expect(errorText(pt, new ApiError(503, "machine.not_allowed", own))).toBe(own);
  });

  test("a budget or a missing key in the person's words, naming the provider when the server does", () => {
    expect(errorText(pt, new ApiError(402, "budget_exceeded", "This agent has used its monthly budget"))).toBe(
      "agentPage.activity.errors.budget_exceeded",
    );
    const missing = "Add an API key for OpenAI in the workspace settings";
    expect(errorText(pt, new ApiError(400, "missing_credential", missing, { provider: "OpenAI" }))).toBe(
      "agentPage.activity.errors.missing_credential",
    );
    expect(errorText(pt, new ApiError(400, "missing_credential", missing))).toBe(missing);
  });

  test("a 403: the engine's own why, else that they can't; never an 'ask an admin' guess", () => {
    const why = "Only the channel's creator or an admin can add members";
    expect(errorText(pt, new ApiError(403, "forbidden", why))).toBe(why);
    expect(errorText(pt, new ApiError(403, "forbidden", "You don't have permission to do this"))).toBe(
      "common.notAllowed",
    );
    expect(errorText(pt, new ApiError(403, "bad_origin", "Cross-origin request refused"))).toBe("common.notAllowed");
    expect(errorText(pt, new ApiError(403, "channel.post_denied", "x"))).toBe("channel.perms.readOnlyComposer");
    // A code the app has no words for keeps the server's why.
    const coded = "This agent can't be added to a channel";
    expect(errorText(pt, new ApiError(403, "agent.no_words_yet", coded))).toBe(coded);
  });

  test("a runner's internal failure is for the log: the person reads it's on our side", () => {
    expect(errorText(pt, new ApiError(503, "machine.internal", "ENOENT: no such file"))).toBe("common.ourSide");
  });

  test("a 4xx the app doesn't know: the server's own words, English being every language's fallback", () => {
    const error = new ApiError(409, "thing.busy", "That thing is busy right now.");
    expect(errorText(en, error)).toBe("That thing is busy right now.");
    expect(errorText(pt, error)).toBe("That thing is busy right now.");
    expect(errorText(en, error, "pt-BR")).toBe("That thing is busy right now.");
    // Codes the app knows, 413 and 403 say what they always said.
    expect(errorText(pt, new ApiError(403, "forbidden", ""))).toBe("common.notAllowed");
    expect(errorText(pt, new ApiError(429, "rate_limited", "Slow down"))).toBe("common.tooMany");
  });

  test("anything that isn't the server's answer: common.unknownError, never its own message", () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'id')");
    expect(errorText(en, bug)).toBe("common.unknownError");
    expect(errorText(en, new Error("Load failed"))).toBe("common.unknownError");
    expect(errorText(en, "boom")).toBe("common.unknownError");
  });

  test("a sign-in that got no answer (status 0, or only the proxy's) says so; another refusal as errorText does", () => {
    const none = { status: 0, code: "network", message: "" };
    expect(authErrorText(pt, none)).toBe("common.unreachable");
    expect(offline(() => authErrorText(pt, none))).toBe("common.offline");
    expect(authErrorText(pt, { status: 503, message: "Service Unavailable" })).toBe("common.unreachable");
    expect(authErrorText(en, { status: 403, code: "INVALID_ORIGIN", message: "Invalid origin" })).toBe(
      "Invalid origin",
    );
    expect(authErrorText(pt, { status: 403, code: "INVALID_ORIGIN", message: "Invalid origin" })).toBe(
      "Invalid origin",
    );
    expect(authErrorText(en, { status: 500, message: "Internal Server Error" })).toBe("common.ourSide");
    expect(authErrorText(pt, { status: 429, message: "Too many" })).toBe("auth.tooManyTries");
  });

  test("an invitation that got no answer is asked twice more; an expired one never", () => {
    const retry = invitationQuery({} as never, "tok").retry as (count: number, error: unknown) => boolean;
    const network = new NetworkError(new TypeError("Failed to fetch"));
    expect([0, 1, 2].map((count) => retry(count, network))).toEqual([true, true, false]);
    expect(retry(0, new ApiError(503, "http_503", "Service Unavailable"))).toBe(true);
    expect(retry(0, new ApiError(404, "not_found", "Invitation not found"))).toBe(false);
  });
});

test("a provider's sign-in that didn't finish, by Better Auth's code: what the person can do", () => {
  const said = (code: string) => signInRefusalText(pt, code, true);
  expect(said("access_denied")).toBe("auth.refused.cancelled");
  // An unconfirmed password account's is the app's own words.
  expect(said("account_not_linked")).toBe("auth.unconfirmed");
  for (const code of ["unable_to_link_account", "account_already_linked_to_different_user"])
    expect(said(code)).toBe("auth.refused.linked");
  expect(said("email_does_not_match")).toBe("auth.refused.linked");
  expect([said("email_not_found"), said("email_not_verified")]).toEqual([
    "auth.refused.noEmail",
    "auth.refused.noEmail",
  ]);
  for (const code of [
    "state_mismatch",
    "state_not_found",
    "invalid_code",
    "no_code",
    "please_restart_the_process",
    "invalid_callback_request",
    "nonce_binding_missing",
    "issuer_mismatch",
    "issuer_missing",
  ])
    expect(said(code)).toBe("auth.refused.expired");
  for (const code of [
    "server_error",
    "internal_server_error",
    "unable_to_get_user_info",
    "oauth_provider_not_found",
    "no_callback_url",
  ])
    expect(said(code)).toBe("auth.refused.server");
  for (const code of ["UNKNOWN", "constructor", "__proto__", ""]) expect(said(code)).toBe("auth.refused.other");
  // The codes the app says itself never read Object's own names either.
  expect(errorText(pt, new ApiError(403, "toString", ""))).toBe("common.notAllowed");
});

test("the right hand refused a place: its own line, never ask an admin", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  const refused = new ApiError(403, "agent.right_hand_permanent", "The team's right hand can't be added to a channel");
  expect(errorText(t, refused)).toBe("errors.rightHand.permanent");
});
