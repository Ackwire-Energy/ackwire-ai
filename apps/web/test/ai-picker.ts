import { act, fireEvent, within } from "@testing-library/react";
import { screen, settle } from "./render";

/** Whose plan or whose key, in an open Connect an AI: the picker's select. */
export const aiSelect = (box: HTMLElement, name: "Plano" | "Provedor" | "Quem pensa" = "Plano") =>
  within(box).getByRole("combobox", { name });

/** That select opened: its rows. */
export async function openAiSelect(box: HTMLElement, name: "Plano" | "Provedor" | "Quem pensa" = "Plano") {
  const select = aiSelect(box, name);
  select.focus();
  await act(async () => fireEvent.keyDown(select, { key: "Enter" }));
  await settle(3);
  return screen().getAllByRole("option");
}

export const closeAiSelect = async () => {
  await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
  await settle(2);
};

export const payWith = (box: HTMLElement, name: "Com um plano" | "Com chave de API") =>
  within(box).getByRole("radio", { name });

const clicked = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

/** Picks what the old tiles offered: "Chave de API", else a plan by its name, or `maker` the key's maker. */
export async function chooseAi(box: HTMLElement, name: string, maker = false) {
  if (name === "Chave de API") return clicked(payWith(box, "Com chave de API"));
  if (!maker && within(box).queryByRole("combobox", { name: "Plano" }) === null)
    await clicked(payWith(box, "Com um plano"));
  const rows = await openAiSelect(box, maker ? "Provedor" : "Plano");
  const row = rows.find((o) => o.textContent === name || o.textContent?.startsWith(`${name}`)) as Element;
  await clicked(row);
}

/** A row of "Quem pensa"'s select by the title it shows. */
export const brainTitle = (option: Element) =>
  option.querySelector(".ac-menu__label > span:first-child")?.textContent ?? "";

/** Picks what thinks in "Quem pensa". */
export async function chooseBrain(box: HTMLElement, name: RegExp) {
  const rows = await openAiSelect(box, "Quem pensa");
  await clicked(rows.find((o) => name.test(brainTitle(o))) as Element);
}
