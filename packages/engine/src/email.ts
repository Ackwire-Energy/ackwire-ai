import { EmailError, type EmailSender } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNull, lt, schema } from "@agenteschat/db";
import { approverIds } from "./approvals";
import { adminIds } from "./gateway";
import { enqueue, PermanentJobError } from "./outbox";
import { budgetPercent } from "./usage";

const { users, organizations, agents, approvals } = schema;

/**
 * Transactional emails (pt-BR; the waiting list also in English), rendered
 * when the `email.send` job runs. Simple, accessible HTML (one column, real
 * text, high contrast, lang set) plus a plain-text version.
 */
export type EmailTemplate =
  | { kind: "invitation"; orgName: string; inviterName: string; url: string; role: string }
  | { kind: "password_reset"; url: string }
  /** Someone invited you to an event (in-app too). `when` is already formatted in your time zone. */
  | { kind: "calendar_invite"; orgName: string; inviterName: string; title: string; when: string; url: string }
  /** Someone opened an expired invitation and asked for a new one. `email` is empty for an org link. */
  | { kind: "invite_request"; orgName: string; email: string; url: string }
  | { kind: "verify_email"; url: string }
  /**
   * Double opt-in for the landing page's waiting list, in the language they
   * joined in. `email` is the address being confirmed (absent in jobs queued
   * before it existed). Images come from the origin of `url`.
   */
  | { kind: "waitlist_confirm"; locale: "pt-BR" | "en"; url: string; email?: string }
  | {
      kind: "budget";
      level: "warning" | "exhausted";
      agentName: string;
      orgName: string;
      /** Share of the budget used (owners who aren't admins never see money). */
      percent: number;
      url: string;
    }
  | {
      kind: "approval_digest";
      orgName: string;
      items: { agentName: string; title: string; ageHours: number }[];
      url: string;
    };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
const percent = (n: number) => `${Math.round(n)}%`;
const ROLE: Record<string, string> = { owner: "dono", admin: "admin", member: "membro" };

const LAYOUT = {
  "pt-BR": {
    fallback: "Se o botão não funcionar, copie este endereço:",
    footer: "Você recebeu este e-mail porque usa o agentes.chat.",
  },
  en: {
    fallback: "If the button doesn't work, copy this address:",
    footer: "You got this email because you use agentes.chat.",
  },
};

