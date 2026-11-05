import { expect, test } from "bun:test";
import { ProviderError } from "@agenteschat/providers";
import { routineFailureCode } from "../src/routine-ledger";
import { providerFailureOf, providerFailureText, runErrorDetail } from "../src/runs";

test("a failed run's reason: a CLI's failed turn is the computer's, a missing account and our own error say so", () => {
  for (const code of ["codex_failed", "opencode_failed", "antigravity_failed", "brain_failed"]) {
    expect(runErrorDetail(code)).toEqual({ errorCode: "run.computer_failed", errorParams: { code } });
    expect(routineFailureCode(code)).toBe("computer_failed");
  }
  expect(routineFailureCode("runner_error")).toBe("computer_failed");
  expect(routineFailureCode("timeout")).toBe("computer_timeout");
  expect(runErrorDetail("account_missing")).toEqual({ errorCode: "run.account_missing" });
  expect(routineFailureCode("account_missing")).toBe("account_missing");
  for (const error of ["Stopped after an error: duplicate key value", "Stopped after an error that kept repeating."]) {
    expect(runErrorDetail(error)).toEqual({ errorCode: "run.our_error" });
    expect(routineFailureCode(error)).toBe("our_error");
  }
  // The provider refused the key's account: its own words stay out of the line, and a routine's code is the same.
  expect(runErrorDetail("provider_error: account: invalid provider API key")).toEqual({
    errorCode: "run.provider_account",
    errorParams: { detail: "invalid provider API key" },
  });
  expect(routineFailureCode("provider_error: account: invalid provider API key")).toBe("provider_error");
  // What kept its code still does.
  expect(routineFailureCode("gave_up: overloaded")).toBe("gave_up");
  expect(routineFailureCode("provider_error: invalid key")).toBe("provider_error");
});

const failure = (message: string, status: number | undefined, said?: string, platformKey = false) => {
  const error = new ProviderError(message, false, status, undefined, said);
  error.provider = "OpenRouter";
  error.platformKey = platformKey;
  return error;
};

test("a provider failure keeps its cause, its provider and its words, and an older row still reads", () => {
  const stored = providerFailureText("provider_error", failure("no prepaid credit left at the provider", 402));
  expect(runErrorDetail(stored)).toEqual({
    errorCode: "run.provider_no_credit",
    errorParams: { provider: "OpenRouter", detail: "no prepaid credit left at the provider" },
  });
  expect(routineFailureCode(stored)).toBe("provider_error");
  const late = new ProviderError("provider error", true, 503);
  late.provider = "Claude";
  expect(runErrorDetail(providerFailureText("gave_up", late))?.errorCode).toBe("run.provider_down");
  expect(routineFailureCode(providerFailureText("gave_up", late))).toBe("gave_up");
  expect(runErrorDetail("gave_up: overloaded")).toEqual({
    errorCode: "run.provider_unavailable",
    errorParams: { detail: "overloaded" },
  });
  expect(runErrorDetail("provider_error: support@example.com: bad")?.errorCode).toBe("run.provider_error");
  // A workspace's own endpoint goes by its address, port included.
  expect(runErrorDetail("gave_up: down@llm.local:8080: bad gateway")).toEqual({
    errorCode: "run.provider_down",
    errorParams: { provider: "llm.local:8080", detail: "bad gateway" },
  });
});

test("an unknown refusal shows the provider's own words, cut, with no key in them", () => {
  const said = `The key sk-or-v1-${"a".repeat(64)} can't do that. ${"x".repeat(400)}`;
  const { cause, detail } = providerFailureOf(failure("provider rejected the request (400)", 400, said));
  expect(cause).toBe("said");
  expect(detail).toHaveLength(200);
  expect(detail).not.toContain("sk-or-v1");
  expect(detail).toStartWith("The key •••• can't do that.");
});

test("on the server's own key the person's account isn't what failed: it reads as ours", () => {
  const stored = providerFailureText("provider_error", failure("invalid provider API key", 401, undefined, true));
  expect(runErrorDetail(stored)).toEqual({ errorCode: "run.our_error" });
  // Their key or ours, a provider that is down is the provider's.
  const down = failure("provider error", 503, undefined, true);
  expect(providerFailureOf(down).cause).toBe("down");
  // A provider nobody registered on this server is ours too.
  expect(runErrorDetail("No provider registered for acme")).toEqual({ errorCode: "run.our_error" });
});
