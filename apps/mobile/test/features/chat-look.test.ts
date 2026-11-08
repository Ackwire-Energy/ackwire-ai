import { describe, expect, test } from "bun:test";
import { chatLookOf, facesShown, mineOnRight } from "@agenteschat/client/lib/chat-look";
import { AGENT_GRADIENTS, type AgentColorName, contrastOf, gradientOf, mixHex } from "@agenteschat/ui/agent/engine";
import {
  BUBBLES_INSET,
  bubbleFill,
  MSG_INSET,
  MSG_TEXT,
  nameInk,
  quietInset,
  ROW_BODY_INSET,
  rowBodyInset,
} from "../../src/features/chat/logic";
import { appColors } from "../../src/ui/palette";

const read = (rel: string) => Bun.file(new URL(`../../src/features/${rel}`, import.meta.url).pathname).text();

describe("the bubbles' colors", () => {
  test("light is a tint of the agent's deep color on the page, stronger on a dark page; strong is the color darkened", () => {
    const deep = gradientOf("green")[1];
    expect(bubbleFill("green", "light", "#ffffff", false)).toBe(mixHex("#ffffff", deep, 0.2));
    expect(bubbleFill("green", "light", "#111110", true)).toBe(mixHex("#111110", deep, 0.3));
    expect(bubbleFill("green", "strong", "#ffffff", false)).toBe(mixHex(deep, "#000000", 0.18));
  });

  const colors = [...Object.keys(AGENT_GRADIENTS), "#ffff00", "#00ffff", "#ffffff"] as AgentColorName[];

  test("every color: white on the strong bubble is AA", () => {
    for (const color of colors) {
      expect(contrastOf("#ffffff", bubbleFill(color, "strong", "#ffffff", false))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("every color: a name is AA on the bubble of both themes", () => {
    for (const color of colors) {
      expect(contrastOf(nameInk(color, false), appColors("light").bubble)).toBeGreaterThanOrEqual(4.5);
      expect(contrastOf(nameInk(color, true), appColors("dark").bubble)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("the rows follow the same choice as the web", () => {
  test("defaults: channels on the left, DMs in bubbles", () => {
    expect(chatLookOf(undefined, false).style).toBe("left");
    expect(chatLookOf(undefined, true).style).toBe("bubbles");
    expect(mineOnRight("left")).toBe(false);
  });

  test("my row and the live row read the conversation's look", async () => {
    const row = await read("chat/MessageRow.tsx");
    expect(row).toContain("const onRight = mine && mineOnRight(look.style);");
    expect(row).toContain("if (onRight) {");
    expect(await read("chat/LiveRows.tsx")).toContain("const look = useRowLook();");
    const chat = await read("chat/ChatScreen.tsx");
    expect(chat).toContain("<RowLookContext.Provider value={rowLook}>");
    expect(chat).toContain('Boolean(dm) || thread.data?.channelKind === "dm"');
  });

  test("a DM drops the name only where a bubble stands: a card alone keeps it ahead of its time", async () => {
    const row = await read("chat/MessageRow.tsx");
    expect(row).toContain("{!inBubble || look.names ? (");
    expect(row).not.toContain("{!bubbled || look.names ? (");
    expect(await read("chat/LiveRows.tsx")).toContain("{!bubbled || look.names || !(said || run.text) ? (");
  });

  test("opening at the last read message goes to the line, once, with no glide", async () => {
    const chat = await read("chat/ChatScreen.tsx");
    expect(chat).toContain("firstUnreadId(list, from.at, meId)");
    expect(chat).toContain("holdAt(id ?? undefined, 0, false);");
  });

  test("a DM whose sides say who spoke has no face: its bodies and quiet rows start at the rows' own padding", () => {
    const dm = (style: "comfortable" | "bubbles") => ({ style, faces: facesShown(style, true) });
    expect(rowBodyInset(dm("bubbles"))).toEqual({ left: BUBBLES_INSET, right: ROW_BODY_INSET.bubbles.right });
    expect(rowBodyInset(dm("comfortable"))).toEqual({ left: MSG_INSET, right: ROW_BODY_INSET.comfortable.right });
    expect(quietInset(dm("bubbles"))).toBe(BUBBLES_INSET);
    expect(quietInset(dm("comfortable"))).toBe(MSG_INSET);
    // A channel, and a DM in a look with everyone on the left, keep the face and the words' column.
    for (const style of ["comfortable", "bubbles", "left", "compact"] as const) {
      expect(rowBodyInset({ style, faces: facesShown(style, false) })).toEqual(ROW_BODY_INSET[style]);
      expect(quietInset({ style, faces: facesShown(style, false) })).toBe(MSG_TEXT);
    }
    expect(quietInset({ style: "left", faces: facesShown("left", true) })).toBe(MSG_TEXT);
  });

  test("the look says it, and every row with a face column and every quiet row reads it", async () => {
    expect(await read("chat/look.ts")).toContain("faces: facesShown(style, dm)");
    expect(await read("chat/look.ts")).toContain("paddingLeft: BUBBLES_INSET");
    for (const file of ["chat/MessageRow.tsx", "chat/LiveRows.tsx"]) {
      expect(await read(file)).toContain("{look.faces ? (");
    }
    const queue = await read("queue/parts.tsx");
    expect(queue).toContain("{faces ? (");
    expect(await read("chat/QuoteLine.tsx")).toContain(
      "look.faces ? WORDS_START[look.style] : rowBodyInset(look).left",
    );
    expect(await read("chat/ConsultGroup.tsx")).toContain("const inset = rowBodyInset(useRowLook());");
    expect(await read("chat/ChatScreen.tsx")).toContain("const quiet = quietInset(rowLook);");
    for (const file of [
      "chat/EventLine.tsx",
      "chat/issue-work.tsx",
      "chat/StoppedLine.tsx",
      "chat/AgentReceipts.tsx",
      "queue/parts.tsx",
    ]) {
      const src = await read(file);
      expect(src).toContain("useQuietInset()");
      expect(src).not.toContain("MSG_TEXT");
    }
  });

  test("Conversa's DM previews draw it as the conversation does", async () => {
    const page = await read("me/ChatLookPage.tsx");
    expect(page).toContain("const faced = !right && facesShown(style, dm);");
    expect(page.match(/\{faced \? <View style=\{styles\.faceSlot\}>\{face\}<\/View> : null\}/g)).toHaveLength(2);
  });

  test("Você opens Conversa, which saves on the server", async () => {
    expect(await read("me/MeScreen.tsx")).toContain('href: "/me/chat-look"');
    const page = await read("me/ChatLookPage.tsx");
    expect(page).toContain("useSetChatPrefs(orgId)");
    expect(page).toContain("save(dm ? { dmStyle: s } : { channelStyle: s })");
  });
});
