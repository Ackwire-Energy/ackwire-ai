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
  test("saved: its words, what it changed and its cards, then its tools", () => {
    const row = source("MessageRow.tsx");
    expect(
      ascending(
        at(row, [
          "{openerPart}\n                    {words}\n                  </>\n                )}",
          "<Receipts message={m} />",
          "{cards}\n            {/* Its tools after",
          "<TurnTools",
          "<SavedTools",
          "<NoAiCard message={m} />",
          "{foot}\n          </RowPartContext.Provider>\n        </View>\n      </Pressable>\n    </>\n  );\n});",
        ]),
      ),
    ).toBe(true);
    // The cards above the tools are an issue's and a mission's; the thread, the reactions and the send state go under.
    const [cardsAt, footAt, endAt] = at(row, ["const cards = (", "const foot = (", "\n  if (onRight) {"]);
    const cards = row.slice(cardsAt, footAt);
    const foot = row.slice(footAt, endAt);
    for (const card of ["<IssueWorkCard", "<MissionCard", "<PlanCard", "<ReviewCard", "<SetupFailedCard"])
      expect([card, cards.includes(card)]).toEqual([card, true]);
    for (const part of ["<ThreadLink", "<Reactions", "<Sending"])
      expect([part, foot.includes(part)]).toEqual([part, true]);
  });

  test("what waits for a person's click comes after the tools, the thread and reactions under it", () => {
    const row = source("MessageRow.tsx");
    const [toolsAt, footAt] = at(row, [
      "<SavedTools\n",
      "{foot}\n          </RowPartContext.Provider>\n        </View>\n      </Pressable>\n    </>\n  );\n});",
    ]);
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
        at(live, [
          "{run.text && !wordsOnTop ? (\n                  <RevealText",
          '<TurnTools items={lines} agentName={agent?.name ?? ""}',
        ]),
      ),
    ).toBe(true);
  });
});

describe("agents it asked first: one pair row right before the reply, never inside it", () => {
  test("saved: the row sits before the reply's own row (which then shows its face and name), none in its body", () => {
    const row = source("MessageRow.tsx");
    expect(ascending(at(row, ["const grouped = groupedIn && !pair;", "{pair}\n      {quote && !inBubble"]))).toBe(true);
    const [bodyAt, endAt] = at(row, [
      "<View style={[styles.body, { gap: rhythm.part }]}>",
      "{foot}\n          </RowPartContext.Provider>\n        </View>\n      </Pressable>",
    ]);
    expect(row.slice(bodyAt, endAt)).not.toContain("Consult");
  });

  test("live: a turn that posted nothing yet carries the row above its working row", () => {
    const live = source("LiveRows.tsx");
    expect(live).toContain("const consults = useRunConsults(run.runId, run, null);");
    // Before its words only the row stands (no thinking row); after them, right above the measured row.
    expect(live).toContain("if (waiting) return pair;");
    expect(live).toContain("{pair}\n      <View\n        ref={seen}\n        collapsable={false}");
  });

  test("the row says no answer: only faces, names, a short word and the time", () => {
    const pair = source("ConsultGroup.tsx");
    expect(pair).not.toContain("previewOf");
    expect(pair).not.toContain(".answer");
    expect(pair).toContain('<Icon name="swap"');
  });

  test("a notice whose reply isn't here is the same row, not a card with the answer", () => {
    const line = source("EventLine.tsx");
    expect(line).toContain("items={[pairItemOf(consulted.consultation)]}");
    expect(source("cards.tsx")).not.toContain("Consultation");
  });

  test("an answer far below its question is the same row, never a line of words or a pill", () => {
    const line = source("EventLine.tsx");
    expect(line).toContain("items={[fold.consultation]}");
    expect(line).not.toContain("consultFarKey");
    expect(source("ConsultGroup.tsx")).not.toContain("TalkPill");
  });

  test("a hand-off by direct message is the same row on its reach line, left out of the reply's own row", () => {
    const reach = source("ReachLines.tsx");
    expect(reach).toMatch(
      /<ConsultPairRow\s+askerId=\{authorId\}\s+channelId=\{channelId\}\s+items=\{\[talk\]\}\s+inline\s/,
    );
    expect(reach).not.toContain("reach.see");
    // One older than the conversation's list goes back is loaded on its own, never the "Entregue ao" text.
    expect(source("ConsultGroup.tsx")).toContain(
      "useConsultationConversation(orgId, channelId, id && list.isSuccess && !listed ? id : null)",
    );
    const row = source("MessageRow.tsx");
    expect(row).toContain("const reached = useMemo(() => reachHandoffs(m.meta), [m.meta]);");
    expect(row).toContain("    consulted,\n    reached,\n  );");
  });
});

