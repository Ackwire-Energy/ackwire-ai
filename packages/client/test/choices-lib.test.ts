import { expect, test } from "bun:test";
import { ApiError } from "../src/api/http";
import {
  answeredFirst,
  choiceLetter,
  choiceOfKey,
  choiceReplyLine,
  choiceSummary,
  emptyDraft,
  moveStep,
  pickChoice,
} from "../src/lib/choices";

const Q = [
  { question: "Quando?", options: [{ label: "Hoje" }, { label: "Amanhã" }] },
  { question: "Quem revisa?", options: [{ label: "Ana" }, { label: "Theo" }, { label: "Ninguém" }] },
];

test("options are lettered, and a letter key picks one of them", () => {
  expect([0, 1, 5].map(choiceLetter)).toEqual(["A", "B", "F"]);
  expect(choiceOfKey("b", 3)).toBe(1);
  expect(choiceOfKey("C", 3)).toBe(2);
  expect(choiceOfKey("d", 3)).toBeNull();
  expect(choiceOfKey("Enter", 3)).toBeNull();
});

test("one question answers on the first pick", () => {
  expect(pickChoice(emptyDraft([Q[0] as (typeof Q)[0]]), 1).send).toEqual([1]);
});

test("several: each pick moves on, Back and Next walk them, and the last open one sends them all", () => {
  let d = emptyDraft(Q);
  expect(moveStep(d, 1)).toBe(d);
  const first = pickChoice(d, 0);
  expect(first).toEqual({ draft: { step: 1, picks: [0, null] }, send: null });
  d = moveStep(first.draft, -1);
  expect(d.step).toBe(0);
  const changed = pickChoice(d, 1);
  expect(changed).toEqual({ draft: { step: 1, picks: [1, null] }, send: null });
  expect(pickChoice(changed.draft, 2).send).toEqual([1, 2]);
});

test("the answered card and the compact reply", () => {
  expect(choiceSummary(Q, [1, 0])).toEqual([
    { question: "Quando?", letter: "B", label: "Amanhã" },
    { question: "Quem revisa?", letter: "A", label: "Ana" },
  ]);
  expect(choiceReplyLine("@dev Amanhã")).toBe("Amanhã");
  expect(choiceReplyLine("Amanhã")).toBe("Amanhã");
});

test("someone answering first is told apart from a failed pick", () => {
  expect(answeredFirst(new ApiError(409, "choices.answered", "x"))).toBe(true);
  expect(answeredFirst(new ApiError(500, "internal", "x"))).toBe(false);
  expect(answeredFirst(new Error("offline"))).toBe(false);
});