function layout(
  title: string,
  paragraphs: string[],
  action?: { label: string; url: string },
  options: { lang?: keyof typeof LAYOUT; footer?: string } = {},
) {
  const lang = options.lang ?? "pt-BR";
  const words = LAYOUT[lang];
  const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;padding:24px;background:#ffffff;color:#111111;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5">
<main style="max-width:560px;margin:0 auto">
<p style="font-weight:600;margin:0 0 24px">agentes</p>
<h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join("\n")}
${
  action
    ? `<p style="margin:24px 0"><a href="${esc(action.url)}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px">${esc(action.label)}</a></p>
<p style="margin:0 0 16px;font-size:14px;color:#444444">${words.fallback} <a href="${esc(action.url)}" style="color:#111111">${esc(action.url)}</a></p>`
    : ""
}
<p style="margin:32px 0 0;font-size:13px;color:#555555">${esc(options.footer ?? words.footer)}</p>
</main></body></html>`;
  const strip = (p: string) =>
    p
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  const text = [title, "", ...paragraphs.map(strip), ...(action ? ["", `${action.label}: ${action.url}`] : [])].join(
    "\n",
  );
  return { html, text };
}

const WAITLIST = {
  "pt-BR": {
    subject: "Confirme seu lugar na lista do agentes.chat",
    preheader: "Um clique e seu lugar está guardado.",
    sender: "Agente da lista",
    when: "agora",
    title: "Oi! Só falta você aprovar.",
    lead: "Recebi um pedido para colocar este e-mail na lista de espera do agentes.chat. Aqui, nada importante acontece sem uma pessoa aprovar, e isso vale para mim também.",
    request: "Pedido de confirmação",
    what: "Entrar na lista de espera",
    button: "Confirmar meu e-mail",
    deny: "Não fui eu? Ignore este e-mail.",
    expires: "O link vale por 48 horas.",
    footer:
      "Alguém colocou este endereço no agentes.chat. Se não foi você, é só ignorar: sem confirmação, ele não entra na lista.",
  },
  en: {
    subject: "Confirm your spot on the agentes.chat waiting list",
    preheader: "One click and your spot is saved.",
    sender: "Waiting list agent",
    when: "now",
    title: "Hi! It just needs your approval.",
    lead: "I got a request to put this email on the agentes.chat waiting list. Here nothing important happens without a person approving it, and that goes for me too.",
    request: "Confirmation request",
    what: "Join the waiting list",
    button: "Confirm my email",
    deny: "Wasn't you? Ignore this email.",
    expires: "The link works for 48 hours.",
    footer:
      "Someone entered this address on agentes.chat. If it wasn't you, just ignore this: without confirmation it never joins the list.",
  },
};

/**
 * The waiting list confirmation, written as a message in the product: the
 * list's agent asks the person to approve (docs/design/telas/Email.html,
 * direction C). Tables and inline styles for Gmail/Outlook; the art is PNGs
 * from apps/web/public/email (EmailArt.html); a dark palette where the client
 * supports `prefers-color-scheme`.
 */
function waitlistEmail(t: Extract<EmailTemplate, { kind: "waitlist_confirm" }>) {
  const lang = t.locale === "en" ? "en" : "pt-BR";
  const w = WAITLIST[lang];
  const words = LAYOUT[lang];
  const origin = URL.canParse(t.url) ? new URL(t.url).origin : "";
  const img = (name: string) => esc(`${origin}/email/${name}`);
  const url = esc(t.url);
  const ui = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const display = `'Funnel Display',${ui}`;
  const doto = "'Doto',ui-monospace,Menlo,monospace";
  const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(w.subject)}</title>
<style>
@font-face{font-family:'Funnel Display';font-weight:300 800;src:url('${img("funnel-display-latin.woff2")}') format('woff2')}
@font-face{font-family:'Doto';font-weight:100 900;src:url('${img("doto-latin.woff2")}') format('woff2')}
@media (prefers-color-scheme:dark){
.bg{background:#141413!important}.tx{color:#ecebe7!important}.mu{color:#9a9993!important}
.card{background:#1c1c1a!important;border-color:#2c2c29!important}
.btn{background:#ecebe7!important;color:#141413!important}
}
@media (max-width:480px){.pad{padding-left:22px!important;padding-right:22px!important}.h1{font-size:28px!important}}
</style></head>
<body class="bg" style="margin:0;padding:0;background:#ffffff">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(w.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:#ffffff"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td class="pad" style="padding:36px 40px 30px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding-right:9px;vertical-align:middle"><img src="${img("mark.png")}" width="26" height="26" alt="" style="display:block;border:0"></td>
<td class="tx" style="vertical-align:middle;font-family:${display};font-weight:300;font-size:22px;letter-spacing:-0.02em;color:#161614">agentes<span style="font-family:${doto};font-weight:600;font-size:14px;opacity:0.7">.chat</span></td>
</tr></table>
</td></tr>
<tr><td class="pad" style="padding:0 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="58" style="width:58px;vertical-align:top"><img src="${img("avatar.png")}" width="44" height="44" alt="" style="display:block;border:0"></td>
<td class="tx" style="vertical-align:top;font-family:${ui};font-size:16px;line-height:1.55;color:#161614">
<p style="margin:0;font-weight:600;font-size:15px">${esc(w.sender)}<span class="mu" style="font-weight:400;font-size:13px;color:#6b6a66;margin-left:6px">${esc(w.when)}</span></p>
<h1 class="h1" style="margin:6px 0 12px;font-family:${display};font-weight:300;font-size:34px;line-height:1.05;letter-spacing:-0.03em">${esc(w.title)}</h1>
<p style="margin:0 0 18px">${esc(w.lead)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="card" style="background:#fafaf8;border:1px solid #e4e2dd;border-radius:16px;padding:18px 20px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding-right:8px;vertical-align:middle"><img src="${img("shield.png")}" width="16" height="16" alt="" style="display:block;border:0"></td>
<td class="mu" style="vertical-align:middle;font-size:13px;color:#6b6a66">${esc(w.request)}</td>
</tr></table>
<p style="margin:8px 0 2px;font-weight:600">${esc(w.what)}</p>
${t.email ? `<p class="mu" style="margin:0;font-size:14px;color:#6b6a66">${esc(t.email)}</p>` : ""}
<p style="margin:16px 0 0"><a class="btn" href="${url}" style="display:inline-block;background:#161614;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:12px">${esc(w.button)}</a></p>
<p class="mu" style="margin:12px 0 0;font-size:14px;color:#6b6a66">${esc(w.deny)}</p>
</td></tr></table>
<p class="mu" style="margin:14px 0 0;font-size:13px;color:#6b6a66">${esc(w.expires)} ${esc(words.fallback)} <a href="${url}" class="mu" style="color:#6b6a66;word-break:break-all">${url}</a></p>
</td></tr></table>
</td></tr>
<tr><td class="pad" style="padding:30px 40px 0"><img src="${img("sky.png")}" width="520" height="28" alt="" style="display:block;border:0;width:100%;max-width:520px;height:auto;border-radius:6px"></td></tr>
<tr><td class="pad mu" style="padding:18px 40px 36px;font-family:${ui};font-size:13px;line-height:1.5;color:#6b6a66">${esc(w.footer)}</td></tr>
</table>
</td></tr></table>
</body></html>`;
  const text = [
    w.title,
    "",
    w.lead,
    "",
    `${w.what}${t.email ? ` (${t.email})` : ""}`,
    `${w.button}: ${t.url}`,
    "",
    w.expires,
    w.deny,
    "",
    w.footer,
  ].join("\n");
  return { subject: w.subject, html, text };
}

