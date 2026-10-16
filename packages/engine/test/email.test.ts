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
      reply: () => ({ chunks: [], toolUses: [{ name: "github_merge_pr", input: { repo: "a/b", pr: 1 } }] }),
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
