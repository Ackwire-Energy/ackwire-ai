import { describe, expect, test } from "bun:test";
import { CHAT_TEXT_SIZES, chatLookOf, mineOnRight, textSizeOf } from "@agenteschat/client/lib/chat-look";
import { AGENT_GRADIENTS, type AgentColorName, contrastOf, gradientOf, mixHex } from "@agenteschat/ui/agent/engine";
import { bubbleFill, CHAT_TEXT, CHAT_TEXT_MAX_SCALE, chatNameOf, nameInk } from "../../src/features/chat/logic";
import { appColors } from "../../src/ui/palette";
import { typeScale } from "../../src/ui/type-scale";

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

  test("Você opens Conversa, which saves on the server", async () => {
    expect(await read("me/MeScreen.tsx")).toContain('href: "/me/chat-look"');
    const page = await read("me/ChatLookPage.tsx");
    expect(page).toContain("useSetChatPrefs(orgId)");
    expect(page).toContain("save(dm ? { dmStyle: s } : { channelStyle: s })");
  });
});

describe("Tamanho do texto on the phone", () => {
  /** Points, before the system's own text size: the words and their line. */
  const STEPS = { xs: [13, 18], sm: [14, 20], md: [15, 21], lg: [17, 24], xl: [19, 27] } as const;

  for (const step of CHAT_TEXT_SIZES)
    test(`${step}: the words and their line follow the step, the name a step under them`, () => {
      const [fontSize, lineHeight] = STEPS[step];
      expect(CHAT_TEXT[step]).toEqual({ fontSize, lineHeight });
      expect(chatNameOf(CHAT_TEXT[step])).toEqual({ fontSize: fontSize - 1, lineHeight: lineHeight - 2 });
      expect(lineHeight / fontSize).toBeGreaterThanOrEqual(1.35);
      expect(lineHeight / fontSize).toBeLessThanOrEqual(1.45);
    });

  test("the default is md: smaller than the system body the words had on both systems, the name as it was", () => {
    expect(textSizeOf(undefined)).toBe("md");
    const md = CHAT_TEXT.md;
    for (const os of ["ios", "android"] as const) expect(md.fontSize).toBeLessThan(typeScale(os).body.fontSize);
    expect(md.lineHeight).toBeLessThan(24);
    expect(chatNameOf(md)).toEqual({ fontSize: 14, lineHeight: 19 });
    // `lg` is iOS's body on the line the words had, for whoever wants them back.
    expect(CHAT_TEXT.lg).toEqual({ fontSize: typeScale("ios").body.fontSize, lineHeight: 24 });
    const sizes = CHAT_TEXT_SIZES.map((s) => CHAT_TEXT[s].fontSize);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  });

  test("the system's text size still grows the words and the name, up to twice", async () => {
    expect(CHAT_TEXT_MAX_SCALE).toBe(2);
    const words = await read("chat/MessageText.tsx");
    expect(words).toContain("const sized = small ? null : look.text;");
    expect(words).toContain("const fit = sized ? { maxFontSizeMultiplier: CHAT_TEXT_MAX_SCALE } : {};");
    // Outside a conversation (a task's text, a document) the page's own body, as before.
    expect(words).toContain("(sized ?? styles.line)");
    for (const file of ["chat/MessageText.tsx", "chat/MessageRow.tsx", "chat/LiveRows.tsx", "chat/MessageSpans.tsx"])
      expect(await read(file)).not.toContain("allowFontScaling={false}");
    expect(await read("chat/MessageRow.tsx")).toContain(
      "maxFontSizeMultiplier={nameSize ? CHAT_TEXT_MAX_SCALE : undefined}",
    );
    expect(await read("chat/LiveRows.tsx")).toContain(
      "maxFontSizeMultiplier={look.text ? CHAT_TEXT_MAX_SCALE : undefined}",
    );
  });

  test("every conversation reads the step from its look, and Conversa saves it on the server with a preview", async () => {
    expect(await read("chat/look.ts")).toContain("const text = CHAT_TEXT[textSizeOf(org?.chatPrefs)];");
    expect(await read("chat/look.ts")).toContain("text: null };");
    const page = await read("me/ChatLookPage.tsx");
    expect(page).toContain("save({ textSize: v as ChatTextSize })");
    expect(page).toContain("<TextPreview size={textSize} style={style} tone={tone} dm={dm} />");
    // Five steps that fit a phone's width: an A in each step's size, the default named, every step named aloud.
    expect(page).toContain("<RNText style={{ fontSize: CHAT_TEXT[s].fontSize }}>A</RNText>");
    expect(page).toContain("{s === DEFAULT_TEXT_SIZE ? ");
    expect(page).toContain("accessibilityLabel: sizes[s],");
    expect(await read("../ui/Segmented.tsx")).toContain("accessibilityLabel={item.accessibilityLabel}");
    expect(page).toContain('t("settings.account.chat.textSizePhone")');
  });
});