export function renderEmail(t: EmailTemplate): { subject: string; html: string; text: string } {
  switch (t.kind) {
    case "invitation": {
      const subject = `${t.inviterName} convidou você para ${t.orgName} no agentes`;
      return {
        subject,
        ...layout(
          `Convite para ${t.orgName}`,
          [
            `${esc(t.inviterName)} convidou você para entrar em <strong>${esc(t.orgName)}</strong> como ${esc(ROLE[t.role] ?? t.role)}.`,
            "O convite vale por 7 dias. Use este mesmo endereço de e-mail para aceitar.",
          ],
          { label: "Aceitar convite", url: t.url },
        ),
      };
    }
    case "invite_request": {
      const who = t.email ? esc(t.email) : "Alguém com o link de convite";
      return {
        subject: `Pedido de novo convite para ${t.orgName}`,
        ...layout(
          `Pedido de novo convite para ${t.orgName}`,
          [
            `${who} tentou entrar em <strong>${esc(t.orgName)}</strong>, mas o convite expirou e pediu um novo.`,
            "Se fizer sentido, envie um convite novo na página de membros.",
          ],
          { label: "Abrir membros", url: t.url },
        ),
      };
    }
    case "calendar_invite":
      return {
        subject: `${t.inviterName} convidou você: ${t.title}`,
        ...layout(
          t.title,
          [
            `${esc(t.inviterName)} convidou você para <strong>${esc(t.title)}</strong> em ${esc(t.orgName)}.`,
            esc(t.when),
          ],
          { label: "Ver no calendário", url: t.url },
        ),
      };
    case "password_reset":
      return {
        subject: "Redefinir sua senha do agentes",
        ...layout(
          "Redefinir sua senha",
          [
            "Recebemos um pedido para redefinir a sua senha. O link vale por pouco tempo.",
            "Se não foi você, ignore este e-mail; nada muda.",
          ],
          { label: "Criar uma senha nova", url: t.url },
        ),
      };
    case "verify_email":
      return {
        subject: "Confirme seu e-mail no agentes",
        ...layout("Confirme seu e-mail", ["Falta só confirmar que este endereço é seu."], {
          label: "Confirmar e-mail",
          url: t.url,
        }),
      };
    case "waitlist_confirm":
      return waitlistEmail(t);
    case "budget": {
      const pct = t.level === "warning" ? "80%" : "100%";
      return {
        subject:
          t.level === "warning"
            ? `${t.agentName} usou 80% do orçamento do mês`
            : `${t.agentName} atingiu o orçamento do mês`,
        ...layout(
          t.level === "warning"
            ? `${t.agentName} chegou a ${pct} do orçamento`
            : `${t.agentName} parou: orçamento atingido`,
          [
            `${esc(t.agentName)}, em ${esc(t.orgName)}, usou ${esc(percent(t.percent))} do orçamento deste mês.`,
            t.level === "warning"
              ? "Quando chegar a 100%, o agente para e avisa no canal. Um admin do workspace pode ajustar o limite."
              : "O agente não responde mais até o mês virar ou até o limite subir.",
          ],
          { label: "Ver o agente", url: t.url },
        ),
      };
    }
    case "approval_digest": {
      const n = t.items.length;
      return {
        subject:
          n === 1
            ? `1 pedido de aprovação esperando em ${t.orgName}`
            : `${n} pedidos de aprovação esperando em ${t.orgName}`,
        ...layout(
          n === 1 ? "Um pedido espera sua decisão" : `${n} pedidos esperam sua decisão`,
          [
            ...t.items.map(
              (i) =>
                `<strong>${esc(i.agentName)}</strong>: ${esc(i.title)} (há ${Math.max(1, Math.round(i.ageHours))} h)`,
            ),
            "Pedidos sem decisão expiram em 24 horas e nada é executado.",
          ],
          { label: "Abrir aprovações", url: t.url },
        ),
      };
    }
  }
}

