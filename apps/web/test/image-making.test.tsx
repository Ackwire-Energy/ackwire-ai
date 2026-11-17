import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

type State = ReturnType<typeof seedState>;
type Api = ReturnType<typeof createFakeApi>;

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const making = () => document.querySelector(".image-making") as HTMLElement | null;
const tile = () => document.querySelector(".artifact-cards > .artifact-tile[data-media]") as HTMLElement | null;
const upload = (api: Api, dm: string, name: string) =>
  api.artifacts.upload(ORG_ID, new File([PNG], name, { type: "image/png" }), { channelId: dm });
/** Ada's reply in the DM, carrying one picture. */
const replyWith = (dm: string, id: string, artifact: Record<string, unknown>) => ({
  id,
  channelId: dm,
  threadId: null,
  author: { type: "agent" as const, id: ADA_ID },
  body: "Pronto.",
  mentionedAgentIds: [],
  agentRunId: "r-img",
  meta: { artifacts: [artifact] },
  createdAt: new Date().toISOString(),
});

/** Ada's DM, open, with its socket: `ev` delivers what the server would publish there. `before`: what is there already. */
async function dmWithAda(before?: (api: Api, dm: string, state: State) => Promise<void>) {
  const state = seedState();
  const api = createFakeApi(state);
  const dm = seedDm(state, { type: "agent", id: ADA_ID }, { ago: 5, body: "Oi!" });
  await before?.(api, dm, state);
  const r = await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api });
  await settle(6);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  const ev = (event: Record<string, unknown>) =>
    act(async () => socket.push({ type: "event", channelId: dm, event: { channelId: dm, ...event } }));
  return { api, state, dm, ev };
}

describe("a picture an agent makes", () => {
  test("while its image tool runs, the conversation shows where the picture will be; its reply takes that place", async () => {
    const { api, state, dm, ev } = await dmWithAda();
    const run = { threadId: null, runId: "r-img", agentId: ADA_ID };
    await ev({ type: "agent.run", ...run, status: "running", startedAt: new Date(Date.now() - 30_000).toISOString() });
    await ev({ type: "agent.thinking", ...run });
    expect(making()).toBeNull();
    await ev({ type: "agent.step", ...run, tool: "image_generation" });
    await settle(3);
    expect(making()?.getAttribute("role")).toBe("status");
    expect(making()?.textContent).toBe("Criando a imagem…");
    // The line above the composer says it in words too.
    expect(document.querySelector(".ac-typing")?.textContent).toContain("criando uma imagem");

    // The reply lands with the picture and its size: the box is gone, the picture has its shape from the start.
    const a = await upload(api, dm, "farol.png");
    const reply = replyWith(dm, "m-img", { id: a.id, version: 1, title: "farol.png", width: 1024, height: 1536 });
    state.messages.push(reply as never);
    await ev({ type: "message.created", messageId: reply.id, message: reply });
    await settle(6);
    expect(making()).toBeNull();
    expect(tile()?.hasAttribute("data-ratio")).toBe(true);
    expect(tile()?.style.getPropertyValue("--ratio")).toBe(String(1024 / 1536));
  });

  test("a picture whose size the server didn't read keeps the box it had", async () => {
    await dmWithAda(async (api, dm, state) => {
      const a = await upload(api, dm, "tela.png");
      state.messages.push(replyWith(dm, "m-old", { id: a.id, version: 1, title: "tela.png" }) as never);
    });
    expect(tile()).not.toBeNull();
    expect(tile()?.hasAttribute("data-ratio")).toBe(false);
  });
});
