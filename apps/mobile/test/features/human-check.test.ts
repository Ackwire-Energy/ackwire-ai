import { describe, expect, test } from "bun:test";
import { ApiError } from "@agenteschat/client";
import { createHumanCheck, withHumanCheck } from "@agenteschat/client/lib/human-check";
import {
  checkEvent,
  FRESH_PAGE,
  failureText,
  humanCheckEvent,
  humanCheckOrigins,
  humanCheckStays,
  humanCheckUrl,
  loadsAgain,
  lookUpFailureText,
  refusalOf,
  refusalText,
  signUpClosed,
  socialRefusalText,
} from "../../src/features/auth/human-check";
import { translator } from "./fixtures";

const SERVER = "https://app.agentes.chat";
const PAGE = `${SERVER}/human-check.html?k=a&a=sign-in`;
const FRAME =
  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x1y2z/0x4AAAAAAA/light/fbE/new/normal/auto/";
const LOOK_ALIKES = [
  "https://challenges.cloudflare.com.evil.example/x",
  "https://app.agentes.chat.evil.example/human-check.html",
  "https://app.agentes.chat@evil.example/",
];

/**
 * react-native-webview's own test of an address (`WebViewShared.tsx`): each entry of `originWhitelist`, `about:blank`
 * always among them, is a prefix of the address's origin (`*` any run). Anything else opens in the browser, and
 * `onShouldStartLoadWithRequest` decides the rest.
 */
function passesWhitelist(whitelist: string[], url: string) {
  const origin = /^[A-Za-z][A-Za-z0-9+\-.]+:(\/\/)?[^/]*/.exec(url)?.[0] ?? "";
  return ["about:blank", ...whitelist].some((entry) =>
    new RegExp(`^${entry.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&").replace(/\\\*/g, ".*")}`).test(origin),
  );
}

describe("the check's WebView", () => {
  test("keeps the server's page and Cloudflare's frame in place, sends other links to the browser, refuses look-alikes", () => {
    const whitelist = humanCheckOrigins(SERVER);
    expect(whitelist).toEqual([
      "about:blank",
      "about:srcdoc",
      "https://app.agentes.chat",
      "https://challenges.cloudflare.com",
    ]);
    for (const url of [FRAME, PAGE, "about:srcdoc", "about:blank"]) {
      expect(passesWhitelist(whitelist, url)).toBe(true);
      expect(humanCheckStays(SERVER, url)).toBe(true);
    }
    // Cloudflare's own links from the checkbox, and anything not over https from it.
    expect(passesWhitelist(whitelist, "https://www.cloudflare.com/privacypolicy/")).toBe(false);
    expect(passesWhitelist(whitelist, "http://challenges.cloudflare.com/turnstile/v0/api.js")).toBe(false);
    // The whitelist only tests the start of an origin: these pass it, and only the exact origins load.
    for (const url of LOOK_ALIKES) {
      expect(passesWhitelist(whitelist, url)).toBe(true);
      expect(humanCheckStays(SERVER, url)).toBe(false);
    }
    // Without Cloudflare's origin its frame would leave for the browser and the check would never load.
    expect(passesWhitelist([SERVER], FRAME)).toBe(false);
    // A server reached at an address with a port keeps it.
    expect(humanCheckOrigins("http://192.168.0.12:4310")).toContain("http://192.168.0.12:4310");
    expect(humanCheckStays("http://192.168.0.12:4310", "http://192.168.0.12:4310/human-check.html")).toBe(true);
    expect(humanCheckStays("http://192.168.0.12:4310", "http://192.168.0.12:4311/human-check.html")).toBe(false);
  });

  test("opens the server's own page with the widget's site key, action, theme and language", () => {
    const url = humanCheckUrl("https://app.agentes.chat", {
      siteKey: "1x00000000000000000000AA",
      action: "ask-code",
      theme: "dark",
      language: "pt-BR",
    });
    expect(url).toBe("https://app.agentes.chat/human-check.html?k=1x00000000000000000000AA&a=ask-code&t=dark&l=pt-BR");
  });

  test("reads the server page's messages, and nothing else", () => {
    // iOS names the page's address, Android the origin of the frame that sent it.
    const read = (data: string, url = PAGE) => humanCheckEvent(SERVER, { url, data });
    expect(read('{"type":"token","token":"XXXX.DUMMY.TOKEN.XXXX"}')).toEqual({
      type: "token",
      token: "XXXX.DUMMY.TOKEN.XXXX",
    });
    expect(read('{"type":"token","token":"tok"}', SERVER)).toEqual({ type: "token", token: "tok" });
    expect(read('{"type":"error","code":"110200"}')).toEqual({ type: "error", code: "110200" });
    expect(read('{"type":"error","code":300030}')).toEqual({ type: "error", code: "300030" });
    // The script's own failure carries no code.
    expect(read('{"type":"error"}')).toEqual({ type: "error" });
    for (const type of ["expired", "interactive", "done"]) expect(read(JSON.stringify({ type }))).toEqual({ type });
    for (const junk of [
      "",
      "not json",
      "null",
      "[]",
      '{"type":"token"}',
      '{"type":"token","token":""}',
      '{"type":"x"}',
    ])
      expect(read(junk)).toBeNull();
    // Another page, Cloudflare's frame or a blank one can't raise the sheet or hand over a token.
    for (const url of [...LOOK_ALIKES, FRAME, "https://challenges.cloudflare.com", "about:blank", "null", ""])
      expect(read('{"type":"interactive"}', url)).toBeNull();
  });
});