/**
 * Queues an email (outbox job `email.send`), in the caller's transaction.
 * `key` is the idempotency key: the same key is sent once (outbox dedupe and
 * the provider's Idempotency-Key).
 */
export async function queueEmail(
  tx: Executor,
  input: { orgId: string | null; key: string; to: string[]; template: EmailTemplate },
) {
  await enqueue(tx, {
    orgId: input.orgId,
    kind: "email.send",
    payload: { key: input.key, to: input.to, template: input.template },
    dedupeKey: `email:${input.key}`,
    maxAttempts: 6,
  });
}

/** Job `email.send`. Retries on transient provider errors; permanent ones fail the job. */
export async function sendQueuedEmail(sender: EmailSender, payload: Record<string, unknown>) {
  const to = Array.isArray(payload.to) ? payload.to.map(String) : [];
  if (to.length === 0) throw new PermanentJobError("email without recipients");
  const rendered = renderEmail(payload.template as EmailTemplate);
  try {
    await sender.send({
      ...rendered,
      to,
      idempotencyKey: String(payload.key),
      tags: [{ name: "kind", value: (payload.template as EmailTemplate).kind }],
    });
  } catch (error) {
    if (error instanceof EmailError && !error.retryable) throw new PermanentJobError(error.message);
    throw error;
  }
}

