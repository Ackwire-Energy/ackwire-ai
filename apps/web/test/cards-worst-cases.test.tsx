import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

// The geometry check lays these screens out at 1280, 390 and 320: what a request card must survive.
const LONG_ADDRESS = "financeiro.contas-a-receber.filial-norte-sul-leste@comercial-distribuidora.example.com";
const LONG_VALUE =
  "Seu reembolso do pedido 4821 foi aprovado hoje e cai na conta cadastrada em até cinco dias úteis, sem custo.";

/** The seed's request in #eng at its worst: an address that never breaks on its own, code in its why, a long value. */
function worst(status: "pending" | "approved") {
  const state = seedState();
  const first = state.approvals[0];
  if (!first) throw new Error("no approval");
  Object.assign(first, {
    why: "Rodei `bun test apps/web/test/request-card.test.tsx` e o deploy precisa de **aprovação** antes de `main`.",
    detail: `send_email · to=${LONG_ADDRESS}`,
    params: { to: LONG_ADDRESS, body: LONG_VALUE },
    ...(status === "pending"
      ? {}
      : {
          status: "approved",
          canDecide: false,
          canCancel: true,
          runAt: new Date(Date.now() + 26 * 3_600_000).toISOString(),
          decidedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
          decidedByUserId: "u-joao",
        }),
  });
  return state;
}

describe("a request card at its worst", () => {
  test("its why draws code as code, Ver detalhes under its words, a long value on a row of its own", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(worst("pending")) });
    await settle(4);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.querySelector(".rq__lead code.ac-inlinecode")?.textContent).toBe(
      "bun test apps/web/test/request-card.test.tsx",
    );
    expect(card.querySelector(".rq__lead strong")?.textContent).toBe("aprovação");
    const more = card.querySelector(".rq__wt > .rq__more") as HTMLElement;
    expect(more).toBeTruthy();
    await act(async () => fireEvent.click(more));
    await settle(3);
    const rows = [...card.querySelectorAll(".ap-exact__rows > div")] as HTMLElement[];
    expect(rows.find((r) => r.textContent?.includes(LONG_VALUE))?.hasAttribute("data-long")).toBe(true);
  });

  test("approved ahead: when it runs is a quiet line under the pill, never the pill's time", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(worst("approved")) });
    await settle(4);
    const pill = screen().getByRole("group", { name: "Aprovação concluída" });
    expect(pill.querySelector(".rq-done__note")?.textContent).toMatch(/^Agendado para /);
    expect(pill.querySelector(".ac-eventpill__time")?.textContent).not.toMatch(/Agendado/);
    expect(within(pill).getByRole("button", { name: "Cancelar" })).toBeTruthy();
  });
});
