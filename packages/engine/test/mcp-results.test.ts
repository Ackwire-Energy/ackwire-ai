import { expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpSessionOver } from "../src";

/** A server answering like GitHub's `get_file_contents`: a status line, then the file as an embedded resource. */
async function session() {
  const server = new McpServer({ name: "files", version: "1" });
  server.registerTool("get_file_contents", { description: "Get a file" }, async () => ({
    content: [
      { type: "text" as const, text: "successfully downloaded text file (SHA: 34f0320)" },
      {
        type: "resource" as const,
        resource: {
          uri: "repo://acme/app/contents/docs/adr/0001.md",
          mimeType: "text/markdown",
          text: "# Early access\n\nSign-up is open.",
        },
      },
      {
        type: "resource" as const,
        resource: { uri: "repo://acme/app/contents/logo.png", mimeType: "image/png", blob: "iVBORw0KGgo=" },
      },
    ],
  }));
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  return mcpSessionOver(client);
}

test("a file sent as an embedded resource reaches the agent as its text; a binary one stays a placeholder", async () => {
  const s = await session();
  const out = await s.callTool("get_file_contents", {});
  expect(out.isError).toBe(false);
  expect(out.content).toBe(
    "successfully downloaded text file (SHA: 34f0320)\n# Early access\n\nSign-up is open.\n[resource]",
  );
  await s.close();
});
