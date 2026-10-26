import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createFakeEmailSender, EmailError } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  createJobHandlers,
  defaultEmailFrom,
  drainOutbox,
  type EmailArt,
  type EmailTemplate,
  emailArtAt,
  emailArtFor,
  grantScopes,
  postPersonMessage,
  queueApprovalDigests,
  queueBudgetEmail,
  queueEmail,
  queueInvitationEmail,
  renderEmail,
  sendQueuedEmail,
} from "../src";
import { BREAK } from "../src/email/inert";
import { EMAIL_SAMPLES } from "./email-samples";
import { addMember, type Fixture, setup } from "./fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const art = emailArtAt("https://x.test");
const WEB_DIR = resolve(import.meta.dir, "../../../apps/web/public");
/** Every field people type or agents write. */
const TYPED = [
  "orgName",
  "inviterName",
  "inviterEmail",
  "email",
  "title",
  "agentName",
  "name",
  "approverName",
  "reason",
];
const SENTINEL = "Zq9 evil.com";
const withoutUrls = (s: string) => s.replace(/https?:\/\/\S+/g, "");
const buttons = (t: EmailTemplate) =>
  [...renderEmail(t, art).html.matchAll(/<a class="btn" href="([^"]*)"[^>]*>.*?<span[^>]*>([^<]*)<\/span>/g)].map(
    (m) => ({ url: (m[1] ?? "").replaceAll("&amp;", "&"), label: m[2] ?? "" }),
  );

function poisoned(t: EmailTemplate, value = SENTINEL): EmailTemplate {
  const o = structuredClone(t) as Record<string, unknown>;
  for (const k of TYPED) if (typeof o[k] === "string") o[k] = value;
  if (Array.isArray(o.items)) o.items = o.items.map((i) => ({ ...i, agentName: value, title: value }));
  return o as EmailTemplate;
}

describe("every email, in both languages", () => {
  for (const [id, sample] of Object.entries(EMAIL_SAMPLES)) {
    for (const locale of ["en", "pt-BR"] as const) {
      const t = { ...sample, locale } as EmailTemplate;
      test(`${id} in ${locale}`, () => {
        const e = renderEmail(t, art);
        expect(e.html).toContain(`<html lang="${locale}"`);
        expect(e.preheader.length).toBeGreaterThanOrEqual(10);
        expect(e.html).toMatch(
          new RegExp(
            `<body[^>]*>\\n<div style="[^"]*">${e.preheader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "&#39;")}`,
          ),
        );
        expect(e.text.startsWith(e.html.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1]?.replaceAll("&#39;", "'") ?? "?")).toBe(
          true,
        );
        for (const b of buttons(t)) expect(e.text).toContain(`${b.label}: ${b.url}`);
        expect(`${e.subject}${e.html}${e.text}`).not.toMatch(/undefined|null|\{\w+\}/);
        expect(e.html.length).toBeLessThan(60_000);
        for (const [, css = ""] of e.html.matchAll(/<style>([\s\S]*?)<\/style>/g))
          expect(css.length).toBeLessThan(8_000);
        // The other language never leaks in (a reset link holds "password").
        expect(withoutUrls(e.text)).not.toMatch(
          locale === "en" ? /você|convite|senha|e-mail/i : /\b(you|invitation|password)\b/i,
        );
        // Our words only in the subject, preheader, headline and buttons; typed words inert in the body.
        const p = renderEmail(poisoned(t), art);
        for (const s of [p.subject, p.preheader, p.html.match(/<h1[^>]*>([^<]*)</)?.[1] ?? ""]) {
          expect(s).not.toContain("Zq9");
        }
        for (const b of buttons(poisoned(t))) expect(b.label).not.toContain("Zq9");
        expect(p.html).not.toContain("evil.com");
        expect(p.text).not.toContain("evil.com");
        // No em dashes or semicolons in our words.
        expect([e.subject, e.preheader, e.text].join("\n")).not.toMatch(/—|;/);
      });
    }
    test(`${id}: snapshot`, () => {
      expect(renderEmail(sample, art).html).toMatchSnapshot();
    });
  }
});

