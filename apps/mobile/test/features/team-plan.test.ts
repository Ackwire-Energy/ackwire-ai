import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { answerAfter, answerPicks, BUSINESS_TYPES, replyChipsOf } from "@agenteschat/client/lib/team-plan";

const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");

test("row 1 asks what the workspace does with the business types, then opens their template (ADR 0153 §6)", () => {
  const about = src("agents/setup/SetupStepScreen.tsx");
  expect(about).toContain("BUSINESS_TYPES.map((b) => (");
  expect(about).toContain('t("agentSetup.firstRun.about.title", { org: org?.name ?? "" })');
  expect(about).toContain("{ context: text }");
  expect(about).toContain("openTemplatesAfterAbout(business && isTemplateBusiness(business) ? business : undefined)");
  const run = src("right-hand/FirstRun.tsx");
  expect(run).toContain("<TeamTemplatesSheet");
  expect(run).toContain("initial={templates?.initial}");
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
    "teamPlan.templates.create",
    "teamPlan.templates.import",
    "teamPlan.templates.scratch",
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
