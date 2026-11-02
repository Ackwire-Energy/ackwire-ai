import { afterEach, expect, test } from "bun:test";
import { ApiError, type ArtifactDetail } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { ChoicesCard } from "@/components/blocks/ChoicesCard";
import { ADA_ID, createFakeApi } from "./fake-api";
import { renderPage, settle } from "./render";

afterEach(cleanup);

const QUESTIONS = [
  { question: "Quando?", options: [{ label: "Hoje" }, { label: "Amanhã" }] },
  { question: "Quem revisa?", options: [{ label: "Lia" }, { label: "Theo" }] },
];

async function card(questions = QUESTIONS, answer?: () => Promise<never>) {
  const api = createFakeApi();
  api.artifacts.get = async (_orgId, id) =>
    ({
      id,
      title: "Revisão",
      kind: "choices",
      createdBy: { type: "agent", id: ADA_ID },
      shownVersion: 1,
      content: { kind: "choices", questions },
    }) as unknown as ArtifactDetail;
  if (answer) api.artifacts.answerChoices = answer;
  await renderPage(<ChoicesCard id="card-1" />, { api, org: true });
  await settle(6);
}

const focused = () => document.activeElement as HTMLElement;
const key = async (k: string) => {
  await act(async () => fireEvent.keyDown(focused(), { key: k }));
  await settle(4);
};

test("Left and Right keep the focus on the card's options, so letter keys keep answering", async () => {
  await card();
  (document.querySelector(".choices__option") as HTMLElement).focus();
  await key("a");
  expect(focused().textContent).toContain("Lia");
  await key("ArrowLeft");
  expect(focused().className).toContain("choices__option");
  expect(focused().textContent).toContain("Hoje");
  await key("ArrowRight");
  expect(focused().textContent).toContain("Lia");
});

test("someone answering first is no failure: no 'try again'; another error still says it", async () => {
  const one = [QUESTIONS[0] as (typeof QUESTIONS)[number]];
  await card(one, async () => {
    throw new ApiError(409, "choices.answered", "This card was already answered");
  });
  await act(async () => fireEvent.click(document.querySelector(".choices__option") as HTMLElement));
  await settle(6);
  expect(document.querySelector(".ac-toast")?.textContent ?? null).toBeNull();
  cleanup();
  await card(one, async () => {
    throw new ApiError(500, "internal", "boom");
  });
  await act(async () => fireEvent.click(document.querySelector(".choices__option") as HTMLElement));
  await settle(6);
  const toasts = [...document.querySelectorAll(".ac-toast")].map((t) => t.textContent);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain("Não deu para mandar sua escolha");
});
