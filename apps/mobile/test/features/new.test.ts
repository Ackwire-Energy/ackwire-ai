import { describe, expect, test } from "bun:test";
import type { DirectMessage } from "@agenteschat/client";
import { buildConversations } from "../../src/features/chats/logic";
import { AGENT_NAMES, askTargets, pickedTarget, requestBody, suggestAgentName } from "../../src/features/new/logic";
import { agent, at } from "./fixtures";

const dm = (channelId: string, who: { type: "agent" | "person"; id: string }, minutesAgo: number | null) =>
  ({
    channelId,
    with: { ...who, name: who.id, handle: who.id },
    lastMessage:
      minutesAgo === null
        ? null
        : { id: `m-${channelId}`, body: "oi", createdAt: at(minutesAgo), authorType: "person" },
    unread: 0,
  }) satisfies DirectMessage;

const rows = (dms: DirectMessage[]) => buildConversations({ channels: [], dms, threads: [] });

describe("Novo: who a request goes to", () => {
  const theo = agent({ id: "theo", name: "Theo" });
  const nina = agent({ id: "nina", name: "Nina" });
  const ada = agent({ id: "ada", name: "Ada" });
  const iris = agent({ id: "iris", name: "Iris" });

  test("the agent you talked to last comes first, then by recency, then the rest by name", () => {
    const list = askTargets(
      [theo, nina, ada, iris],
      rows([
        dm("d1", { type: "agent", id: "nina" }, 120),
        dm("d2", { type: "agent", id: "theo" }, 5),
        dm("d3", { type: "person", id: "theo" }, 1),
        dm("d4", { type: "agent", id: "iris" }, null),
      ]),
    );
    expect(list.map((a) => a.id)).toEqual(["theo", "nina", "ada", "iris"]);
  });

  test("agents that don't talk to you are left out; nobody talked to means by name", () => {
    const list = askTargets([theo, { ...nina, canTalk: false }, ada], []);
    expect(list.map((a) => a.id)).toEqual(["ada", "theo"]);
  });

  test("the tapped agent wins while it is still there, else the first", () => {
    const list = [theo, nina];
    expect(pickedTarget(list, null)?.id).toBe("theo");
    expect(pickedTarget(list, "nina")?.id).toBe("nina");
    expect(pickedTarget(list, "gone")?.id).toBe("theo");
    expect(pickedTarget([], "nina")).toBeNull();
  });

  test("the request is the text, trimmed; nothing to send when empty", () => {
    expect(requestBody("  Revisar a página de preços\n")).toBe("Revisar a página de preços");
    expect(requestBody(" \n ")).toBeNull();
  });
});

describe("Novo agente: the suggested name", () => {
  test("the first name nobody uses, ignoring case and accents", () => {
    expect(suggestAgentName([])).toBe(AGENT_NAMES[0]);
    expect(suggestAgentName(["lu", "NÍNA"])).toBe("Theo");
  });

  test("all taken: the first name with a number", () => {
    expect(suggestAgentName(["Lu", "Ana"], ["Lu", "Ana"])).toBe("Lu 2");
    expect(suggestAgentName(["Lu", "Lu 2"], ["Lu"])).toBe("Lu 3");
  });
});
