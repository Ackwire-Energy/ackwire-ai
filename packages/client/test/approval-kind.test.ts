import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { ApiError, type ApprovalEmail } from "../src/index";
import { emailTitleWords } from "../src/lib/approval-kind";
import { approvalOriginShort } from "../src/lib/approval-origin";
import {
  actionName,
  approvalRuleWords,
  approvalSummary,
  approvalValues,
  approveAlwaysWords,
} from "../src/lib/approval-words";
import { knownErrorText } from "../src/lib/errors";

const email = (over: Partial<ApprovalEmail> = {}): ApprovalEmail => ({
  verb: "draft",
  mailbox: "support@acme.com",
  provider: "iCloud",
  from: "support@acme.com",
  to: ["ana@acme.com"],
  cc: [],
  bcc: [],
  subject: "Re: Question",
  body: "Thanks!",
  original: { subject: "Question", from: "ana@acme.com" },
  ...over,
});

describe("a mail approval in words", () => {
  test("a reply draft, a draft, a draft to nobody yet", () => {
    expect(emailTitleWords(email())).toEqual({
      key: "approval.email.title.draftReply",
      values: { to: "ana@acme.com", count: 1, more: 0 },
    });
    expect(emailTitleWords(email({ original: null })).key).toBe("approval.email.title.draft");
    expect(emailTitleWords(email({ to: [] })).key).toBe("approval.email.title.draftNoTo");
  });

  test("sends count everyone it goes to", () => {
    expect(
      emailTitleWords(email({ verb: "send", original: null, cc: ["bia@acme.com"], bcc: ["boss@acme.com"] })),
    ).toEqual({ key: "approval.email.title.send", values: { to: "ana@acme.com", count: 3, more: 2 } });
    expect(emailTitleWords(email({ verb: "reply" })).key).toBe("approval.email.title.reply");
  });

  test("where it came from, short", () => {
    expect(approvalOriginShort({ origin: { kind: "routine", routineId: "r", routineName: "Vigiar e-mails" } })).toEqual(
      {
        key: "approval.originShort.routine",
        values: { name: "Vigiar e-mails" },
      },
    );
    expect(approvalOriginShort({ origin: { kind: "unattended" } })?.key).toBe("approval.originShort.unattended");
    expect(approvalOriginShort({ origin: null })).toBeNull();
  });
});

describe("Aprovar sempre in words", () => {
  /** No translations: each word falls back to the default the code gives, else its key. */
  const t = ((key: string, o?: { defaultValue?: string }) =>
    o && "defaultValue" in o ? o.defaultValue : key) as unknown as TFunction;

  test("an action's slug without its articles, its app after it; the tool itself when it wraps none", () => {
    expect(actionName(t, "GITHUB_CREATE_AN_ISSUE_COMMENT")).toBe("Create issue comment (Github)");
    expect(approveAlwaysWords(t, { approveAlways: { tool: "X", actions: ["GITHUB_ADD_A_LABEL", "SLACK_X"] } })).toBe(
      "Add label (Github), X (Slack)",
    );
    expect(approveAlwaysWords(t, { approveAlways: { tool: "close_ticket", actions: [] } })).toBe("Close ticket");
    expect(approveAlwaysWords(t, { approveAlways: null })).toBe("");
    expect(approvalRuleWords(t, { tool: "close_ticket", action: "", toolLabel: "Fechar chamado" })).toBe(
      "Fechar chamado",
    );
  });

  test("a remembered push says its branch and repository, never a slug made of them", () => {
    const say = ((key: string, o?: Record<string, unknown>) => `${key} ${JSON.stringify(o)}`) as unknown as TFunction;
    const words = 'approval.always.pushTo {"repo":"acme/app","branch":"ana/fix"}';
    expect(
      approveAlwaysWords(say, { approveAlways: { tool: "request_branch_push", actions: ["acme/app:ana/fix"] } }),
    ).toBe(words);
    expect(approvalRuleWords(say, { tool: "request_branch_push", action: "acme/app:ana/fix", toolLabel: "x" })).toBe(
      words,
    );
  });

  test("where it isn't offered, the refusal in the person's words", () => {
    const refusal = new ApiError(409, "approval.always_unavailable", "This request can't be approved for good");
    expect(knownErrorText(t, refusal)).toBe("errors.approval.alwaysUnavailable");
  });
});

describe("an approval's values", () => {
  test("its summary tells two requests for one tool apart: labeled values, numbers in the locale's format", () => {
    const goal = (month: string) => ({
      params: { role: "seller", month, revenue_goal: 97000.5, year: 2026 },
      connector: "panel",
      email: null,
    });
    expect(approvalSummary(goal("2026-10"), "pt-BR")).toBe(
      "Role: seller · Month: 2026-10 · Revenue goal: 97.000,5 · Year: 2026",
    );
    expect(approvalSummary(goal("2026-11"), "en")).toBe(
      "Role: seller · Month: 2026-11 · Revenue goal: 97,000.5 · Year: 2026",
    );
    expect(approvalSummary({ params: { a: 1, b: 2, c: 3, d: 4, e: 5 }, connector: "x" }, "en")).toBe(
      "A: 1 · B: 2 · C: 3 · D: 4",
    );
  });

  test("a list of names is one value: whole in the details, cut on a card, never left out", () => {
    const branches = ["feat/login-google", "fix/old-header", "chore/bump-deps", "spike/x", "feat/y", "old-1", "old-2"];
    const a = { params: { repo: "acme/app", branches }, connector: "github", email: null };
    expect(approvalValues(a, { long: true })).toEqual([
      ["Repo", "acme/app"],
      ["Branches", branches.join(", ")],
    ]);
    const [, card] = approvalValues(a);
    expect(card?.[0]).toBe("Branches");
    expect(card?.[1]).toHaveLength(60);
    expect(card?.[1].startsWith("feat/login-google, fix/old-header, chore/bump-deps")).toBe(true);
    expect(card?.[1].endsWith("…")).toBe(true);
    expect(approvalValues({ params: { repo: "acme/app", branches: ["a", "b"] }, connector: "github" })).toEqual([
      ["Repo", "acme/app"],
      ["Branches", "a, b"],
    ]);
    // A list of objects still says nothing.
    expect(approvalValues({ params: { tools: [{ slug: "X" }] }, connector: "x" })).toEqual([]);
  });
});
