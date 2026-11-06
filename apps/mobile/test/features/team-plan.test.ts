import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { answerAfter, answerPicks, BUSINESS_TYPES, replyChipsOf } from "@agenteschat/client/lib/team-plan";

const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");

test("the start card asks what the workspace does with business types as chips, the old ways in under them", () => {
  const intro = src("right-hand/Intro.tsx");
  expect(intro).toContain("BUSINESS_TYPES.map((b) => t(`teamPlan.business.$" + "{b}`))");
  expect(intro).toContain('t("teamPlan.start.question", { org: org?.name ?? "" })');
  for (const key of ["teamPlan.start.templates", "teamPlan.start.presets", "rightHand.intro.start.import"])
    expect(intro).toContain(`t("${key}")`);
  // "Outra coisa" writes in the composer instead of sending.
  expect(intro).toContain('text === other ? requestComposerText(channelId, "") : send(text)');
  expect(intro).toContain("<TeamTemplatesSheet");
  expect(BUSINESS_TYPES.at(-1)).toBe("other");
});

test("a conversation draws the team card and the answers to tap under a right hand's question", () => {
  const row = src("chat/MessageRow.tsx");
  expect(row).toContain("{isAgent ? <TeamCard message={m} /> : null}");
  expect(row).toContain("{isAgent ? <ReplyChips message={m} /> : null}");
  const card = src("right-hand/TeamCard.tsx");
  for (const key of [
    "teamPlan.card.create",
    "teamPlan.card.map",
    "rightHand.card.dismiss",
    "teamPlan.card.adjustName",
    "teamPlan.firstTask.open",
    "teamPlan.templates.use",
    "agentActions.undo",
  ])
    expect(card).toContain(`"${key}"`);
  // A team card's changes reach the open conversation.
  expect(src("chat/live.ts")).toContain('case "team.proposal.updated":');
});

test("the chips read their answer from the conversation, as on the web", () => {
  const list = [
    { id: "q", createdAt: "2026-11-04T12:00:00.000Z", author: { type: "agent" as const, id: "lodi" }, body: "?" },
    {
      id: "p",
      createdAt: "2026-11-04T12:01:00.000Z",
      author: { type: "person" as const, id: "me" },
      body: "Bugs · Cobrar",
    },
  ];
  const chips = replyChipsOf({ replyChips: { choices: ["Cobrar", "Bugs", "Vender"], multiple: true, step: 2, of: 3 } });
  expect(chips?.step).toBe(2);
  expect(answerPicks(chips?.choices ?? [], answerAfter(list, "q"))).toEqual(["Cobrar", "Bugs"]);
});