describe("the look", () => {
  const verify = EMAIL_SAMPLES["verify_email.en"] as EmailTemplate;

  test("dark: our design where clients apply an email's own, the Gmail apps kept light, the bone logo hidden from classic Outlook", () => {
    const { html } = renderEmail(verify, art);
    expect(html).toContain('<meta name="color-scheme" content="light only">');
    expect(html).toContain(":root{color-scheme:light dark;");
    expect(html).toContain("@media (prefers-color-scheme:dark){.bg{background:#0f0f0e!important}");
    expect(html).toContain("[data-ogsb] .logo-ink{display:none!important}");
    expect(html).toContain('<!--[if !mso]><!--><img class="logo-bone"');
  });

  test("the preheader is hidden by display alone, never coloured like the page", () => {
    expect(renderEmail(verify, art).html).toContain(
      '<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all">One click to confirm',
    );
  });

  test("typed text is escaped and can't link, in both parts", () => {
    const e = renderEmail(
      {
        kind: "invitation",
        locale: "en",
        orgName: "Acme <script>",
        inviterName: "evil.com",
        url: "https://x/i",
        role: "member",
      },
      art,
    );
    expect(e.html).toContain("Acme &lt;script&gt;");
    expect(e.html).not.toContain("<script>");
    expect(e.text).toContain("Acme <script>");
    for (const part of [e.html, e.text]) {
      expect(part).not.toContain("evil.com");
      expect(part).toContain(`evil.${BREAK}com`);
    }
  });

  test("a long token in a typed title breaks, so it can't widen the card on a phone", () => {
    const { text } = renderEmail(EMAIL_SAMPLES["approval_digest-many.en"] as EmailTemplate, art);
    const line = text.split("\n").find((l) => l.startsWith("Atlas")) ?? "";
    expect(line).toContain("3f2a9c1e");
    expect(line).not.toMatch(/\S{31}/u);
    // "4 h ago" stays on one line.
    expect(line).toEndWith(" · 4\u00a0h\u00a0ago");
  });

  test("a long typed word wraps where it lands instead of widening the card, and never breaks a label", () => {
    const word = "W".repeat(30);
    const holders = new Set<string>();
    for (const sample of Object.values(EMAIL_SAMPLES)) {
      const { html } = renderEmail(poisoned(sample as EmailTemplate, word), art);
      for (const { index } of html.matchAll(new RegExp(word, "g"))) {
        const before = html.slice(0, index);
        const start = Math.max(before.lastIndexOf("<p "), before.lastIndexOf("<td "));
        const tag = html.slice(start, html.indexOf(">", start) + 1);
        expect(tag).toContain("word-break:break-word");
        holders.add(tag.slice(0, tag.indexOf(" style=")));
      }
      // With it, the table could squeeze a fact's label mid-word to make room for a long value.
      expect(html).not.toMatch(/<td class="mu[^>]*word-break/);
    }
    // Paragraphs, facts (first row and the rest), people's names and details, a note (a denial's reason), and the
    // footer.
    expect(holders.size).toBe(7);
  });

  test("an expired invitation link's request names nobody and still reads", () => {
    const { text } = renderEmail(EMAIL_SAMPLES["invite_request-link.en"] as EmailTemplate, art);
    expect(text).toContain("Someone with an expired invitation link to Souza Bakery asked for a new one.");
  });

  test("without EMAIL_FROM, the sender is agentes.chat at this server's host", () => {
    expect(defaultEmailFrom("https://agentes.chat")).toBe("agentes.chat <ola@agentes.chat>");
    expect(defaultEmailFrom("https://chat.acme.com:8443/")).toBe("agentes.chat <ola@chat.acme.com>");
  });

  test("the footer says who sent it: agentes.chat, or a self-hosted server by its host", () => {
    expect(renderEmail(verify, emailArtAt("https://agentes.chat")).text).toContain("\nSent by agentes.chat.\n");
    expect(renderEmail(verify, emailArtAt("https://chat.acme.com/")).text).toContain(
      "\nSent by the agentes.chat server at chat.acme.com.\n",
    );
    expect(renderEmail({ ...verify, locale: "pt-BR" }, emailArtAt("https://chat.acme.com")).text).toContain(
      "Enviado pelo servidor do agentes.chat em chat.acme.com.",
    );
  });
});

describe("the computer ready email's button: its first step", () => {
  const base = EMAIL_SAMPLES["computer_ready-ai.en"] as Extract<EmailTemplate, { kind: "computer_ready" }>;
  const button = (needsAi: boolean, hasAgents: boolean, url = base.url) => {
    const [b] = buttons({ ...base, needsAi, hasAgents, url });
    return `${b?.label} ${b?.url}`;
  };

  test("connect the AI, give a first task, or create an agent first, from the workspace's URL of any job", () => {
    expect(button(true, true)).toBe(`Connect your AI ${base.url}?connect=ai`);
    expect(button(false, true)).toBe(`Give a first task ${base.url}`);
    expect(button(true, false)).toBe(`Create an agent ${base.url}/agents/new`);
    expect(button(false, false)).toBe(`Create an agent ${base.url}/agents/new`);
    expect(button(true, true, `${base.url}?connect=ai`)).toBe(`Connect your AI ${base.url}?connect=ai`);
    expect(button(true, true, `${base.url}/`)).toBe(`Connect your AI ${base.url}?connect=ai`);
  });

  test("the steps count only those shown, in both parts", () => {
    const steps = (t: Partial<typeof base>) => renderEmail({ ...base, ...t }, art).text;
    expect(steps({})).toContain(
      "Next steps\n\n1. Connect your AI. Sign in with your Claude or ChatGPT plan, another AI's coding plan, or an API key. Your agents think with it.\n2. Give a first task.",
    );
    expect(steps({ needsAi: false })).toContain("Next steps\n\n1. Give a first task.");
    expect(steps({ needsAi: false })).toContain("\n2. Watch them work.");
    expect(steps({ hasAgents: false })).toContain(
      "\n1. Create an agent. It works on this computer from the start.\n2. Connect your AI.",
    );
    expect(steps({ hasAgents: false, needsAi: false })).not.toContain("Connect your AI");
    expect(steps({ locale: "pt-BR", specs: { cpus: 1, memoryGb: 7.8, diskGb: 100 } })).toContain(
      "CPUs: 1\nMemória: 7,8 GB\nDisco: 100 GB",
    );
    const html = renderEmail(base, art).html;
    expect(html.match(/<td class="num"/g)).toHaveLength(3);
    expect(html).toContain('<h2 class="ink"');
  });
});

describe("where the pictures come from", () => {
  test("linked from this server's /email/, with the web font", () => {
    const { html, inline } = renderEmail(EMAIL_SAMPLES["verify_email.en"] as EmailTemplate, art);
    expect(html).toContain('src="https://x.test/email/logo-ink.png"');
    expect(html).toContain("src:url('https://x.test/email/source-sans-3-latin.woff2')");
    expect(html).toContain('<a href="https://x.test" target="_blank"');
    expect(inline).toEqual([]);
  });

  test("attached: each message carries only the pictures its HTML names, and no web font", async () => {
    const attached = await emailArtFor("http://localhost:3000", WEB_DIR, "auto");
    expect(attached.base).toBeNull();
    const { html, inline } = renderEmail(
      {
        kind: "approval_digest",
        locale: "en",
        orgName: "Acme",
        items: [{ agentName: "Lia", agentColor: "rose", title: "Deploy", ageHours: 5 }],
        url: "http://localhost:3000/org/o/approvals?open=a",
      },
      attached,
    );
    expect(html).toContain('src="cid:logo-ink@agentes.chat"');
    expect(html).not.toContain("@font-face");
    expect(inline.map((p) => p.filename)).toEqual(["logo-ink.png", "logo-bone.png", "sky-band.png", "agent-rose.png"]);
    expect(inline[0]).toMatchObject({ cid: "logo-ink@agentes.chat", contentType: "image/png" });
    expect([...(inline[0]?.content ?? []).slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  });

  test("EMAIL_ART=attach on a public host; auto attaches for a private, CGNAT or privately resolving one", async () => {
    const publicDns = async () => ["93.184.216.34"];
    const at = (url: string, mode: "auto" | "attach", resolveTo = publicDns) =>
      emailArtFor(url, WEB_DIR, mode, resolveTo).then((a) => a.base);
    expect(await at("https://chat.acme.com", "auto")).toBe("https://chat.acme.com/email/");
    expect(await at("https://chat.acme.com", "attach")).toBeNull();
    expect(await at("http://localhost:3000", "auto")).toBeNull();
    expect(await at("https://100.101.102.103", "auto")).toBeNull();
    expect(await at("https://agentes.tail1234.ts.net", "auto", async () => ["100.64.1.2"])).toBeNull();
    expect(await at("https://chat.acme.internal", "auto")).toBeNull();
    expect(await at("https://10-0-0-5.sslip.io", "auto", async () => ["10.0.0.5"])).toBeNull();
    // A server without the web app's pictures keeps them linked.
    expect((await emailArtFor("http://localhost:3000", "/nonexistent", "auto")).base).toBe(
      "http://localhost:3000/email/",
    );
  });

  test("says why they're attached: asked, a private host, or a host that didn't resolve", async () => {
    const why = (url: string, mode: "auto" | "attach", resolveTo: () => Promise<string[]>) =>
      emailArtFor(url, WEB_DIR, mode, resolveTo).then((a) => a.attached);
    const publicDns = async () => ["93.184.216.34"];
    expect(await why("https://chat.acme.com", "auto", publicDns)).toBeUndefined();
    expect(await why("https://chat.acme.com", "attach", publicDns)).toBe("attach");
    expect(await why("http://localhost:3000", "auto", publicDns)).toBe("blocked");
    expect(await why("https://chat.acme.com", "auto", () => Promise.reject(new Error("ENOTFOUND")))).toBe(
      "unreachable",
    );
  });
});

describe("jobs queued before this look", () => {
  test("old payloads, with no language or new fields, still render (pt-BR)", () => {
    const e = renderEmail({ kind: "verify_email", url: "u" });
    expect(e.subject).toBe("Confirme seu e-mail no agentes.chat");
    expect(e.html).toContain('<html lang="pt-BR"');
    const old: EmailTemplate[] = [
      { kind: "invitation", orgName: "Acme", inviterName: "", url: "https://x/invite/t", role: "member" },
      { kind: "budget", level: "warning", agentName: "Ada", orgName: "Acme", percent: 80.4, url: "u" },
      {
        kind: "approval_digest",
        orgName: "Acme",
        items: [
          { agentName: "Ada", title: "Merge PR #42", ageHours: 5 },
          { agentName: "", title: "Deploy", ageHours: 0.2 },
        ],
        url: "u",
      },
      { kind: "invite_request", orgName: "Acme", email: "", url: "u" },
    ];
    for (const t of old) {
      const r = renderEmail(t, art);
      expect(`${r.subject}${r.html}${r.text}`).not.toMatch(/undefined|null|\{\w+\}/);
    }
    const [invitation, budget, digest] = old.map((t) => renderEmail(t, art).text);
    expect(invitation).toContain("Você recebeu um convite para entrar na Acme como membro.");
    // A percentage only: owners who aren't admins never see money.
    expect(budget).toContain("Usou 80% do orçamento deste mês · Acme");
    expect(budget).not.toContain("US$");
    expect(digest).toContain(`Ada · Merge PR #42 · há\u00a05\u00a0h`);
    expect(digest).toContain(`Um agente · Deploy · há\u00a01\u00a0h`);
    // No `afterHours`: the footer stops after its first sentence.
    expect(digest).toContain("Você recebeu este e-mail porque pode aprovar estes pedidos na Acme.\n");
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

  test("attached pictures go with the message as inline parts", async () => {
    const sender = createFakeEmailSender();
    const attached: EmailArt = await emailArtFor("http://localhost:3000", WEB_DIR, "attach");
    await sendQueuedEmail(sender, { key: "k", to: ["a@b.c"], template: EMAIL_SAMPLES["verify_email.en"] }, attached);
    expect(sender.sent[0]?.inline?.map((p) => p.cid)).toEqual([
      "logo-ink@agentes.chat",
      "logo-bone@agentes.chat",
      "sky-band@agentes.chat",
    ]);
    await sendQueuedEmail(sender, { key: "k2", to: ["a@b.c"], template: EMAIL_SAMPLES["verify_email.en"] }, art);
    expect(sender.sent[1]).not.toHaveProperty("inline");
  });

  test("budget email once per agent, month and level, with the agent's face and its budget's address", async () => {
    f = await setup();
    await f.db
      .update(schema.agents)
      .set({ appearance: { color: "rose", eyes: "round", accessory: "none" } })
      .where(eq(schema.agents.id, f.agent.id));
    const e = { agent: { ...f.agent }, level: "warning" as const, spentNanoUsd: 8e9, budgetNanoUsd: 10e9 };
    await queueBudgetEmail(f.db, "https://chat.example.com", e);
    await queueBudgetEmail(f.db, "https://chat.example.com", e);
    const jobs = (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "email.send");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      template: {
        kind: "budget",
        agentColor: "rose",
        url: `https://chat.example.com/org/${f.org.id}/agents/${f.agent.id}?tab=settings&sec=budget`,
      },
    });
  });

  test("approval digest: one email per approver for requests waiting too long, never twice, opening a lone request", async () => {
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
    const [approval] = await f.db.select().from(schema.approvals);
    const digests = (await f.db.select().from(schema.outbox)).filter(
      (j) => j.kind === "email.send" && JSON.stringify(j.payload).includes("approval_digest"),
    );
    expect(digests).toHaveLength(2);
    for (const d of digests) {
      expect(d.payload).toMatchObject({
        template: { url: `https://x/org/${f.org.id}/approvals?open=${approval?.id}`, afterHours: 4 },
      });
    }
  });

  test("invitation: the inviter's address goes in the body, so the invitee can judge who sent it", async () => {
    f = await setup();
    // The fixture's addresses end in a random hex suffix, which typed-text masking hides whenever it has 7 digits in a row.
    const inviterEmail = "ana.lima@example.com";
    await f.db.update(schema.users).set({ email: inviterEmail }).where(eq(schema.users.id, f.owner.id));
    await queueInvitationEmail(f.db, {
      orgId: f.org.id,
      invitationId: "i1",
      email: "new@example.com",
      role: "member",
      url: "https://x/invite/abcdefghijklmnop",
      inviterId: f.owner.id,
    });
    const [job] = (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "email.send");
    expect(job?.payload).toMatchObject({ template: { kind: "invitation", inviterEmail } });
    const payload = job?.payload as { template: EmailTemplate } | undefined;
    const text = payload ? renderEmail(payload.template, art).text : "";
    expect(text).toContain(`(${inviterEmail.replace(/([.@])/g, `$1${BREAK}`)}) convidou você para entrar na`);
  });
});
