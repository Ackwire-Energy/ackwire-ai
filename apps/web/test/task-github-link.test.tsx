import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

const url = "https://github.com/acme/app/pull/40";
const paste = async (field: HTMLElement, text: string) => {
  await act(async () => fireEvent.change(field, { target: { value: text } }));
  await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
  await settle(4);
};

describe("a task's GitHub link", () => {
  test("pasted on the task it turns into a chip that opens it, and removing it brings the field back", async () => {
    await renderApp(`/org/${ORG_ID}/issues/131`, { api: createFakeApi(seedState()) });
    await settle(6);
    const aside = document.querySelector(".issue-aside") as HTMLElement;
    const field = within(aside).getByLabelText("Link do GitHub");
    await paste(field, "https://github.com/acme/app");
    expect(aside.textContent).toContain("Esse não é o link de uma issue ou pull request do GitHub.");
    await paste(within(aside).getByLabelText("Link do GitHub"), url);
    const chip = within(aside).getByRole("link", { name: "app#40" });
    expect(chip.getAttribute("href")).toBe(url);
    expect(chip.getAttribute("rel")).toContain("noopener");
    await act(async () => fireEvent.click(within(aside).getByRole("button", { name: "Remover o link do GitHub" })));
    await settle(4);
    expect(within(aside).queryByRole("link", { name: "app#40" })).toBeNull();
    expect(within(aside).getByLabelText("Link do GitHub")).not.toBeNull();
  });

  test("its row on the board shows the chip", async () => {
    const api = createFakeApi(seedState());
    const task = await api.issues.get(ORG_ID, 131);
    await api.issues.update(ORG_ID, task.id, { githubUrl: url });
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(8);
    const card = document.querySelector('[data-card="131"]') as HTMLElement;
    expect(card.textContent).toContain("app#40");
  });
});
