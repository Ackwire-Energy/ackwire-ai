import { describe, expect, test } from "bun:test";
import { messagePath, parseMessageLink } from "@agenteschat/client/lib/message-links";
import { messageRefWords, parseInline } from "../../src/features/chat/logic";
import { chatHref } from "../../src/features/links/logic";
import { translator } from "./fixtures";

const ORG = "00000000-0000-4000-8000-000000000001";
const CH = "00000000-0000-4000-8000-0000000000c1";
const TH = "00000000-0000-4000-8000-0000000000d1";
const M = "00000000-0000-4000-8000-0000000000e1";
const SERVER = "https://agentes.example";

describe("a message link in the phone's chat", () => {
  test("this server's link is a message's pill, another server's stays a link", () => {
    const link = `${SERVER}${messagePath(ORG, { id: M, channelId: CH })}`;
    const [span] = parseInline(link);
    expect(span).toEqual({ kind: "link", text: link, href: link });
    expect(parseMessageLink(span?.kind === "link" ? span.href : "", [SERVER])).toEqual({
      orgId: ORG,
      messageId: M,
      channelId: CH,
      threadId: null,
    });
    expect(parseMessageLink(`https://elsewhere.example${messagePath(ORG, { id: M, channelId: CH })}`, [SERVER])).toBe(
      null,
    );
  });

  test("the pill's words and where a tap goes: the conversation, a reply's thread, at the message", async () => {
    const t = await translator("pt-BR");
    const card = { id: M, channelId: CH, threadId: null, kind: "channel" as const, name: "general", author: "Bia" };
    expect(messageRefWords(t, card)).toBe("#general › ");
    expect(messageRefWords(t, { ...card, threadId: TH })).toBe("#general › Thread › ");
    expect(messageRefWords(t, { ...card, kind: "dm", name: "Ana" })).toBe("@Ana › ");
    expect(chatHref(CH, TH, M)).toBe(`/chat/${CH}?thread=${TH}&m=${M}`);
    // "Copiar link da mensagem": a reply's link is its thread's.
    expect(messagePath(ORG, { id: M, channelId: CH, threadId: TH })).toBe(`/org/${ORG}/threads/${TH}?m=${M}`);
  });
});
