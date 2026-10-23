import { afterEach, describe, expect, test } from "bun:test";
import { createFakeEmailSender, EmailError } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import {
  createJobHandlers,
  drainOutbox,
  grantScopes,
  postPersonMessage,
  queueApprovalDigests,
  queueBudgetEmail,
  queueEmail,
  renderEmail,
  sendQueuedEmail,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(() => f?.close());

describe("templates (pt-BR)", () => {
  test("invitation: escaped HTML with lang=pt-BR, a text version and the link", () => {
    const e = renderEmail({
      kind: "invitation",
      orgName: "Acme <script>",
      inviterName: "Ana",
      url: "https://x/invite/t",
      role: "member",
    });
    expect(e.subject).toBe("Ana convidou você para Acme <script> no agentes");
    expect(e.html).toContain('<html lang="pt-BR">');
    expect(e.html).toContain("Acme &lt;script&gt;");
    expect(e.html).not.toContain("<script>");
    expect(e.text).toContain("Aceitar convite: https://x/invite/t");
    expect(e.text).toContain("como membro");
  });

  test("waitlist confirmation: the agent's request, in their language, art from the link's origin", () => {
    const pt = renderEmail({
      kind: "waitlist_confirm",
      locale: "pt-BR",
      email: "ana@acme.com",
      url: "https://agentes.chat/?confirm=abc&x=<1>",
    });
    expect(pt.subject).toBe("Confirme seu lugar na lista do agentes.chat");
    expect(pt.html).toContain('<html lang="pt-BR">');
    expect(pt.html).toContain('src="https://agentes.chat/email/avatar.png"');
    expect(pt.html).toContain('href="https://agentes.chat/?confirm=abc&amp;x=&lt;1&gt;"');
    expect(pt.html).toContain("ana@acme.com");
    expect(pt.text).toContain("Confirmar meu e-mail: https://agentes.chat/?confirm=abc&x=<1>");
    expect(pt.text).toContain("Entrar na lista de espera (ana@acme.com)");
    const en = renderEmail({ kind: "waitlist_confirm", locale: "en", url: "https://agentes.chat/?confirm=abc" });
    expect(en.html).toContain('<html lang="en">');
    expect(en.text).toContain("Confirm my email: https://agentes.chat/?confirm=abc");
    expect(en.text).toContain("Join the waiting list\n");
  });

  test("budget and approval digest", () => {
    const b = renderEmail({
      kind: "budget",
      level: "warning",
      agentName: "Ada",
      orgName: "Acme",
      percent: 80.4,
      url: "u",
    });
    expect(b.subject).toBe("Ada usou 80% do orçamento do mês");
    // A percentage only: owners who aren't admins never see money.
    expect(b.text).toContain("usou 80% do orçamento deste mês");
    expect(b.text).not.toContain("US$");
    const d = renderEmail({
      kind: "approval_digest",
      orgName: "Acme",
      items: [{ agentName: "Ada", title: "Merge PR #42", ageHours: 5 }],
      url: "u",
    });
    expect(d.subject).toBe("1 pedido de aprovação esperando em Acme");
    expect(d.text).toContain("Ada: Merge PR #42 (há 5 h)");
  });
});

describe("templates in English (the recipient's locale)", () => {
  test("every kind has an English version with lang=en", () => {
    const invitation = renderEmail({
      kind: "invitation",
      locale: "en",
      orgName: "Acme",
      inviterName: "",
      url: "https://x/invite/t",
      role: "member",
    });
    expect(invitation.subject).toBe("Someone invited you to Acme on agentes");
    expect(invitation.html).toContain('<html lang="en">');
    expect(invitation.text).toContain("as member");
    expect(invitation.text).toContain("Accept invitation: https://x/invite/t");
    const budget = renderEmail({
      kind: "budget",
      locale: "en",
      level: "exhausted",
      agentName: "Ada",
      orgName: "Acme",
      percent: 100,
      url: "u",
    });
    expect(budget.subject).toBe("Ada reached this month's budget");
    const digest = renderEmail({
      kind: "approval_digest",
      locale: "en",
      orgName: "Acme",
      items: [
        { agentName: "Ada", title: "Merge PR #42", ageHours: 5 },
        { agentName: "", title: "Deploy", ageHours: 0.2 },
      ],
      url: "u",
    });
    expect(digest.subject).toBe("2 approval requests waiting in Acme");
    expect(digest.text).toContain("Ada: Merge PR #42 (5 h ago)");
    expect(digest.text).toContain("An agent: Deploy (1 h ago)");
    for (const t of [
      { kind: "password_reset" as const, locale: "en" as const, url: "u" },
      { kind: "verify_email" as const, locale: "en" as const, url: "u" },
      { kind: "invite_request" as const, locale: "en" as const, orgName: "Acme", email: "", url: "u" },
      {
        kind: "calendar_invite" as const,
        locale: "en" as const,
        orgName: "Acme",
        inviterName: "Ana",
        title: "Retro",
        when: "Oct 20, 2026, 9:00 AM",
        url: "u",
      },
    ]) {
      const e = renderEmail(t);
      expect(e.html).toContain('<html lang="en">');
      expect(e.text).not.toMatch(/você|convite|senha|e-mail/i);
    }
    // Jobs queued before locales existed stay pt-BR.
    expect(renderEmail({ kind: "verify_email", url: "u" }).subject).toBe("Confirme seu e-mail no agentes");
  });
});

describe("outbox delivery", () => {
  test("queued once per key, sent by the job with the key as idempotency key; permanent errors don't retry", async () => {
    f = await setup();
    const sender = createFakeEmailSender();
    const handlers = createJobHandlers({ ...f.jobDeps, email: sender });
    const input = {
      orgId: f.org.id,
      key: "k1",
      to: ["a@example.com"],
      template: { kind: "verify_email" as const, url: "u" },
    };
    await queueEmail(f.db, input);
    await queueEmail(f.db, input);
    await queueEmail(f.db, { ...input, orgId: null, key: "k2" });
    await drainOutbox(f.db, handlers);
    expect(sender.sent.map((m) => m.idempotencyKey).sort()).toEqual(["k1", "k2"]);
    const failing = { id: "x", delivers: true, send: async () => Promise.reject(new EmailError("bad", false, 422)) };
    await expect(sendQueuedEmail(failing, { key: "k", to: ["a@b.c"], template: input.template })).rejects.toThrow(
      "bad",
    );
  });

  test("budget email once per agent, month and level", async () => {
    f = await setup();
    const e = { agent: { ...f.agent }, level: "warning" as const, spentNanoUsd: 8e9, budgetNanoUsd: 10e9 };
    await queueBudgetEmail(f.db, "https://chat.example.com", e);
    await queueBudgetEmail(f.db, "https://chat.example.com", e);
    const jobs = (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "email.send");
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0]?.payload)).toContain(`/org/${f.org.id}/agents/${f.agent.id}`);
  });

  test("approval digest: one email per approver for requests waiting too long, never twice", async () => {
    const gh = fakeGithub();
    f = await setup({
      toolSources: [gh.source],
      reply: () => ({
        chunks: [],
        toolUses: [
          {
            name: "github_merge_pr",
            input: { repo: "a/b", pr: 1, why: "CI passed and the review is done: merging ships the fix today." },
          },
        ],
      }),
    });
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    await addMember(f.db, f.org.id, "admin", "bia");
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev merge" });
    await drainOutbox(f.db, f.handlers);
    const later = new Date(Date.now() + 5 * 3600_000);
    expect(await queueApprovalDigests(f.db, "https://x", 4)).toBe(0);
    expect(await queueApprovalDigests(f.db, "https://x", 4, later)).toBe(2); // owner + admin
    expect(await queueApprovalDigests(f.db, "https://x", 4, later)).toBe(0);
  });
});
