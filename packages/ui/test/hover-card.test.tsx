import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { HOVER_CLOSE_MS, Popover, useHoverCard } from "../src";
import { box, mouse, place, step, tick } from "../testing";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const OPEN_MS = 400;
const body = () => within(document.body);
const trigger = (name: string) => body().getByRole("button", { name });
const card = (name: string) => body().queryByRole("dialog", { name: `Cartão de ${name}` });
const open = () =>
  body()
    .queryAllByRole("dialog")
    .map((d) => d.getAttribute("aria-label"));

const { enter, leave, move } = mouse;

function Hover({ name, children }: { name: string; children?: ReactNode }) {
  const hover = useHoverCard(OPEN_MS);
  return (
    <Popover hover={hover} label={`Cartão de ${name}`} side="bottom" trigger={<button type="button">{name}</button>}>
      {hover.open && (children ?? <p>Sobre {name}</p>)}
    </Popover>
  );
}

/*
 * Ada's name at 100,100 (60×20), her card 6 px under it (280×200, from 100,126 to 380,326). Theo's name further
 * right on the same line; Mel's mention chip right of Ada's name, over the way from Ada's name to the far side of
 * her card.
 */
const ADA = box(100, 100, 60, 20);
const ADA_CARD = box(100, 126, 280, 200);
const THEO = box(300, 100, 60, 20);
const MEL = box(200, 112, 40, 12);

function Line() {
  return (
    <div data-testid="list">
      <Hover name="Ada" />
      <Hover name="Theo" />
      <Hover name="Mel" />
    </div>
  );
}

/** Renders the line and opens Ada's card with the pointer resting on her name. */
async function openAda() {
  render(<Line />);
  place(trigger("Ada"), ADA);
  place(trigger("Theo"), THEO);
  place(trigger("Mel"), MEL);
  await enter(trigger("Ada"), 130, 110);
  await tick(OPEN_MS);
  place(card("Ada"), ADA_CARD);
  expect(open()).toEqual(["Cartão de Ada"]);
}

