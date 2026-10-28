import { act, fireEvent, within } from "@testing-library/react";
import { screen } from "./render";

/** A service opened from "Adicionar conector": its dialog over the catalog, named after it. */
export const service = (name: string) => screen().getByRole("dialog", { name });

/** Picks a service in "Adicionar conector" (its tile or suggestion) and presses Conectar in its dialog. */
export async function pick(catalog: HTMLElement, name: string) {
  await act(async () => fireEvent.click(within(catalog).getByRole("button", { name })));
  await act(async () => fireEvent.click(within(service(name)).getByRole("button", { name: `Conectar ${name}` })));
}
