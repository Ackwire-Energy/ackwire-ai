import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

describe("the activity bar while an agent is in its browser", () => {
  test("says 'No navegador'; a click on the bar opens the agent's browser live, watching", async () => {
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    const run = { threadId: "m-1", runId: "r-browser", agentId: ADA_ID };
    await ev({ type: "agent.thinking", ...run });
    await settle();
    const bar = () => document.querySelector(".ac-typing") as HTMLElement;
    // Not in the browser yet: no hint, the bar isn't a link.
    expect(within(bar()).queryByRole("button", { name: "No navegador" })).toBeNull();
    expect(bar().dataset.browser).toBeUndefined();

    await ev({ type: "agent.tool", ...run, tool: "browser_open" });
    await settle();
    expect(bar().dataset.browser).toBe("true");
    expect(bar().querySelector(".ac-typing__text")?.textContent).toBe("Ada está usando o navegador…");
    expect(within(bar()).getByRole("button", { name: "No navegador" })).toBeTruthy();

    // The pill itself is the target (its words), not only the button.
    await act(async () => fireEvent.click(bar().querySelector(".ac-typing__text") as HTMLElement));
    await settle(2);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/browser/${ADA_ID}`);
    expect(r.router.state.location.search).toMatchObject({ watch: 1 });
  });
});
