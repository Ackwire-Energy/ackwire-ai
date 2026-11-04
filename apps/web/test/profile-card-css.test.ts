import { expect, test } from "bun:test";
import path from "node:path";
import { declarations } from "./built-css";

const ROOT = path.join(import.meta.dir, "../../..");
const sheet = (file: string) => Bun.file(path.join(ROOT, file)).text();
const last = (pairs: (readonly [string, string])[], property: string) => pairs.findLast(([p]) => p === property)?.[1];

test("a chip under an agent's names keeps the card's row gap, never touching the line above", async () => {
  const layout = await sheet("apps/web/src/layout.css");
  const card = await sheet("apps/web/src/components/profile-card.css");
  const team = await sheet("apps/web/src/pages/team.css");
  // The member card: the chip is a row of the body (12px apart), at its own width.
  expect(last(declarations(card, ".mcard .profile-card__body"), "gap")).toBe("12px");
  expect(last(declarations(card, ".mcard .profile-card__body > :is(.noai-chip, .ac-chip)"), "align-self")).toBe(
    "flex-start",
  );
  expect(last(declarations(layout, ".profile-card__body"), "flex-direction")).toBe("column");
  // The team's card: 4px of the title's gap plus 4px, a section's 8px between its rows.
  expect(last(declarations(team, ".team-card__title"), "gap")).toBe("4px");
  expect(last(declarations(team, ".team-card__title > :is(.noai-chip, .ac-chip)"), "margin-top")).toBe("4px");
  expect(last(declarations(team, ".team-card__sec"), "gap")).toBe("8px");
});

test("the card's banner buttons are one round kind: the computer's and the ⋯", async () => {
  const card = await sheet("apps/web/src/components/profile-card.css");
  expect(last(declarations(card, ".mcard__act.ac-btn"), "border-radius")).toBe("var(--radius-full)");
  expect(last(declarations(card, ".mcard__acts"), "gap")).toBe("6px");
});