describe("the page's events, given to the widget's tokens", () => {
  test("a token goes to the waiting call", async () => {
    const tokens = createHumanCheck();
    const call = tokens.token();
    expect(checkEvent(tokens, FRESH_PAGE, { type: "token", token: "tok" })).toEqual(FRESH_PAGE);
    expect(await call).toBe("tok");
  });

  test("Cloudflare asking for a click: the call waits past the 30 s for the person, then takes the token", async () => {
    const tokens = createHumanCheck(20);
    const call = tokens.token();
    const asking = checkEvent(tokens, FRESH_PAGE, { type: "interactive" });
    expect(asking).toEqual({ asking: true, broken: false });
    await Bun.sleep(60);
    expect(checkEvent(tokens, asking, { type: "done" }).asking).toBe(false);
    expect(checkEvent(tokens, asking, { type: "token", token: "clicked" }).asking).toBe(false);
    expect(await call).toBe("clicked");
  });

  test("unavailable when the widget fails (with its code) or the page or its script doesn't load", async () => {
    const widget = createHumanCheck();
    const page = checkEvent(widget, FRESH_PAGE, { type: "error", code: "110200" });
    expect(page.broken).toBe(false);
    expect(await widget.token()).toBe("unavailable:110200");

    const script = createHumanCheck();
    const call = script.token();
    const broken = checkEvent(script, FRESH_PAGE, { type: "error" });
    expect(broken).toEqual({ asking: false, broken: true });
    expect(await call).toBe("unavailable");
    // The page loads again (the next press, another action, or after the system ended it): the check works again.
    expect(checkEvent(script, broken, { type: "token", token: "tok" }).broken).toBe(false);
  });

  test("a page that didn't load loads again at the next press, which waits for it", async () => {
    const tokens = createHumanCheck();
    const broken = checkEvent(tokens, FRESH_PAGE, { type: "error" });
    // Left as it is, the old page answers every press with `unavailable`.
    expect(loadsAgain(tokens, FRESH_PAGE)).toBe(false);
    expect(await tokens.token()).toBe("unavailable");
    // The person moved to another network, as the blocked line asks, and presses: the call waits for the new page.
    expect(loadsAgain(tokens, broken)).toBe(true);
    const press = tokens.token();
    checkEvent(tokens, FRESH_PAGE, { type: "token", token: "fresh" });
    expect(await press).toBe("fresh");
  });

  test("an expired token is never sent: the call waits for the next one", async () => {
    const tokens = createHumanCheck();
    checkEvent(tokens, FRESH_PAGE, { type: "token", token: "old" });
    checkEvent(tokens, FRESH_PAGE, { type: "expired" });
    const call = tokens.token();
    checkEvent(tokens, FRESH_PAGE, { type: "token", token: "new" });
    expect(await call).toBe("new");
  });
});

