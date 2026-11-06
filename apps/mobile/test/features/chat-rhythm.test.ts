import { describe, expect, test } from "bun:test";
import { CHAT_RHYTHM, CHAT_STYLES } from "@agenteschat/client/lib/chat-look";
import { rowFrame } from "../../src/features/chat/logic";

const read = (rel: string) => Bun.file(new URL(`../../src/features/${rel}`, import.meta.url).pathname).text();

/** The style's body in a sheet: from its key to the next key at its depth. */
const styleOf = (sheet: string, key: string) => {
  const at = sheet.search(new RegExp(`^  ${key}: \\{`, "m"));
  expect(at).toBeGreaterThanOrEqual(0);
  const end = sheet.indexOf("\n  }", at);
  const line = sheet.indexOf("\n", at);
  return sheet.slice(at, sheet.slice(at, line).trimEnd().endsWith("{") ? end : line);
};

describe("one rhythm, the web's numbers (chat-rhythm-css.test.ts holds them to the sheet)", () => {
  test("from what shows to what shows: a row gives its plate's room back, whatever stands next to it", () => {
    for (const style of CHAT_STYLES) {
      const { part, turn, block } = CHAT_RHYTHM[style];
      for (const gap of [part, turn]) {
        const above = rowFrame(block, turn);
        const row = rowFrame(block, gap);
        // Row under a row: the plate under the first, its given-back room, the second's top and its plate.
        expect(above.paddingVertical + above.marginBottom + row.marginTop + row.paddingVertical).toBe(gap);
        // Row under a line, which has no plate.
        expect(row.marginTop + row.paddingVertical).toBe(gap);
        // A line under a row, at `gap`: the row ends on what shows.
        expect(above.paddingVertical + above.marginBottom).toBe(0);
      }
    }
  });

  test("the rows take their room from it, the parts from the body's gap, none from a margin of its own", async () => {
    const row = await read("chat/MessageRow.tsx");
    expect(row).toContain("rowFrame(rhythm.block, rowGap)");
    expect(row).toContain("quoteAbove && styles.replied");
    expect(row).toContain("[styles.body, { gap: rhythm.part }]");
    expect(row).toContain("[styles.meParts, { gap: rhythm.part }]");
    expect(await read("chat/LiveRows.tsx")).toContain("rowFrame(rhythm.block, rhythm.turn)");
    const parts: [string, string[]][] = [
      ["chat/MessageRow.tsx", ["msg", "me", "status", "stopped", "talkMore", "reacts"]],
      ["chat/LiveRows.tsx", ["msg"]],
      ["chat/look.ts", ["bubblesRow", "compactRow"]],
      ["chat/ToolCalls.tsx", ["block", "steps"]],
      ["chat/Receipts.tsx", ["one", "group"]],
      ["chat/TeamChecks.tsx", ["list"]],
      ["chat/ReachLines.tsx", ["list"]],
      ["chat/WorkLine.tsx", ["line", "privateTask"]],
      ["chat/ChatMedia.tsx", ["wrap", "sticker"]],
      ["chat/issue-work.tsx", ["card"]],
      ["browser/TrailCard.tsx", ["card"]],
      ["voice/VoiceMessage.tsx", ["box"]],
      ["ai/NoAiCard.tsx", ["card"]],
      ["ai/OfferCard.tsx", ["card"]],
      ["ai/StretchCard.tsx", ["card"]],
      ["ai/UsagePauseCard.tsx", ["card", "acts"]],
      ["ai/CostlyProposalCard.tsx", ["card"]],
      ["agents/ProposalCard.tsx", ["card"]],
      ["agents/InstructionProposalCard.tsx", ["card"]],
      ["missions/cards.tsx", ["mcard", "askcard", "inv"]],
    ];
    expect(styleOf(row, "msg")).not.toContain("paddingVertical");
    expect(styleOf(row, "me")).not.toContain("paddingVertical");
    for (const [file, keys] of parts) {
      const sheet = await read(file);
      for (const key of keys) expect(styleOf(sheet, key)).not.toMatch(/margin(Top|Bottom|Vertical)/);
    }
  });

  test("what stacks inside a row's words takes the part gap too", async () => {
    const row = await read("chat/MessageRow.tsx");
    // The line it opened with and an unfolded report, outside a bubble, stand a part from the words under them.
    expect(row).toContain("opener && words ? <View style={{ marginBottom: rhythm.part }}>{opener}</View> : opener");
    expect(row).toContain("(inBubble || opener || words) && { marginBottom: rhythm.part }");
    expect(styleOf(row, "report")).not.toContain("marginBottom");
    // A pin's caption stays on its words on either side: the body's gap is paid back on my rows.
    expect(styleOf(row, "pinLine")).not.toContain("marginBottom");
    expect(row).toContain("marginBottom: PIN_GAP - rhythm.part");
    // A row under its quote keeps its plate off the quote.
    expect(styleOf(row, "replied")).toContain("marginTop: 0");
    const live = await read("chat/LiveRows.tsx");
    expect(live).toContain("run.text ? { marginBottom: rhythm.part } : undefined");
    expect(live).not.toContain("styles.say");
  });

  test("the agents' line runs across the conversation, the pair on its middle, under the list's gap", async () => {
    const group = await read("chat/ConsultGroup.tsx");
    expect(group).toContain("marginTop: gap ?? rhythm.turn");
    expect(group.match(/<View style=\{\[styles\.rule/g)).toHaveLength(2);
    expect(styleOf(group, "rule")).toContain("flex: 1");
    expect(group).not.toContain("marginBottom: -6");
    // Inside a message, between turns too: the body's part gap and the line's own room make the turn's.
    expect(group).toContain("marginVertical: rhythm.turn - rhythm.part");
  });
});
