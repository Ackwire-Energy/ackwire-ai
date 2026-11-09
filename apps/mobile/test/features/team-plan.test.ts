import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { answerAfter, answerPicks, BUSINESS_TYPES, replyChipsOf } from "@agenteschat/client/lib/team-plan";

const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");

test("what the workspace does: the onboarding's step 2, the business types saved as its context (ADR 0158)", () => {
  const step = src("onboarding/steps.tsx");
  expect(step).toContain("BUSINESS_TYPES.map((b) => (");
  expect(step).toContain("save.mutate({ context: text }");
  // The type and the sentence go together and come back together, as on the web (`aboutContext`, `aboutOf`).
  expect(step).toContain("const text = aboutContext(t, kind, line);");
  expect(step).toContain("useState(() => aboutOf(t, context).line)");
  expect(src("onboarding/OnboardingFlow.tsx")).toContain('t("agentSetup.firstRun.about.title", { org: workspace })');
  // The setup card's own screen for it is gone: the onboarding asks it once.
  expect(src("agents/setup/SetupStepScreen.tsx")).not.toContain("BUSINESS_TYPES");
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

test("the team card's agents, the first tasks and the map's agents are MediaRows: no face owning a column", () => {
  const card = src("right-hand/TeamCard.tsx");
  // The team: face, name and role on one line; what it does, its channel and Ajustar under them.
  expect(card).toContain(
    "face={<AgentAvatar agent={fullLook(a.appearance)} size={MEDIA_ROW.card.face} name={a.name} live={false} />}",
  );
  expect(card).toMatch(/name=\{a\.name\}\s*meta=\{a\.role\}\s*>\s*<Text variant="small" tone="ink2">\s*\{a\.line\}/);
  // A first task: the task under the name, Abrir com a tarefa under it.
  expect(card).toMatch(/name=\{f\.name\}\s*>\s*<Text variant="small" tone="ink2">\s*\{f\.task\}/);
  // The map: a list row (24), the routines under the name.
  expect(card).toMatch(/<MediaRow\s+key=\{a\.handle\}\s+size="row"/);
  expect(card).toContain(
    "<AgentAvatar agent={fullLook(a.appearance)} size={MEDIA_ROW.row.face} name={a.name} live={false} />",
  );
  expect(card.match(/<MediaRow/g)).toHaveLength(3);
  // No row of a face beside a column of words is left.
  expect(card).not.toContain("agentHead");
  expect(card).not.toContain("size={28}");
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
