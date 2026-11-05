import { expect, test } from "bun:test";
import { routineFailureCode } from "../src/routine-ledger";
import { runErrorDetail } from "../src/runs";

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
