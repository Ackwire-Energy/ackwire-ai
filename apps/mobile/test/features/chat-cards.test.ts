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
          ") : body ? (\n          <MessageText\n            body={body}",
          "<Receipts message={m} />",
          "{cards}\n        {/* Its tools after",
          "<ConsultGroup message={m} color={color} />",
          "<TurnTools",
          "<SavedTools",
          "<NoAiCard message={m} />",
          "{foot}\n      </View>\n    </Pressable>\n  );\n});",
        ]),
      ),
    ).toBe(true);
    // The cards above the tools are an issue's and a mission's; the thread, the reactions and the send state go under.
    const [cardsAt, footAt, endAt] = at(row, ["const cards = (", "const foot = (", "\n  if (mine) {"]);
    const cards = row.slice(cardsAt, footAt);
    const foot = row.slice(footAt, endAt);
    for (const card of ["<IssueWorkCard", "<MissionCard", "<PlanCard", "<ReviewCard", "<SetupFailedCard"])
      expect([card, cards.includes(card)]).toEqual([card, true]);
    for (const part of ["<ThreadLink", "<Reactions", "<Sending"])
      expect([part, foot.includes(part)]).toEqual([part, true]);
  });

  test("what waits for a person's click comes after the tools, the thread and reactions under it", () => {
    const row = source("MessageRow.tsx");
    const [toolsAt, footAt] = at(row, ["<SavedTools\n", "{foot}\n      </View>\n    </Pressable>\n  );\n});"]);
    const last = row.slice(toolsAt, footAt);
    for (const card of [
      "<NoAiCard",
      "<StretchCard",
      "<ProposalCard",
      "<InstructionProposals",
      "<ApprovalInline",
      "<HandoffCard",
      "<QuestionCard",
      "<SecretCard",
      "{missionDecision}",
    ])
      expect([card, last.includes(card)]).toEqual([card, true]);
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
    expect(tools).toContain("const lone = savedOneLine(meta, onCard);");
    expect(tools).toContain("<Line line={{ ...only.line, detail }} color={color} onToggle={onToggle} />");
    expect(source("ConsultGroup.tsx")).toContain("one={group.length === 1}");
  });
});

describe("nothing more than the message shows", () => {
  test("a lone quick read draws no block; no block opens on nothing or says it used no tools", () => {
    const tools = source("ToolCalls.tsx");
    expect(tools).toContain("const now = quietWork(items) || (done && !showsActivity(org)) ? null : toolNow(items);");
    expect(tools).toContain("if (lone && lone.ms !== null && quietLine(lone)) return null;");
    expect(tools).toContain("const shown = compact ? workSteps(compact, onCard) : 0;");
    expect(tools).not.toContain("chat.work.none");
    expect(tools).not.toContain("chat.work.see");
  });
});

describe("what agents did under each reply: the person's own setting, off by default", () => {
  test("off, a done reply keeps only what it read and a saved one draws no block; the live block stays", () => {
    const tools = source("ToolCalls.tsx");
    // Done and off: no call is "now", so only the messages it read stay (the branch for a reply with no call).
    expect(tools).toContain("(done && !showsActivity(org)) ? null : toolNow(items);");
    expect(tools).toContain('const shown = done ? items.filter((i) => i.kind === "steer") : items;');
    expect(tools).toContain("if (!compact || shown === 0 || !showsActivity(org)) return null;");
    // The cards that carry content or wait for a person aren't the tools' and stay in the row.
    const row = source("MessageRow.tsx");
    expect(row).toContain("<SecretCard");
    // Where it browsed and its desktop are step summaries (no picture): activity, gated like the tools.
    expect(row).toContain("isAgent && m.author.id && !m.local && showsActivity(org)");
    expect(row.match(/showsActivity/g)?.length).toBe(2);
  });

  test("Você has the row and its page, and a secret request's card shows without its text", () => {
    const me = readFileSync(join(import.meta.dir, "../../src/features/me/MeScreen.tsx"), "utf8");
    expect(me).toContain('href: "/me/activity"');
    const route = readFileSync(join(import.meta.dir, "../../app/(app)/me/activity.tsx"), "utf8");
    expect(route).toContain("<ActivityPage />");
    expect(source("logic.ts")).toMatch(/hidesBody = [^;]*secretRequestOf\(m\.meta\)/);
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

describe("a shared approval card with actions approved ahead", () => {
  test("each waiting item says it approves a future action; an approved one says when and can be canceled", () => {
    const cards = source("cards.tsx");
    const start = cards.indexOf("function ApprovalGroupAsk(");
    const group = cards.slice(start, cards.indexOf("\nfunction ", start + 1));
    expect(group).toContain("<ApprovalAheadLine approval={a} />");
    expect(group).toContain('t("approval.ahead.scheduled"');
    expect(group).toContain("cancelAhead.cancel(a.id)");
  });
});

describe("a stretch's pause card on the phone (ADR 0089)", () => {
  test("once someone let them go on, one quiet line: who and when, no card and no Continuar", () => {
    const card = source("../ai/StretchCard.tsx");
    const [doneAt, cardAt] = at(card, ["if (continued) {", "<View style={[styles.card"]);
    const done = card.slice(doneAt, cardAt);
    expect(done).toContain("<AskDone");
    expect(done).toContain('t("stretchCard.continuedByYou", { time })');
    expect(done).not.toContain("<Button");
    expect(card.slice(cardAt)).not.toContain("continued");
  });
});

describe("a plan account's agents on the phone (Contas dos planos)", () => {
  test("bars split by agent, then one list, then when it renews and how old, then the month", () => {
    const screen = source("../usage/UsageScreen.tsx");
    const block = screen.slice(...at(screen, ["function AccountBlock(", "function AgentShares("]));
    expect(ascending(at(block, ["<PlanMeter usage={splitUsage(", "{list}", "usageViews.monthTokens"]))).toBe(true);
    expect(block).not.toContain("account.agents.map");
    const list = screen.slice(...at(screen, ["function AgentShares(", "/** The API per agent:"]));
    expect(ascending(at(list, ["usageViews.thisMonth", "openAgentUsage(a.agentId)", "usageViews.moreAgents"]))).toBe(
      true,
    );
    // The renewal moves under the list, once.
    const parts = source("../usage/parts.tsx");
    expect(
      ascending(at(parts, ["!children ? (", "{children}\n      {children && renews ?", "text.updated(usage.at)"])),
    ).toBe(true);
  });
});
