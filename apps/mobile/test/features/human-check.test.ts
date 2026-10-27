import { describe, expect, test } from "bun:test";
import { ApiError } from "@agenteschat/client";
import { createHumanCheck, withHumanCheck } from "@agenteschat/client/lib/human-check";
import {
  checkEvent,
  FRESH_PAGE,
  failureText,
  humanCheckEvent,
  humanCheckOrigins,
  humanCheckUrl,
  refusalOf,
  refusalText,
  signUpClosed,
} from "../../src/features/auth/human-check";
import { translator } from "./fixtures";

/**
 * react-native-webview's own test of an address (`WebViewShared.tsx`): each entry of `originWhitelist`, `about:blank`
 * always among them, is a prefix of the address's origin (`*` any run). Anything else opens in the browser.
 */
function staysInPlace(whitelist: string[], url: string) {
  const origin = /^[A-Za-z][A-Za-z0-9+\-.]+:(\/\/)?[^/]*/.exec(url)?.[0] ?? "";
  return ["about:blank", ...whitelist].some((entry) =>
    new RegExp(`^${entry.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&").replace(/\\\*/g, ".*")}`).test(origin),
  );
}

describe("the check's WebView", () => {
  test("keeps the server's page and Cloudflare's frame in place, and sends anything else to the browser", () => {
    const whitelist = humanCheckOrigins("https://app.agentes.chat");
    expect(whitelist).toContain("https://challenges.cloudflare.com");
    expect(whitelist).toEqual([
      "about:blank",
      "about:srcdoc",
      "https://app.agentes.chat",
      "https://challenges.cloudflare.com",
    ]);
    const frame =
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x1y2z/0x4AAAAAAA/light/fbE/new/normal/auto/";
    expect(staysInPlace(whitelist, frame)).toBe(true);
    expect(staysInPlace(whitelist, "https://app.agentes.chat/human-check.html?k=a&a=sign-in")).toBe(true);
    expect(staysInPlace(whitelist, "about:srcdoc")).toBe(true);
    // Cloudflare's own links from the checkbox, and anything not over https from it.
    expect(staysInPlace(whitelist, "https://www.cloudflare.com/privacypolicy/")).toBe(false);
    expect(staysInPlace(whitelist, "http://challenges.cloudflare.com/turnstile/v0/api.js")).toBe(false);
    // Without Cloudflare's origin its frame would leave for the browser and the check would never load.
    expect(staysInPlace(["https://app.agentes.chat"], frame)).toBe(false);
    // A server reached at an address with a port keeps it.
    expect(humanCheckOrigins("http://192.168.0.12:4310")).toContain("http://192.168.0.12:4310");
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

  test("reads the page's messages, and nothing else", () => {
    expect(humanCheckEvent('{"type":"token","token":"XXXX.DUMMY.TOKEN.XXXX"}')).toEqual({
      type: "token",
      token: "XXXX.DUMMY.TOKEN.XXXX",
    });
    expect(humanCheckEvent('{"type":"error","code":"110200"}')).toEqual({ type: "error", code: "110200" });
    expect(humanCheckEvent('{"type":"error","code":300030}')).toEqual({ type: "error", code: "300030" });
    // The script's own failure carries no code.
    expect(humanCheckEvent('{"type":"error"}')).toEqual({ type: "error" });
    for (const type of ["expired", "interactive", "done"])
      expect(humanCheckEvent(JSON.stringify({ type }))).toEqual({ type });
    for (const junk of [
      "",
      "not json",
      "null",
      "[]",
      '{"type":"token"}',
      '{"type":"token","token":""}',
      '{"type":"x"}',
    ])
      expect(humanCheckEvent(junk)).toBeNull();
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

  test("unavailable when the widget fails (with its code) or the page or its script doesn't load (and stays so)", async () => {
    const widget = createHumanCheck();
    const page = checkEvent(widget, FRESH_PAGE, { type: "error", code: "110200" });
    expect(page.broken).toBe(false);
    expect(await widget.token()).toBe("unavailable:110200");

    const script = createHumanCheck();
    const call = script.token();
    const broken = checkEvent(script, FRESH_PAGE, { type: "error" });
    expect(broken).toEqual({ asking: false, broken: true });
    expect(await call).toBe("unavailable");
    // The page loads again (another action, or after the system ended it): the check works again.
    expect(checkEvent(script, broken, { type: "token", token: "tok" }).broken).toBe(false);
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
    expect(refusalText(en, new ApiError(429, "join.code_limit", "x"))).toBe(en("errors.join.codeLimit"));
    expect(refusalText(en, { status: 403, code: "ACCOUNT_BLOCKED" })).toBe(en("auth.accountBlocked"));
    expect(refusalText(en, { status: 500, code: "internal" })).toBe("Something went wrong. Try again.");
    expect(failureText(en, new TypeError("Network request failed"))).toBe(en("mobile.auth.errors.network"));
    expect(failureText(en, new ApiError(400, "join.code_wrong", "x"))).toBe("Wrong code. Try again.");
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
