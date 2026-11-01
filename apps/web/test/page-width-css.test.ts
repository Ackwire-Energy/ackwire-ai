import { expect, test } from "bun:test";
import { builtCss, declarations, topLevel } from "./built-css";

const css = topLevel(
  await builtCss(
    "src/styles.css",
    "src/pages/wiki.css",
    "src/pages/issues.css",
    "src/pages/forum.css",
    "src/pages/routines.css",
    "src/pages/team.css",
    "src/components/missions/missions.css",
  ),
);
const maxWidth = (selector: string) => declarations(css, selector).findLast(([p]) => p === "max-width")?.[1] ?? "none";

test("pages use the width they have: no column capped short of the work area, sidebar open or collapsed", () => {
  for (const selector of [
    // The wiki: home, a page read and edited (its side column sits at the right edge), the graph, the text.
    ".wiki-home",
    ".wiki-doc",
    ".wiki-doc[data-editing]",
    ".wiki-graph",
    ".wiki-prose .md",
    // Rendered Markdown anywhere (a Drive report, a skill, the wiki), as a message's words already are.
    ".md",
    // Lists (Threads, Aprovações, Notificações), Drive, tasks, the forum and a topic, routines, the team.
    ".page--list",
    ".drive",
    ".issues",
    ".issue-description",
    ".forum",
    ".forum-topic",
    ".forum-topic__main",
    ".forum-th__goal",
    ".routines",
    ".page.team",
    // A task's page, proposals, an agent's memory, search results.
    ".page--full",
    ".mi-q p",
  ])
    expect([selector, maxWidth(selector)]).toEqual([selector, "none"]);
});

test("what is narrow on purpose stays narrow: forms, empty states and the Terms' reading column", () => {
  expect(maxWidth(".page")).toBe("920px");
  expect(maxWidth(".page--narrow")).toBe("720px");
  expect(maxWidth(".page--mid")).toBe("860px");
  expect(maxWidth(".settings")).toBe("1120px");
  expect(maxWidth(".newag__content")).toBe("660px");
});
