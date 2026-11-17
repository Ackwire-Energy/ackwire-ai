import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const BODY =
  "Oi, Rita. Obrigado pelo retorno sobre o relatório semanal. Corrigimos o filtro de datas e o painel já mostra a semana certa. Se mais alguma coisa parecer estranha, responda este e-mail que a gente olha na hora.";

/** Two replies to one received email on one card: the first replaced by the second, asked in a later turn. */
function replaced() {
  const state = seedState();
  const [merge] = state.approvals;
  if (!merge) throw new Error("no approval");
  const reply = (id: string, text: string, minutes: number) => ({
    ...merge,
    id,
    tool: "reply_to_received_email",
    scope: "mail:send",
    title: "Mail: reply_to_received_email",
    detail: "reply_to_received_email",
    connector: "mailservice",
    params: {
      email_id: "3f2a9c1e-5b7d-4e8f-a1c2-d3e4f5a6b7c8",
      inbox_id: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
      subject: "Re: Feedback de Rita",
      text,
    },
    createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
  });
  const decidedAt = new Date(Date.now() - 60_000).toISOString();
  state.approvals.splice(
    0,
    1,
    {
      ...reply("ap-old", "Oi, Rita. Obrigado pelo retorno.", 5),
      status: "canceled",
      supersededById: "ap-new",
      decidedAt,
    },
    reply("ap-new", BODY, 1),
  );
  const cardMessage = state.messages.find((m) => m.id === "msg-card");
  if (cardMessage) cardMessage.meta = { ...cardMessage.meta, approvalId: "ap-old" };
  return state;
}

describe("an approval the agent asked for again", () => {
  test("the replaced one is one muted line on the card; the new one reads as the message, its ids only in the details", async () => {
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(replaced()) });
    await settle(4);
    await act(async () => r.sockets.last().open());
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    const old = card.querySelector('.rq__item[data-status="canceled"]') as HTMLElement;
    expect(old.classList.contains("rq__item--replaced")).toBe(true);
    expect(old.querySelector(".rq__wt small")?.textContent).toMatch(/^Substituída pela versão abaixo · \d{2}:\d{2}$/);
    // One line: no values, no message, no buttons.
    expect(old.querySelector(".rq-letter")).toBeNull();
    expect(old.querySelector("button")).toBeNull();
    const fresh = card.querySelector('.rq__item[data-status="pending"]') as HTMLElement;
    const letter = fresh.querySelector(".rq-letter") as HTMLElement;
    expect(letter.querySelector(".rq-letter__subject")?.textContent).toBe("Re: Feedback de Rita");
    expect(letter.querySelector(".rq-letter__to")?.textContent).toBe("Para quem enviou a mensagem");
    expect(letter.querySelector(".rq-letter__body")?.textContent).toBe(BODY);
    // The ids say nothing to a person: not on the card's line.
    expect(fresh.textContent).not.toContain("3f2a9c1e");
    expect(fresh.textContent).not.toContain("Email id");
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });

  test("worst case: an unbreakable subject, long addresses and mixed scripts wrap inside the message", async () => {
    const state = seedState();
    const [merge] = state.approvals;
    if (!merge) throw new Error("no approval");
    state.approvals.splice(0, 1, {
      ...merge,
      tool: "send_email",
      scope: "mail:send",
      title: "Mail: send_email",
      detail: "send_email",
      connector: "mailservice",
      params: {
        to: ["maximiliano.de.albuquerque.vasconcelos.e.silva@subdominio-muito-longo.example.com", "x@example.com"],
        subject: `Atualização_${"A".repeat(90)}`,
        html: `<p>こんにちは 🎉 ${"palavra ".repeat(80)}</p>`,
      },
    });
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    await act(async () => r.sockets.last().open());
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    const preview = card.querySelector(".rq-mail") as HTMLElement;
    expect(preview.querySelector(".rq-mail__to")?.textContent).toStartWith("Para maximiliano.");
    // The markup is not the message: its words are.
    expect(preview.querySelector(".rq-mail__body")?.textContent).toStartWith("こんにちは 🎉 palavra");
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });
});
