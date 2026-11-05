import { describe, expect, test } from "bun:test";
import { chatLookOf, mineOnRight } from "@agenteschat/client/lib/chat-look";
import { gradientOf, mixHex } from "@agenteschat/ui/agent/engine";
import { bubbleFill, nameInk } from "../../src/features/chat/logic";

const read = (rel: string) => Bun.file(new URL(`../../src/features/${rel}`, import.meta.url).pathname).text();

describe("the bubbles' colors", () => {
  test("light is a tint of the agent's deep color on the page, stronger on a dark page; strong is the color darkened", () => {
    const deep = gradientOf("green")[1];
    expect(bubbleFill("green", "light", "#ffffff", false)).toBe(mixHex("#ffffff", deep, 0.2));
    expect(bubbleFill("green", "light", "#111110", true)).toBe(mixHex("#111110", deep, 0.3));
    expect(bubbleFill("green", "strong", "#ffffff", false)).toBe(mixHex(deep, "#000000", 0.18));
  });

  test("a name reads on both pages", () => {
    const [top, deep] = gradientOf("violet");
    expect(nameInk("violet", false)).toBe(deep);
    expect(nameInk("violet", true)).toBe(top);
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

  test("opening at the last read message goes to the line, once, with no glide", async () => {
    const chat = await read("chat/ChatScreen.tsx");
    expect(chat).toContain("firstUnreadId(list, readFrom?.at, meId)");
    expect(chat).toContain("holdAt(id ?? undefined, 0, false);");
  });

  test("Você opens Conversa, which saves on the server", async () => {
    expect(await read("me/MeScreen.tsx")).toContain('href: "/me/chat-look"');
    const page = await read("me/ChatLookPage.tsx");
    expect(page).toContain("useSetChatPrefs(orgId)");
    expect(page).toContain("save(dm ? { dmStyle: s } : { channelStyle: s })");
  });
});