/** The 80%/100% budget email to the agent's owner, or the admins without one (once per agent, month and level). */
export async function queueBudgetEmail(
  db: Database,
  publicUrl: string,
  e: {
    agent: { id: string; orgId: string; name: string; ownerUserId: string | null };
    level: "warning" | "exhausted";
    spentNanoUsd: number;
    budgetNanoUsd: number;
  },
) {
  // The owner, or the org's admins when the agent has none.
  const recipientIds = e.agent.ownerUserId ? [e.agent.ownerUserId] : await adminIds(db, e.agent.orgId);
  if (recipientIds.length === 0) return;
  const recipients = await db.select({ email: users.email }).from(users).where(inArray(users.id, recipientIds));
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, e.agent.orgId));
  if (recipients.length === 0 || !org) return;
  const month = new Date().toISOString().slice(0, 7);
  await queueEmail(db, {
    orgId: e.agent.orgId,
    key: `budget:${e.agent.id}:${month}:${e.level}`,
    to: recipients.map((r) => r.email),
    template: {
      kind: "budget",
      level: e.level,
      agentName: e.agent.name,
      orgName: org.name,
      percent: budgetPercent(e.spentNanoUsd, e.budgetNanoUsd),
      url: `${publicUrl.replace(/\/$/, "")}/org/${e.agent.orgId}/agents/${e.agent.id}`,
    },
  });
}

/**
 * Worker: approvals pending longer than `afterHours` get one digest email per
 * approver (owner of the agent + admins), and are marked so nobody is emailed
 * twice about the same request.
 */
export async function queueApprovalDigests(db: Database, publicUrl: string, afterHours: number, now = new Date()) {
  const due = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.status, "pending"),
        isNull(approvals.remindedAt),
        lt(approvals.createdAt, new Date(now.getTime() - afterHours * 3600_000)),
      ),
    )
    .limit(500);
  if (due.length === 0) return 0;
  const agentRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(inArray(agents.id, [...new Set(due.map((a) => a.agentId))]));
  const agentName = new Map(agentRows.map((a) => [a.id, a.name]));
  let queued = 0;
  for (const orgId of new Set(due.map((a) => a.orgId))) {
    const mine = due.filter((a) => a.orgId === orgId);
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    const byUser = new Map<string, typeof mine>();
    for (const a of mine) for (const u of await approverIds(db, a)) byUser.set(u, [...(byUser.get(u) ?? []), a]);
    const emails = new Map(
      (byUser.size
        ? await db
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(inArray(users.id, [...byUser.keys()]))
        : []
      ).map((u) => [u.id, u.email]),
    );
    await db.transaction(async (tx) => {
      for (const [userId, items] of byUser) {
        const email = emails.get(userId);
        if (!email) continue;
        await queueEmail(tx, {
          orgId,
          key: `approval-digest:${userId}:${items
            .map((i) => i.id)
            .sort()
            .join(",")
            .slice(0, 200)}`,
          to: [email],
          template: {
            kind: "approval_digest",
            orgName: org?.name ?? "",
            items: items.map((i) => ({
              agentName: agentName.get(i.agentId) ?? "Agente",
              title: i.title,
              ageHours: (now.getTime() - i.createdAt.getTime()) / 3600_000,
            })),
            url: `${publicUrl.replace(/\/$/, "")}/org/${orgId}/approvals`,
          },
        });
        queued++;
      }
      await tx
        .update(approvals)
        .set({ remindedAt: now })
        .where(
          inArray(
            approvals.id,
            mine.map((a) => a.id),
          ),
        );
    });
  }
  return queued;
}

/** Invitation email (create, batch and resend). The key changes with each new link. */
export async function queueInvitationEmail(
  db: Executor,
  input: { orgId: string; invitationId: string; email: string; role: string; url: string; inviterId: string },
) {
  const [inviter] = await db.select({ name: users.name }).from(users).where(eq(users.id, input.inviterId));
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, input.orgId));
  await queueEmail(db, {
    orgId: input.orgId,
    key: `invite:${input.invitationId}:${input.url.slice(-16)}`,
    to: [input.email],
    template: {
      kind: "invitation",
      orgName: org?.name ?? "",
      inviterName: inviter?.name ?? "Alguém",
      url: input.url,
      role: input.role,
    },
  });
}
