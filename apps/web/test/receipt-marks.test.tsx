import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Message, steerStore } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, NOW, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  steerStore.reset();
});

const DM_ID = "00000000-0000-4000-8000-0000000000d1";
/** A person's message, `minutes` before now. */
const said = (id: string, body: string, minutes: number, over: Partial<Message> = {}) =>
  ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: "u-walter" },
    body,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
    ...over,
  }) as Message;
const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;
/** What a row lays out in its text's column: everything but what only screen readers get. */
const parts = (id: string) =>
  [...(row(id).querySelector(".ac-msg__body")?.children ?? [])]
    .filter((part) => !part.classList.contains("ac-visually-hidden"))
    .map((part) => part.className);

describe("a receipt never changes a message's height", () => {
  test("sent into a task at work: the mark where the check goes, the same parts as a message without it", async () => {
    const state = seedState();
    const answering = {
      seenBy: [ADA_ID],
      pickedBy: [],
      handled: [{ agentId: ADA_ID, runId: "r1", status: "running" as const }],
    };
    state.messages = [
      said("s1", "Corrige o login.", 30, { receipts: answering }),
      said("s2", "Olha também o refresh.", 29.5, { receipts: answering }),
      said("p1", "Bom dia.", 20),
      said("p2", "Sobre a reunião.", 19.5),
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const steered = (messageId: string) => ({
      type: "agent.run.steered",
      channelId: ENG_ID,
      runId: "r1",
      agentId: ADA_ID,
      messageId,
    });
    await act(async () => {
      steerStore.apply(steered("s1"));
      steerStore.apply(steered("s2"));
      steerStore.apply({ type: "agent.run.read", channelId: ENG_ID, runId: "r1", agentId: ADA_ID, messageIds: ["s2"] });
    });
    await settle(4);
    expect(row("s2").className).toContain("ac-msg--grouped");
    // Waiting for the next pause: the spinner at the end of the name's line.
    const waiting = row("s1").querySelector(".ac-msg__head .ac-msg__aside .ac-receipt__check");
    expect(waiting?.getAttribute("data-steer")).toBe("waiting");
    expect(waiting?.querySelector("canvas.ac-pixspin")).not.toBeNull();
    // Read: Ada's face at the end of the grouped message's first line, which wraps before it.
    const read = row("s2").querySelector(".ac-msg__aside--floating .ac-receipt__check");
    expect(read?.getAttribute("data-steer")).toBe("read");
    expect(read?.querySelector(".ac-avatar")).not.toBeNull();
    // Nothing under the text: the same parts as the messages beside them that no task read.
    expect(parts("s1")).toEqual(parts("p1"));
    expect(parts("s2")).toEqual(parts("p2"));
    expect(document.querySelector(".msg-steer")).toBeNull();
  });

  test("in a DM between people, who read my latest message is their face where its check goes", async () => {
    const state = seedState();
    state.dms = [{ channelId: DM_ID, with: { type: "person", id: "u-joao", name: "João", handle: null } }];
    state.channelMembers[DM_ID] = [
      { type: "person", id: "u-walter" },
      { type: "person", id: "u-joao" },
    ];
    state.messages = [
      said("d1", "Oi, João.", 3, { channelId: DM_ID }),
      said("d2", "Viu o relatório?", 2.5, { channelId: DM_ID }),
      said("d3", "Está no Drive.", 2, { channelId: DM_ID }),
    ];
    const api = createFakeApi(state);
    api.dms.reads = async () => [{ userId: "u-joao", lastReadAt: NOW.toISOString() }];
    await renderApp(`/org/${ORG_ID}/dm/person/u-joao`, { api });
    await settle(8);
    const seen = row("d3").querySelector(".ac-msg__aside--floating .ac-receipt__seen");
    expect(seen?.querySelector(".ac-avatar")).not.toBeNull();
    expect(row("d2").querySelector(".ac-receipt__seen")).toBeNull();
    // No line after it: the row ends the list as the one before it ends its own.
    expect(parts("d3")).toEqual(parts("d2"));
    expect(screen().queryByText("Visto")).toBeNull();
    expect(document.querySelector(".channel__seen")).toBeNull();
  });

  test("the face keeps the check's width and the name's line, and no stylesheet gives a receipt a line", () => {
    const css = (path: string) => readFileSync(join(import.meta.dir, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const kit = css("../../../packages/ui/src/styles/components.css");
    const app = css("../src/layout.css");
    const value = (sheet: string, selector: string, prop: string) =>
      [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => (m[1] ?? "").split(",").some((s) => s.trim() === selector))
        .map((m) => new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(m[2] ?? "")?.[1]?.trim())
        .findLast(Boolean);
    const px = (v: string | undefined) => Number.parseFloat(v ?? "");
    // The check: a 16px icon with 2px each side, which the action bar stands 8px left of.
    const check = px(value(kit, ".ac-receipt__check .ac-icon", "width")) + 2 * 2;
    expect(value(kit, ".ac-receipt__check", "padding")).toBe("0 2px");
    expect(
      value(kit, ".ac-msg:has(> .ac-msg__body .ac-msg__aside:not(:empty)) > .ac-msg__body > .ac-msg__actions", "right"),
    ).toBe(`calc(var(--msg-inline) + ${check + 8}px)`);
    // The reader's face (18px) with 1px each side: the same 20px, and no taller than the name's line.
    const face = px(value(kit, ".ac-avatar--xs", "width"));
    for (const selector of [".ac-receipt__check:has(> .ac-avatar)", ".ac-receipt__seen"]) {
      expect(value(app, selector, "padding")).toBe("0 1px");
    }
    expect(face + 2 * 1).toBe(check);
    expect(px(value(kit, ".ac-avatar--xs", "height"))).toBeLessThanOrEqual(
      px(value(kit, ".ac-msg__head", "line-height")),
    );
    // The mark ends the first line: in the name's line, or floated on a grouped message's text.
    expect(value(kit, ".ac-msg__head > .ac-msg__aside", "align-self")).toBe("center");
    expect(value(kit, ".ac-msg__aside--floating", "float")).toBe("right");
    // No line of words under a message, nor a row after it, for a receipt.
    const src = join(import.meta.dir, "../src");
    const sheets = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? sheets(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : [],
      );
    const all = sheets(src)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(all).not.toMatch(/\.(msg-steer|channel__seen)\b/);
  });
});

describe("its words stay reachable", () => {
  test("screen readers hear what became of it as it changes; the mark is named and opens the words", async () => {
    const state = seedState();
    state.messages = [
      said("s1", "Olha também o refresh.", 2, {
        receipts: {
          seenBy: [ADA_ID],
          pickedBy: [],
          handled: [{ agentId: ADA_ID, runId: "r1", status: "running" }],
        },
      }),
      said("s2", "E o logout.", 30, { author: { type: "person", id: "u-joao" } }),
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    await act(async () => {
      steerStore.apply({ type: "agent.run.steered", channelId: ENG_ID, runId: "r1", agentId: ADA_ID, messageId: "s1" });
      steerStore.apply({ type: "agent.run.steered", channelId: ENG_ID, runId: "r2", agentId: ADA_ID, messageId: "s2" });
    });
    await settle(4);
    const check = row("s1").querySelector(".ac-receipt__check") as HTMLElement;
    const live = row("s1").querySelector(".ac-msg__aside .ac-visually-hidden[aria-live='polite']") as HTMLElement;
    expect(live.textContent).toBe("Ada lê na próxima pausa");
    // The agents' words name the mark; what became of it in the task describes it.
    expect(check.getAttribute("aria-label")).toBe("Vista por Ada. Ada está respondendo");
    expect(check.getAttribute("aria-describedby")).toBe(live.id);
    await act(async () => {
      steerStore.apply({ type: "agent.run.read", channelId: ENG_ID, runId: "r1", agentId: ADA_ID, messageIds: ["s1"] });
    });
    await settle(2);
    expect(live.textContent).toBe("Ada leu");
    // A message no agent was asked about: the words name the mark itself.
    const alone = row("s2").querySelector(".ac-receipt__check") as HTMLElement;
    expect(alone.getAttribute("aria-label")).toBe("Ada lê na próxima pausa");
    expect(alone.hasAttribute("aria-describedby")).toBe(false);
    // From the keyboard too: a button that opens the agents and, under them, what became of it.
    expect(check.tagName).toBe("BUTTON");
    await act(async () => fireEvent.click(check));
    await settle(2);
    const popover = screen().getByRole("dialog", { name: "Agentes" });
    expect(within(popover).getByText("Respondendo")).toBeTruthy();
    expect(popover.querySelector(".who-by")?.textContent).toBe("Ada leu");
  });

  test("in a DM, who read it is said to screen readers and on hover", async () => {
    const state = seedState();
    state.dms = [{ channelId: DM_ID, with: { type: "person", id: "u-joao", name: "João", handle: null } }];
    state.channelMembers[DM_ID] = [
      { type: "person", id: "u-walter" },
      { type: "person", id: "u-joao" },
    ];
    state.messages = [said("d1", "Viu o relatório?", 2, { channelId: DM_ID })];
    const api = createFakeApi(state);
    api.dms.reads = async () => [{ userId: "u-joao", lastReadAt: NOW.toISOString() }];
    await renderApp(`/org/${ORG_ID}/dm/person/u-joao`, { api });
    await settle(8);
    const seen = row("d1").querySelector(".ac-msg__head .ac-msg__aside .ac-receipt__seen") as HTMLElement;
    expect(seen.getAttribute("title")).toBe("Vista por João");
    expect(seen.querySelector(".ac-visually-hidden[aria-live='polite']")?.textContent).toBe("Vista por João");
    expect(seen.querySelector(".ac-avatar")?.getAttribute("aria-hidden")).toBe("true");
  });
});
