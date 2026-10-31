import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { ApiError, type ApprovalEmail } from "../src/index";
import { emailTitleWords } from "../src/lib/approval-kind";
import { approvalOriginShort } from "../src/lib/approval-origin";
import { actionName, approvalRuleWords, approveAlwaysWords } from "../src/lib/approval-words";
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
    expect(approvalRuleWords(t, { action: "", toolLabel: "Fechar chamado" })).toBe("Fechar chamado");
  });

  test("where it isn't offered, the refusal in the person's words", () => {
    const refusal = new ApiError(409, "approval.always_unavailable", "This request can't be approved for good");
    expect(knownErrorText(t, refusal)).toBe("errors.approval.alwaysUnavailable");
  });
});
