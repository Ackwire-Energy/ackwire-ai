import { describe, expect, test } from "bun:test";
import { createFakeApi, ORG_ID } from "./fake-api";

/** Mocks left: the org-wide invite link, "ask for a new invitation" and custom MCP servers (custom-mcp.test.tsx). */
describe("remaining mocks", () => {
  test("org-wide invite link", async () => {
    expect((await createFakeApi().invites.createLink(ORG_ID)).url).toStartWith("http://localhost:3000/invite/");
  });

  test("custom MCP: needs a key unless the server supports OAuth; nothing classified at first", async () => {
    const api = createFakeApi();
    expect(await api.customConnectors.connect(ORG_ID, { serverUrl: "https://mcp.x.com", returnTo: "/" })).toEqual({
      status: "needs_key",
    });
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://mcp.x.com",
      apiKey: "chave-123456",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    expect(res.server.tools.every((t) => t.access === null)).toBe(true);
    expect(res.server.reviewedAt).toBeNull();
  });
});
