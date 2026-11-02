import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent, ComputerQueue, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { builtCss, declarations } from "./built-css";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const NOVA_ID = "00000000-0000-4000-8000-0000000000a7";
const RIO_ID = "00000000-0000-4000-8000-0000000000a8";
const in_ = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const click = (el: Element) => act(async () => fireEvent.click(el));
const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;

function setup() {
  const state = seedState();
  const me = state.me?.user.id ?? "";
  const base = state.agents[0] as Agent;
  state.agents.push(
    { ...base, id: NOVA_ID, name: "Nova", handle: "nova" },
    { ...base, id: RIO_ID, name: "Rio", handle: "rio" },
  );
  state.channelMembers[ENG_ID]?.push({ type: "agent", id: NOVA_ID }, { type: "agent", id: RIO_ID });
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api);
  const studio = machines?.pair({
    name: "Studio",
    agents: [ADA_ID, ATLAS_ID, NOVA_ID, RIO_ID].map((id) => ({ id, name: id, handle: id })),
  });
  const machineId = studio?.id ?? "";
  const where = { channelId: ENG_ID, threadId: null };
  const queue: ComputerQueue = {
    machineId,
    name: "Studio",
    working: [
      {
        runId: "r-ada",
        agentId: ADA_ID,
        purpose: { kind: "agent", agentId: NOVA_ID },
        where,
        startedAt: in_(-6),
        estimatedEndAt: in_(2),
      },
    ],
    waiting: [
      {
        runId: "r-atlas",
        agentId: ATLAS_ID,
        purpose: { kind: "person", userId: me },
        where,
        people: true,
        position: 1,
        estimatedStartAt: in_(2),
        after: [ADA_ID],
      },
      {
        runId: "r-rio",
        agentId: RIO_ID,
        purpose: { kind: "agent", agentId: NOVA_ID },
        where,
        people: false,
        position: 2,
        estimatedStartAt: null,
        after: [ATLAS_ID],
      },
    ],
  };
  machines?.setQueue(queue);
  return { state, api, me };
}

const said = (over: Partial<Message>) =>
  ({
    id: "m-ask",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: "u-joao" },
    body: "@atlas olha o deploy",
    mentionedAgentIds: [ATLAS_ID],
    agentRunId: null,
    meta: {},
    createdAt: new Date().toISOString(),
    ...over,
  }) as Message;

