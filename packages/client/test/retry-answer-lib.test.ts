import { expect, test } from "bun:test";
import type { ApiClient } from "../src/api/client";
import { ApiError } from "../src/api/http";
import type { Message } from "../src/api/types";
import { retryAnswer } from "../src/lib/retry-answer";

const message = { id: "m1", body: "resume o canal" } as Message;
const apiWith = (answerNow: () => Promise<{ runs: { agentId: string; runId: string }[] }>) =>
  ({ chat: { answerNow } }) as unknown as ApiClient;

test("Tentar de novo answers the same message again: nothing is sent", async () => {
  let resent = 0;
  await retryAnswer(
    apiWith(async () => ({ runs: [{ agentId: "a", runId: "r2" }] })),
    "o",
    message,
    () => resent++,
  );
  expect(resent).toBe(0);
});

test("only when it can't (no run of its own, or one that already did things) do the words go again", async () => {
  let resent = 0;
  await retryAnswer(
    apiWith(async () => ({ runs: [] })),
    "o",
    message,
    () => resent++,
  );
  const worked = new ApiError(409, "run.not_restartable", "already started");
  await retryAnswer(
    apiWith(() => Promise.reject(worked)),
    "o",
    message,
    () => resent++,
  );
  expect(resent).toBe(2);
  const forbidden = new ApiError(403, "run.answer_forbidden", "no");
  await expect(
    retryAnswer(
      apiWith(() => Promise.reject(forbidden)),
      "o",
      message,
      () => resent++,
    ),
  ).rejects.toBe(forbidden);
  expect(resent).toBe(2);
});