describe("refusals in the phone's words", () => {
  test("the bot check's by code, its blocked line naming no browser", async () => {
    const en = await translator("en");
    expect(refusalText(en, { status: 403, code: "human_check" })).toBe(
      "We couldn't confirm you're a person. Try again.",
    );
    expect(refusalText(en, { status: 403, code: "human_check_blocked" })).toBe(
      "The check didn't load. Try another network.",
    );
    const pt = await translator("pt-BR");
    expect(refusalText(pt, new ApiError(403, "human_check_blocked", "The bot check didn't load."))).toBe(
      "A verificação não carregou. Tente outra rede.",
    );
  });

  test("the rest: too many tries, a blocked account, a known code, else the generic line", async () => {
    const en = await translator("en");
    expect(refusalText(en, { status: 429 })).toBe(en("auth.tooManyTries"));
    expect(refusalText(en, new ApiError(429, "join.code_limit", "x"))).toBe(en("errors.code.limit"));
    expect(refusalText(en, { status: 403, code: "ACCOUNT_BLOCKED" })).toBe(en("auth.accountBlocked"));
    // On agentes.chat Cloud: the block's kind and how to contest it, never its reason.
    expect(refusalText(en, { status: 403, code: "ACCOUNT_BLOCKED", kind: "abuse", cloud: true })).toBe(
      "This account is blocked. Our checks linked it to an account closed for abuse (Terms, section 5). To contest it, write to legal@agentes.chat.",
    );
    expect(refusalText(en, { status: 403, code: "ACCOUNT_BLOCKED", kind: "legal", cloud: true })).toBe(
      "This account is blocked while we keep its data for a legal matter. To ask about it, write to legal@agentes.chat.",
    );
    expect(refusalText(en, { status: 500, code: "internal" })).toBe("Something went wrong. Try again.");
    expect(failureText(en, new TypeError("Network request failed"))).toBe(en("mobile.auth.errors.network"));
    expect(failureText(en, new ApiError(400, "join.code_wrong", "x"))).toBe("Wrong code. Try again.");
  });

  test("a limit: the sign-in's e-mail step says the sign-in's words, as the web's does, other calls the API's", async () => {
    const en = await translator("en");
    const limit = new ApiError(429, "rate_limited", "Too many requests. Try again later.");
    expect(lookUpFailureText(en, limit)).toBe(en("auth.tooManyTries"));
    expect(failureText(en, limit)).toBe(en("common.tooMany"));
    expect(lookUpFailureText(en, new ApiError(403, "human_check", "x"))).toBe(
      "We couldn't confirm you're a person. Try again.",
    );
    expect(lookUpFailureText(en, new TypeError("Network request failed"))).toBe(en("mobile.auth.errors.network"));
  });

  test("a social sign-in refused: a blocked account's line, with its kind on agentes.chat Cloud, else it failed", async () => {
    const en = await translator("en");
    // Apple's native sign-in gets the server's answer itself.
    const blocked = "ACCOUNT_BLOCKED";
    expect(socialRefusalText(en, { code: blocked, kind: "abuse", cloud: true })).toBe(
      "This account is blocked. Our checks linked it to an account closed for abuse (Terms, section 5). To contest it, write to legal@agentes.chat.",
    );
    expect(socialRefusalText(en, { code: blocked, kind: "other", cloud: true })).toBe(
      "This account can't sign in. To contest it, write to legal@agentes.chat.",
    );
    expect(socialRefusalText(en, { code: blocked })).toBe(en("auth.accountBlocked"));
    expect(socialRefusalText(en, { code: "INVALID_TOKEN" })).toBe("Couldn't sign you in right now. Try again.");
    expect(socialRefusalText(en, {})).toBe(en("mobile.auth.social.failed"));
  });

  test("a sign-up's 403 is sign-up closed only when it isn't the bot check's", () => {
    expect(signUpClosed({ status: 403 })).toBe(true);
    expect(signUpClosed({ status: 403, code: "FORBIDDEN" })).toBe(true);
    expect(signUpClosed({ status: 403, code: "human_check" })).toBe(false);
    expect(signUpClosed({ status: 403, code: "human_check_blocked" })).toBe(false);
    expect(signUpClosed({ status: 429 })).toBe(false);
  });

  test("Better Auth's refusal, read on top, is sent once more with a fresh token on human_check", async () => {
    expect(refusalOf({ error: null })).toBeNull();
    // A blocked account's kind comes along, for its line.
    expect(refusalOf({ error: { status: 403, code: "ACCOUNT_BLOCKED", kind: "legal", cloud: true } })).toEqual({
      status: 403,
      code: "ACCOUNT_BLOCKED",
      kind: "legal",
      cloud: true,
    });
    let n = 0;
    const check = { token: async () => `tok-${++n}`, reset: () => {} };
    const sent: (string | undefined)[] = [];
    const refused = await withHumanCheck(check, async (token) => {
      sent.push(token);
      return refusalOf({ error: sent.length === 1 ? { status: 403, code: "human_check" } : null });
    });
    expect(refused).toBeNull();
    expect(sent).toEqual(["tok-1", "tok-2"]);
  });
});