describe("a computer's line", () => {
  test("the header says who waits and opens the line in place: working now, in line, my request first", async () => {
    const { api } = setup();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const button = screen().getByRole("button", { name: "Computador · 2 aguardando" });
    await click(button);
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Fila de Studio" });
    const text = dialog.textContent ?? "";
    expect(text).toContain("Cheio · o próximo começa em cerca de 2 min");
    expect(text).toContain("Trabalhando agora · 1");
    expect(text).toContain("a pedido de Nova · #eng · 6 min");
    expect(text).toContain("faltam ~2 min");
    expect(text).toContain("Na fila · 2");
    expect(text).toContain("respondendo você · #eng");
    expect(text).toContain("começa em ~2 min");
    // No estimate behind the head: no time, never a made-up one.
    const rows = within(dialog).getAllByRole("listitem");
    expect(rows.at(-1)?.textContent).not.toContain("~");
    const mine = rows.find((r) => r.hasAttribute("data-mine"));
    expect(mine?.textContent).toContain("Você vai primeiro");
    expect(mine?.textContent).toContain("Atlas");
    expect(text).toContain("Pessoas vão primeiro.");
  });

  test("the waiting agent's row under my message says where it is in line, and See queue opens the line", async () => {
    const { api, state, me } = setup();
    state.messages.push(
      said({
        author: { type: "person", id: me },
        receipts: {
          seenBy: [ATLAS_ID],
          pickedBy: [ATLAS_ID],
          handled: [{ agentId: ATLAS_ID, runId: "r-atlas", status: "waiting_input", computer: "queued" }],
          blocked: [],
        },
      }),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const foot = row("m-ask").querySelector(".ac-msg__foot") as HTMLElement;
    expect(foot.textContent).toContain("Atlas · Aguardando o computador. É o próximo, em cerca de 2 min");
    expect(foot.textContent).toContain("Você vai primeiro");
    expect(foot.textContent).not.toContain("está na fila do computador");
    await click(within(foot).getByRole("button", { name: "Ver fila" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Fila de Studio" })).toBeTruthy();
  });

  test("an agent further back names who is ahead", async () => {
    const { api, state } = setup();
    state.messages.push(
      said({
        body: "@rio confere",
        mentionedAgentIds: [RIO_ID],
        receipts: {
          seenBy: [RIO_ID],
          pickedBy: [RIO_ID],
          handled: [{ agentId: RIO_ID, runId: "r-rio", status: "waiting_input", computer: "queued" }],
          blocked: [],
        },
      }),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const foot = row("m-ask").querySelector(".ac-msg__foot") as HTMLElement;
    expect(foot.textContent).toContain("Rio · Na fila, 2º. Depois de Atlas");
    expect(foot.textContent).not.toContain("Você vai primeiro");
  });

  test("a message that called several agents gets one strip: each agent's state, live", async () => {
    const { api, state } = setup();
    state.messages.push(
      said({
        author: { type: "agent", id: NOVA_ID },
        body: "@ada @atlas @rio cada um olha uma parte",
        mentionedAgentIds: [ADA_ID, ATLAS_ID, RIO_ID],
        agentRunId: "r-nova",
        receipts: {
          seenBy: [ADA_ID, ATLAS_ID, RIO_ID],
          pickedBy: [],
          handled: [
            { agentId: ADA_ID, runId: "r-ada", status: "running" },
            { agentId: ATLAS_ID, runId: "r-atlas", status: "waiting_input", computer: "queued" },
            { agentId: RIO_ID, runId: "r-rio", status: "waiting_input", computer: "queued" },
          ],
          blocked: [],
        },
      }),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const strip = row("m-ask").querySelector(".cq-fan") as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.textContent).toContain("3 agentes chamados · 1 trabalhando · 2 na fila");
    const chips = [...strip.querySelectorAll(".cq-fan__chip")].map((c) => c.textContent);
    expect(chips).toEqual(["Ada trabalhando", "Atlas 1º", "Rio 2º"]);
    // One strip, no line per agent in line.
    expect(row("m-ask").querySelector(".cq-live")).toBeNull();
    expect(within(strip).getByRole("button", { name: "Ver fila" })).toBeTruthy();
  });
});

describe("an offline computer's note", () => {
  test("the time away is a pill on the author line, not in the card's text", async () => {
    const { api, state } = setup();
    const machineId = fakeMachinesOf.get(api)?.all()[0]?.id ?? "";
    fakeMachinesOf.get(api)?.setOutages({
      outages: [
        {
          machineId,
          name: "Studio",
          platform: "linux",
          offlineSince: new Date(Date.now() - 3 * 60_000).toISOString(),
          agents: [{ agentId: ADA_ID, name: "Ada", brain: "claude_code", waiting: { routines: 0, conversations: 1 } }],
          waitingRuns: 1,
        },
      ],
      targets: [],
    });
    state.messages.push(
      said({
        id: "m-wait",
        author: { type: "agent", id: ADA_ID },
        body: "Claude Code is offline.",
        mentionedAgentIds: [],
        meta: {
          bodyCode: "brain_unavailable",
          bodyParams: { brain: "Claude Code" },
          brainUnavailable: { brain: "claude_code", code: "machine_offline", machineId, agentId: ADA_ID },
        },
      }),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const pill = row("m-wait").querySelector(".ac-msg__head .cq-away");
    expect(pill?.textContent).toBe("Fora há 3 min");
    expect(row("m-wait").querySelector(".waitcard")?.textContent).not.toContain("3 min");
  });
});

test("pills never wrap; a closed answer shows two lines at most", async () => {
  const css = await builtCss("src/styles.css", "src/components/computer-queue.css");
  const value = (selector: string, property: string) =>
    declarations(css, selector).findLast(([p]) => p === property)?.[1];
  expect(value(".ac-chip", "white-space")).toBe("nowrap");
  expect(value(".cq-link", "white-space")).toBe("nowrap");
  expect(value(".ac-consult-group .ac-tools__label small", "-webkit-line-clamp")).toBe("2");
  expect(value('.ac-consult-group .ac-tools__row[aria-expanded="true"] .ac-tools__label small', "display")).toBe(
    "none",
  );
});
