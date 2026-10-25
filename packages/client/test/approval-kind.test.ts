import { describe, expect, test } from "bun:test";
import type { ApprovalEmail } from "../src/index";
import { emailTitleWords } from "../src/lib/approval-kind";
import { approvalOriginShort } from "../src/lib/approval-origin";

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
