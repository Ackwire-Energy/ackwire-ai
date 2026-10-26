import { expect, test } from "bun:test";
import { plainLines } from "../src/lib/markdown";
import { emailTypoFix, excerpt, webmailOf } from "../src/lib/text";

test("a misspelled webmail domain gets one fix; anything else is left alone", () => {
  expect(emailTypoFix("Marina@Gmial.com ")).toBe("marina@gmail.com");
  expect(emailTypoFix("ana@hotmail.con")).toBe("ana@hotmail.com");
  expect(emailTypoFix("ana@uol.com")).toBe("ana@uol.com.br");
  expect(emailTypoFix("ana@gmail.com")).toBeNull();
  expect(emailTypoFix("ana@acme.com.br")).toBeNull();
  expect(emailTypoFix("ana")).toBeNull();
  expect(emailTypoFix("a@b@gmial.com")).toBeNull();
});

test("the webmail to open after sending an e-mail", () => {
  expect(webmailOf("ana@gmail.com")?.name).toBe("Gmail");
  expect(webmailOf("ana@hotmail.com")?.name).toBe("Outlook");
  expect(webmailOf("ana@icloud.com")?.name).toBe("iCloud Mail");
  expect(webmailOf("ana@yahoo.com.br")?.name).toBe("Yahoo Mail");
  expect(webmailOf("ana@acme.com.br")).toBeNull();
});

test("a text's start: whole sentences and lines while they fit, never a stop before the ellipsis", () => {
  const ada =
    "Investigates first: reads the code and the related tasks and errors before answering, and comes back with what it found and a concrete PR proposal with a test.\nWorks in branches and opens small PRs; for big changes opens the PR as a draft and explains the plan there.\nNever merges alone: asks a person for review.";
  const start = excerpt(ada, 280);
  expect(start).toEndWith("explains the plan there.");
  expect(start.split("\n")).toHaveLength(2);
  expect(start).not.toContain("…");
  // Short enough: the whole text, as it is.
  expect(excerpt("  Answers support tickets.  ", 280)).toBe("Answers support tickets.");
  // A line with no full stop ends where the line does; a list's items are lines without their marks.
  expect(excerpt("- Reads the tickets\n- Answers with sources\n- Hands off refunds to a person", 45)).toBe(
    "Reads the tickets\nAnswers with sources",
  );
  // Never more than its lines, however short they are.
  const list = Array.from({ length: 10 }, (_, i) => `${i + 1}. Step ${i + 1}`).join("\n");
  expect(excerpt(list, 280)).toBe("Step 1\nStep 2\nStep 3");
  expect(excerpt(list, 280, 1)).toBe("Step 1");
  // One sentence longer than the room: cut at a word, the mark after it, never after a comma.
  expect(excerpt("Reads every ticket, the customer's history and the help center before it answers", 40)).toBe(
    "Reads every ticket, the customer's…",
  );
  // A number's dot isn't a sentence's end.
  expect(excerpt("Keeps version 2.5 of the API working until March and then moves everyone to 3.0 for good", 30)).toBe(
    "Keeps version 2.5 of the API…",
  );
});

test("instructions in Markdown read as plain words: past headings and rules, without marks", () => {
  const soul = [
    "# SOUL.md - Who You Are",
    "",
    "_You're not a chatbot. You're becoming someone._",
    "",
    "## Core Truths",
    "",
    '**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" and just help. Actions speak louder than filler words.',
    "",
    "**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring.",
    "",
    "---",
    "",
    "Read the [style guide](https://example.com/guide) first.",
  ].join("\n");
  const page = excerpt(soul, 280);
  expect(page).toStartWith("You're not a chatbot. You're becoming someone.\nBe genuinely helpful, not performatively");
  expect(page).toEndWith("amusing or boring.");
  expect(page).not.toMatch(/[#_*…]/);
  expect(excerpt(soul, 240)).toEndWith("filler words.\nHave opinions.");
  // The team card's line: the first one, in whole sentences.
  expect(excerpt(soul, 160, 1)).toBe("You're not a chatbot. You're becoming someone.");
  expect(plainLines(soul).at(-1)).toBe("Read the style guide first.");
  expect(
    plainLines(
      "> Run `pg_query` on my_table, see ![the map](map.png) and [[Processos/Onboarding|o onboarding]].\n\n```\nrm -rf /\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
    ),
  ).toEqual(["Run pg_query on my_table, see the map and o onboarding."]);
});
