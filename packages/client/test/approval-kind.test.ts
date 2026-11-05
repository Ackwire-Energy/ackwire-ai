import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import { LOCALE_CODES } from "@agenteschat/i18n/locale";
import { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import i18next from "i18next";
import { ApiError, type Approval, type ApprovalEmail, cacheApproval, keys } from "../src/index";
import { aheadPhase, emailTitleWords } from "../src/lib/approval-kind";
import { approvalOriginShort } from "../src/lib/approval-origin";
import {
  actionName,
  aheadEndLine,
  approvalGroupWaitsFor,
  approvalRuleServer,
  approvalRuleWords,
  approvalSummary,
  approvalTitle,
  approvalValues,
  approvalWaitsFor,
  approveAlwaysHint,
  approveAlwaysWords,
  ownActionName,
  requesterDecidesLine,
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
      values: { to: "ana@acme.com", more: 0 },
    });
    expect(emailTitleWords(email({ original: null })).key).toBe("approval.email.title.draft");
    expect(emailTitleWords(email({ to: [] })).key).toBe("approval.email.title.draftNoTo");
  });

  test("sends count everyone it goes to", () => {
    expect(
      emailTitleWords(email({ verb: "send", original: null, cc: ["bia@acme.com"], bcc: ["boss@acme.com"] })),
    ).toEqual({ key: "approval.email.title.sendMore", values: { to: "ana@acme.com", more: 2 } });
    expect(emailTitleWords(email({ verb: "reply" })).key).toBe("approval.email.title.reply");
  });

  test("one recipient never reads 'and 0 more', in any language", () => {
    for (const lng of LOCALE_CODES) {
      const instance = i18next.createInstance();
      void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
      for (const verb of ["send", "reply", "forward"] as const) {
        const one = emailTitleWords(email({ verb }));
        const two = emailTitleWords(email({ verb, cc: ["bia@acme.com"] }));
        const say = (w: typeof one) => String(instance.t(w.key, w.values as never));
        expect({ lng, verb, one: /\d/.test(say(one)) }).toEqual({ lng, verb, one: false });
        expect({ lng, verb, two: say(two).includes("1") }).toEqual({ lng, verb, two: true });
      }
    }
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
    expect(ownActionName(t, "GITHUB_CREATE_AN_ISSUE_COMMENT")).toBe("Create issue comment (Github)");
    expect(ownActionName(t, "close_ticket")).toBe("Close ticket");
    expect(approvalRuleWords(t, { tool: "close_ticket", action: "", toolLabel: "Fechar chamado" })).toBe(
      "Fechar chamado",
    );
  });

  test("a command kept for the agent says the command; its rule is the agent's computer's", () => {
    const say = ((key: string, o?: Record<string, unknown>) =>
      `${key} ${JSON.stringify(o ?? {})}`) as unknown as TFunction;
    const approval = { approveAlways: { tool: "command", actions: ["gh issue create"] } };
    expect(approveAlwaysWords(say, approval)).toBe("gh issue create");
    expect(approveAlwaysHint(say, approval, "Ada")).toBe(
      'approval.always.noteCommand {"name":"Ada","context":"female","actions":"gh issue create","target":""}',
    );
    const rule = { tool: "command", action: "gh issue create", toolLabel: "command", connectionId: null, server: null };
    expect(approvalRuleWords(say, rule)).toBe("gh issue create");
    expect(approvalRuleServer(say, rule)).toBe("approval.always.computer {}");
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

  test("on an engine whose Intl takes useGrouping as a boolean (Hermes), a year still reads as is", () => {
    const Real = Intl.NumberFormat;
    function hermes(locale?: string | string[], options?: Intl.NumberFormatOptions) {
      return new Real(locale, options && { ...options, useGrouping: Boolean(options.useGrouping ?? true) });
    }
    Intl.NumberFormat = hermes as unknown as typeof Intl.NumberFormat;
    try {
      expect(approvalSummary({ params: { year: 2026, revenue: 97000 }, connector: "x" }, "pt-BR")).toBe(
        "Year: 2026 · Revenue: 97.000",
      );
    } finally {
      Intl.NumberFormat = Real;
    }
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

describe("an approval's title", () => {
  const lang = (lng: string) => {
    const instance = i18next.createInstance();
    void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
    return instance.t;
  };
  const pt = lang("pt-BR");
  const en = lang("en");
  const comment = { tool: "add_issue_comment", params: {}, email: null, connector: "github" };

  test("a server title that is only the tool's name reads as the tool in words, bare or after the connector", () => {
    expect(approvalTitle(pt, { ...comment, title: "GitHub: add_issue_comment" })).toBe(
      "Adicionar comentários da issue",
    );
    expect(approvalTitle(pt, { ...comment, title: "add_issue_comment" })).toBe("Adicionar comentários da issue");
    expect(approvalTitle(en, { ...comment, title: "GitHub: add_issue_comment" })).toBe("Add issue comments");
  });

  test("a real title stays as the server wrote it", () => {
    expect(
      approvalTitle(pt, { tool: "merge_pull_request", title: "Merge PR #42 into main", params: {}, email: null }),
    ).toBe("Merge PR #42 into main");
    // Another tool's name after the connector isn't this tool's identifier.
    expect(approvalTitle(pt, { ...comment, title: "GitHub: comment" })).toBe("GitHub: comment");
  });
});

describe("an action prepared ahead", () => {
  test("asks, waits for its time once approved, then ran, or how it ended; nothing for one that runs once approved", () => {
    const runAt = "2026-11-03T13:00:00.000Z";
    const decidedAt = "2026-11-02T18:00:00.000Z";
    const at = (status: Approval["status"], over: Partial<Approval> = {}) =>
      aheadPhase({ runAt, status, executedAt: null, decidedAt: null, ...over });
    expect(at("pending")).toBe("asking");
    expect(at("approved", { decidedAt })).toBe("scheduled");
    expect(at("approved", { decidedAt, executedAt: "2026-11-03T13:00:04.000Z" })).toBe("ran");
    // Approved but its run didn't do it in time, nobody approved it by then, withdrawn: each says so.
    expect(at("expired", { decidedAt })).toBe("lapsed");
    expect(at("expired")).toBe("unapproved");
    expect(at("canceled", { decidedAt })).toBe("canceled");
    const say = ((key: string) => key) as unknown as TFunction;
    expect(aheadEndLine(say, { runAt, status: "expired", executedAt: null, decidedAt })).toBe("approval.ahead.lapsed");
    expect(aheadEndLine(say, { runAt, status: "approved", executedAt: null, decidedAt })).toBeNull();
    expect(at("refused", { decidedAt })).toBeNull();
    expect(aheadPhase({ runAt: null, status: "approved", executedAt: null, decidedAt })).toBeNull();
    expect(aheadPhase({ status: "pending", executedAt: null, decidedAt: null })).toBeNull();
  });

  test("news about one (it ran, it was withdrawn) makes its routine's page read again", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.routines("o1"), []);
    const ran = { id: "a1", status: "approved", executedAt: "2026-11-03T13:00:04.000Z" } as Approval;
    cacheApproval(qc, "o1", { ...ran, routineId: null });
    expect(qc.getQueryState(keys.routines("o1"))?.isInvalidated).toBe(false);
    cacheApproval(qc, "o1", { ...ran, routineId: "r1", runAt: "2026-11-03T13:00:00.000Z" });
    expect(qc.getQueryState(keys.routines("o1"))?.isInvalidated).toBe(true);
  });
});

describe("approvals an agent asked of named people (ADR 0126)", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  const asked = { label: "Diretoria", requestedByUserId: "bia", requesterDecides: true };

  test("waits for the people asked, else the agent's owner", () => {
    expect(approvalWaitsFor({ approvers: asked }, "Ana")).toBe("Diretoria");
    expect(approvalWaitsFor({ approvers: null }, "Ana")).toBe("Ana");
  });

  test("a shared card names everyone its waiting requests wait for", () => {
    const pending = "pending" as const;
    expect(
      approvalGroupWaitsFor(
        [
          { approvers: asked, status: pending },
          { approvers: null, status: pending },
        ],
        "Ana",
      ),
    ).toBe("Diretoria, Ana");
    expect(
      approvalGroupWaitsFor(
        [
          { approvers: asked, status: pending },
          { approvers: asked, status: pending },
        ],
        "Ana",
      ),
    ).toBe("Diretoria");
    expect(
      approvalGroupWaitsFor(
        [
          { approvers: asked, status: "approved" },
          { approvers: null, status: pending },
        ],
        "Ana",
      ),
    ).toBe("Ana");
  });

  test("says the requester decides only while it waits or once they decided it", () => {
    const line = (over: Partial<Pick<Approval, "status" | "decidedByUserId" | "approvers">>) =>
      requesterDecidesLine(t, { status: "pending", decidedByUserId: null, approvers: asked, ...over });
    expect(line({})).toBe("approval.requesterDecides");
    expect(line({ status: "approved", decidedByUserId: "bia" })).toBe("approval.requesterDecides");
    expect(line({ status: "approved", decidedByUserId: "carla" })).toBeNull();
    expect(line({ approvers: { ...asked, requesterDecides: false } })).toBeNull();
  });
});