describe("a card that opens on hover", () => {
  test("opens after the delay; a touch never opens it", async () => {
    render(<Line />);
    await step(() => fireEvent.pointerEnter(trigger("Ada"), { pointerType: "touch" }));
    await tick(OPEN_MS * 2);
    expect(open()).toEqual([]);
    await step(() => fireEvent.pointerLeave(trigger("Ada"), { pointerType: "touch" }));
    await enter(trigger("Ada"), 130, 110);
    await tick(OPEN_MS - 1);
    expect(open()).toEqual([]);
    await tick(1);
    expect(open()).toEqual(["Cartão de Ada"]);
  });

  test("on its way to the card the pointer may take longer than the close delay and cross other things", async () => {
    await openAda();
    // Out of the name's right side, toward the far end of the card, over the text beside the name.
    await leave(trigger("Ada"), 160, 110);
    await move(document.body, 190, 114);
    await tick(HOVER_CLOSE_MS - 50);
    await move(document.body, 240, 120);
    await tick(HOVER_CLOSE_MS - 50);
    await move(document.body, 300, 124);
    await tick(HOVER_CLOSE_MS - 50);
    expect(open()).toEqual(["Cartão de Ada"]);
    await enter(card("Ada") as HTMLElement, 320, 140);
    await tick(HOVER_CLOSE_MS * 5);
    expect(open()).toEqual(["Cartão de Ada"]);
  });

  test("the gap between the name and the card never closes it", async () => {
    await openAda();
    await leave(trigger("Ada"), 130, 120);
    await move(document.body, 130, 123);
    await tick(HOVER_CLOSE_MS * 5);
    expect(open()).toEqual(["Cartão de Ada"]);
  });

  test("a brief exit from the name or the card, and back, keeps it open", async () => {
    await openAda();
    await leave(trigger("Ada"), 130, 100);
    await move(document.body, 130, 90);
    await tick(HOVER_CLOSE_MS - 100);
    await enter(trigger("Ada"), 130, 101);
    await tick(HOVER_CLOSE_MS * 2);
    expect(open()).toEqual(["Cartão de Ada"]);
    const ada = card("Ada") as HTMLElement;
    await enter(ada, 200, 200);
    await leave(ada, 381, 200);
    await move(document.body, 390, 200);
    await tick(HOVER_CLOSE_MS - 100);
    await enter(ada, 379, 200);
    await tick(HOVER_CLOSE_MS * 2);
    expect(open()).toEqual(["Cartão de Ada"]);
  });

  test("settling elsewhere closes it, the close delay after the pointer left, and resting on the way too", async () => {
    await openAda();
    await leave(trigger("Ada"), 130, 100);
    await move(document.body, 130, 80);
    await tick(HOVER_CLOSE_MS - 1);
    expect(open()).toEqual(["Cartão de Ada"]);
    await tick(1);
    expect(open()).toEqual([]);
    cleanup();
    await openAda();
    await leave(trigger("Ada"), 160, 110);
    await move(document.body, 190, 114);
    await tick(HOVER_CLOSE_MS);
    expect(open()).toEqual([]);
  });

  test("another trigger switches cards at once: never two", async () => {
    await openAda();
    // Along the line to Theo, away from Ada's card.
    await leave(trigger("Ada"), 160, 102);
    await move(document.body, 230, 102);
    await enter(trigger("Theo"), 300, 104);
    expect(open()).toEqual(["Cartão de Theo"]);
    await leave(trigger("Theo"), 300, 104);
    await enter(trigger("Ada"), 159, 104);
    expect(open()).toEqual(["Cartão de Ada"]);
  });

  test("a trigger crossed on the way to a card doesn't take over; one the pointer rests on does", async () => {
    await openAda();
    await leave(trigger("Ada"), 160, 110);
    await enter(trigger("Mel"), 205, 115);
    await move(trigger("Mel"), 215, 117);
    await tick(200);
    await move(trigger("Mel"), 230, 119);
    await tick(200);
    await leave(trigger("Mel"), 240, 120);
    await move(document.body, 280, 123);
    await enter(card("Ada") as HTMLElement, 300, 130);
    await tick(OPEN_MS * 2);
    expect(open()).toEqual(["Cartão de Ada"]);
    cleanup();
    await openAda();
    await leave(trigger("Ada"), 160, 110);
    await enter(trigger("Mel"), 205, 115);
    await move(trigger("Mel"), 210, 116);
    // Resting on Mel: Ada's card goes, then Mel's opens.
    await tick(HOVER_CLOSE_MS);
    expect(open()).toEqual([]);
    await tick(OPEN_MS - HOVER_CLOSE_MS);
    expect(open()).toEqual(["Cartão de Mel"]);
  });

  test("a scroll that takes the trigger from under the pointer closes it; one inside the card, or elsewhere, doesn't", async () => {
    await openAda();
    const list = body().getByTestId("list");
    // The box someone types in scrolls as they type.
    const typing = document.createElement("textarea");
    document.body.append(typing);
    await step(() => fireEvent.scroll(typing));
    expect(open()).toEqual(["Cartão de Ada"]);
    typing.remove();
    // The list scrolls a little: the name is still under the pointer.
    place(trigger("Ada"), box(100, 95, 60, 20));
    await step(() => fireEvent.scroll(list));
    expect(open()).toEqual(["Cartão de Ada"]);
    // On the card, which scrolls its own contents.
    const ada = card("Ada") as HTMLElement;
    await leave(trigger("Ada"), 130, 115, ada);
    await enter(ada, 200, 200);
    await step(() => fireEvent.scroll(within(ada).getByText("Sobre Ada")));
    expect(open()).toEqual(["Cartão de Ada"]);
    await leave(ada, 130, 125, trigger("Ada"));
    await enter(trigger("Ada"), 130, 110);
    // The list scrolls the name away (the card follows it a frame later).
    place(trigger("Ada"), box(100, 40, 60, 20));
    await step(() => fireEvent.scroll(list));
    expect(open()).toEqual([]);
  });

  test("a card inside a card opens beside it, and the outer one stays while the pointer goes to the inner one", async () => {
    render(
      <Hover name="Equipe">
        <Hover name="Ada" />
      </Hover>,
    );
    place(trigger("Equipe"), box(100, 40, 60, 20));
    await enter(trigger("Equipe"), 130, 50);
    await tick(OPEN_MS);
    const team = card("Equipe") as HTMLElement;
    place(team, box(100, 66, 200, 120));
    await leave(trigger("Equipe"), 130, 60, team);
    await enter(team, 130, 70);
    // Ada's row in the list; her card opens past the list's right edge.
    place(trigger("Ada"), box(110, 80, 180, 20));
    await enter(trigger("Ada"), 130, 90);
    await tick(OPEN_MS);
    expect(open()).toEqual(["Cartão de Equipe", "Cartão de Ada"]);
    const ada = card("Ada") as HTMLElement;
    place(ada, box(310, 70, 200, 200));
    // Out of the row's end over the list, then out of the list, toward her card's lower part.
    await leave(trigger("Ada"), 290, 95, team);
    await move(team, 295, 110);
    await tick(HOVER_CLOSE_MS - 50);
    await leave(team, 301, 120);
    await move(document.body, 305, 125);
    await tick(HOVER_CLOSE_MS - 50);
    expect(open()).toEqual(["Cartão de Equipe", "Cartão de Ada"]);
    await enter(ada, 320, 130);
    await tick(HOVER_CLOSE_MS * 3);
    expect(open()).toEqual(["Cartão de Equipe", "Cartão de Ada"]);
    // Out of both: both go.
    await leave(ada, 600, 130);
    await move(document.body, 650, 130);
    await tick(HOVER_CLOSE_MS);
    expect(open()).toEqual([]);
  });

  test("a card a press opened stays when the pointer leaves, and hover opens no other one over it, until Esc", async () => {
    render(<Line />);
    place(trigger("Ada"), ADA);
    place(trigger("Theo"), THEO);
    await enter(trigger("Ada"), 130, 110);
    await step(() => fireEvent.click(trigger("Ada")));
    expect(open()).toEqual(["Cartão de Ada"]);
    await leave(trigger("Ada"), 130, 80);
    await move(document.body, 130, 60);
    await tick(HOVER_CLOSE_MS * 3);
    expect(open()).toEqual(["Cartão de Ada"]);
    await enter(trigger("Theo"), 330, 110);
    await tick(OPEN_MS * 2);
    expect(open()).toEqual(["Cartão de Ada"]);
    await step(() => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    expect(open()).toEqual([]);
  });

  test("inside a card a press opened, hover still opens the cards in it", async () => {
    render(
      <Hover name="Equipe">
        <Hover name="Ada" />
      </Hover>,
    );
    await step(() => fireEvent.click(trigger("Equipe")));
    await enter(trigger("Ada"), 130, 90);
    await tick(OPEN_MS);
    expect(open()).toEqual(["Cartão de Equipe", "Cartão de Ada"]);
  });
});