describe("one call is its own line", () => {
  test("live, kept and saved replies and a single question to a teammate draw the line, not the block", () => {
    const tools = source("ToolCalls.tsx");
    expect(tools).toContain("const one = oneCall(items);");
    expect(tools).toContain("one={one}");
    expect(tools).toContain("const lone = savedOneLine(meta, onCard);");
    expect(tools).toContain("<Line line={{ ...only.line, detail }} color={color} onToggle={onToggle} />");
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
    expect(receipts).toContain("return v.button ? swapped : <Room>{button}</Room>;");
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
    // Each item of a shared card is drawn by its own component.
    const start = cards.indexOf("function ApprovalGroupItem(");
    const group = cards.slice(start, cards.indexOf("\nfunction ", start + 1));
    expect(group).toContain("<ApprovalAheadLine approval={a} />");
    expect(group).toContain('t("approval.ahead.scheduled"');
    expect(group).toContain("cancelAhead.cancel(a.id)");
  });
});

describe("a stretch's pause on the phone (ADR 0089)", () => {
  test("waiting, a waiting pill with Continue tinted; once someone let them go on, a decided pill: who and when", () => {
    const card = source("../ai/StretchCard.tsx");
    const [doneAt, waitAt] = at(card, ["if (continued) {", "<AskWaiting"]);
    const done = card.slice(doneAt, waitAt);
    expect(done).toContain("<AskDone");
    expect(done).toContain('t("stretchCard.continuedByYou", { time })');
    expect(done).not.toContain("EventPillAction");
    const waiting = card.slice(waitAt);
    expect(waiting).not.toContain("continued");
    expect(waiting).toContain("forMe={may}");
    expect(waiting).toMatch(/<EventPillAction\s+key="continue"\s+primary/);
    expect(card).not.toContain("<Button");
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
    // "Usa agora" only for an agent using it now, never for the folded row.
    expect(list).toContain("tokens(a.tokens, a.now)");
    expect(list).toContain("tokens(shares.restTokens)");
    // The renewal moves under the list, once.
    const parts = source("../usage/parts.tsx");
    expect(
      ascending(at(parts, ["!children ? (", "{children}\n      {children && renews ?", "text.updated(usage.at)"])),
    ).toBe(true);
  });
});

describe("an approval card's layout", () => {
  const cards = source("cards.tsx");
  const fn = (name: string) => {
    const start = cards.indexOf(`function ${name}(`);
    return cards.slice(start, cards.indexOf("\nfunction ", start + 1));
  };

  test("the buttons sit in one row (a grouped request's at its row's end), Aprovar, Aprovar sempre, Agora não, what it covers under them", () => {
    for (const name of ["ApprovalAsk", "ApprovalGroupItem"]) {
      const card = fn(name);
      const row = card.slice(card.indexOf("<View style={styles.itemActs}>"));
      expect([
        name,
        ascending(
          at(row, [
            'variant="primary"',
            "<ApproveAlwaysButton",
            't("approval.notNow")',
            "</View>",
            "<ApproveAlwaysHint",
          ]),
        ),
      ]).toEqual([name, true]);
      // Never a wide button stretched beside the text: each its own width, left-aligned in the row.
      expect([name, row.slice(0, row.indexOf("</View>")).includes(" wide")]).toEqual([name, false]);
    }
    expect(cards).toContain('itemActs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }');
    // A grouped request: its words and its buttons on one line while they fit, the buttons under the words otherwise.
    const item = fn("ApprovalGroupItem");
    expect(
      ascending(
        at(item, [
          "<View style={styles.itemWrap}>",
          "<View style={styles.itemText}>",
          "<View style={styles.itemActs}>",
        ]),
      ),
    ).toBe(true);
  });

  test("waiting requests of one kind in a row fold into one run: its head, Aprovar todos and Ver cada um", () => {
    const group = fn("ApprovalGroupAsk");
    for (const piece of [
      "approvalRuns(items)",
      't("approval.run.head"',
      't("approval.run.approve")',
      'label: t("approval.run.show")',
      "approveAlwaysAlso(items, a)",
    ])
      expect([piece, group.includes(piece)]).toEqual([piece, true]);
  });
});

describe("the secret card on the phone", () => {
  const card = source("SecretCard.tsx");

  test("people read its label: its internal name only binds the box", () => {
    expect(card.match(/\br\.name\b/g)).toHaveLength(1);
    expect(card).toContain("secretAad({ requestId: r.id, orgId, name: r.name, target: r.target })");
    expect(card).toContain("title: label");
    expect(card).toContain("accessibilityLabel={label}");
  });

  test("a refused send ends the card with the real reason and clears what was typed, unless only the computer is away", () => {
    const failed = card.slice(card.indexOf("const failed = async"), card.indexOf("const showNewer"));
    expect(failed.indexOf("secretRefusalKey(err)")).toBeLessThan(failed.indexOf("api.secrets.get(orgId, r.id)"));
    expect(failed).toContain("secretClosedBy(err, r, fresh)");
    expect(failed).toContain("done(closed)");
    expect(failed).toContain('t(fresh ? "secret.changed" : "secret.failed")');
    expect(card).toContain('if (!pending) setValue("");');
    expect(card).toContain('t("secret.seeNewer")');
  });

  test("where it goes and whose account wrap: only a well with a way to read the rest is cut", () => {
    const asks = source("asks.tsx");
    expect(asks).toContain("numberOfLines={well.more ? (open ? 3 : 1) : undefined}");
    expect(asks).toContain("numberOfLines={well.more ? 4 : undefined}");
  });
});
