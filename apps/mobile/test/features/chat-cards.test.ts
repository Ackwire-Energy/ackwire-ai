import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A file of the app, as text: where a reply's parts go lives in components the tests can't render. */
const source = (path: string) => readFileSync(join(import.meta.dir, "../../src/features/chat", path), "utf8");
/** Where each piece first shows in a file, in the order given. */
const at = (text: string, pieces: string[]) =>
  pieces.map((p) => {
    const i = text.indexOf(p);
    if (i < 0) throw new Error(`not found: ${p}`);
    return i;
  });
const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || (xs[i - 1] ?? 0) < x);

describe("a reply's tools sit last, live and saved", () => {
  test("saved: its words, what it changed and its cards, then its questions to others and its tools", () => {
    const row = source("MessageRow.tsx");
    expect(
      ascending(
        at(row, [
          "body ? (\n          <MessageText body={body}",
          "<Receipts message={m} />",
          "{cards}\n        {/* Its tools last",
          "<ConsultGroup message={m} color={color} />",
          "<TurnTools",
          "<SavedTools",
          "{foot}\n      </View>\n    </Pressable>\n  );\n});",
        ]),
      ),
    ).toBe(true);
    // The cards above the tools are an issue's and a mission's; the thread, the reactions and the send state go under.
    const [cardsAt, footAt, endAt] = at(row, ["const cards = (", "const foot = (", "\n  if (mine) {"]);
    const cards = row.slice(cardsAt, footAt);
    const foot = row.slice(footAt, endAt);
    for (const card of [
      "<IssueWorkCard",
      "<MissionCard",
      "<PlanCard",
      "<ReviewCard",
      "<DecisionCard",
      "<SetupFailedCard",
    ])
      expect([card, cards.includes(card)]).toEqual([card, true]);
    for (const part of ["<ThreadLink", "<Reactions", "<Sending"])
      expect([part, foot.includes(part)]).toEqual([part, true]);
  });

  test("live: the words stream above its tools, where the saved reply keeps them", () => {
    const live = source("LiveRows.tsx");
    expect(
      ascending(
        at(live, ["{run.text && !wordsOnTop ? <RevealText", '<TurnTools items={lines} agentName={agent?.name ?? ""}']),
      ),
    ).toBe(true);
  });
});

describe("one call is its own line", () => {
  test("live, kept and saved replies and a single question to a teammate draw the line, not the block", () => {
    const tools = source("ToolCalls.tsx");
    expect(tools).toContain("const one = oneCall(items);");
    expect(tools).toContain("one={one}");
    expect(tools).toContain("const lone = savedOneLine(meta);");
    expect(tools).toContain("<Line line={{ ...only.line, detail }} color={color} onToggle={onToggle} />");
    expect(source("ConsultGroup.tsx")).toContain("one={group.length === 1}");
  });
});

describe("what an agent changed reads whole", () => {
  test("receipts and team checks wrap: no line limit cuts their words", () => {
    for (const file of ["Receipts.tsx", "TeamChecks.tsx"]) expect(source(file)).not.toContain("numberOfLines");
  });

  test("Desfazer leaving keeps its room, the time left inside it: the sentence never rewraps", () => {
    const receipts = source("Receipts.tsx");
    expect(receipts).toContain("return v.button ? button : <Room>{button}</Room>;");
    expect(receipts).toContain("detail={redo ? undefined : v.timeLeft || formatTimeLeft(0)}");
    expect(receipts).not.toContain('t("agentActions.timeLeft"');
  });

  test("they wear the tool block's card (the face a step up, a hairline), never the sunken gray of a pressed row", () => {
    for (const file of ["Receipts.tsx", "TeamChecks.tsx"]) {
      const text = source(file);
      expect(text).not.toContain("sunken");
      expect(text).toMatch(/backgroundColor: (c|colors)\.raised, borderColor: (c|colors)\.line2/);
    }
  });
});
