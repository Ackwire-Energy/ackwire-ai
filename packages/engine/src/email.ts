import { EmailError, type EmailSender } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNull, lt, schema } from "@agenteschat/db";
import { appLocale } from "@agenteschat/i18n/locale";
import { approverIds } from "./approvals";
import { adminIds } from "./gateway";
import { enqueue, PermanentJobError } from "./outbox";
import { budgetPercent } from "./usage";

const { users, organizations, agents, approvals } = schema;

/** The languages emails are written in. */
export type EmailLocale = "pt-BR" | "en";

/** A stored or chosen language as an email locale: "en…" is English, anything else (or none) pt-BR. */
export const emailLocale = (value: unknown): EmailLocale =>
  (typeof value === "string" ? appLocale([value]) : null) ?? "pt-BR";

/**
 * Transactional emails in pt-BR or English (`locale`, the recipient's; jobs
 * queued before it existed have none and stay pt-BR), rendered when the
 * `email.send` job runs. Simple, accessible HTML (one column, real text, high
 * contrast, lang set) plus a plain-text version.
 */
export type EmailTemplate =
  | {
      kind: "invitation";
      locale?: EmailLocale;
      orgName: string;
      /** Empty: the email says "someone" in its language. */
      inviterName: string;
      url: string;
      role: string;
    }
  | { kind: "password_reset"; locale?: EmailLocale; url: string }
  /** Someone invited you to an event (in-app too). `when` is already formatted in your time zone and language. */
  | {
      kind: "calendar_invite";
      locale?: EmailLocale;
      orgName: string;
      /** Empty: the email says "someone" in its language. */
      inviterName: string;
      title: string;
      when: string;
      url: string;
    }
  /** Someone opened an expired invitation and asked for a new one. `email` is empty for an org link. */
  | { kind: "invite_request"; locale?: EmailLocale; orgName: string; email: string; url: string }
  | { kind: "verify_email"; locale?: EmailLocale; url: string }
  /**
   * Double opt-in for the landing page's waiting list, in the language they
   * joined in. `email` is the address being confirmed (absent in jobs queued
   * before it existed). Images come from the origin of `url`.
   */
  | { kind: "waitlist_confirm"; locale: EmailLocale; url: string; email?: string }
  | {
      kind: "budget";
      locale?: EmailLocale;
      level: "warning" | "exhausted";
      agentName: string;
      orgName: string;
      /** Share of the budget used (owners who aren't admins never see money). */
      percent: number;
      url: string;
    }
  | {
      kind: "approval_digest";
      locale?: EmailLocale;
      orgName: string;
      /** `agentName` empty: "an agent" in the email's language. */
      items: { agentName: string; title: string; ageHours: number }[];
      url: string;
    }
  /** The workspace's own computer is ready after a long wait (ADR 0056 §10): what it is, and what to do next. */
  | {
      kind: "computer_ready";
      locale?: EmailLocale;
      orgName: string;
      /** Its size, when the provisioner said it. */
      specs: { cpus: number; memoryGb: number; diskGb: number } | null;
      /** No agent has an AI to think with yet: connecting one is the first step. */
      needsAi: boolean;
      hasAgents: boolean;
      /** The workspace in the app. */
      url: string;
    };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
const percent = (n: number) => `${Math.round(n)}%`;

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

/** A paragraph of HTML, or numbered steps (`<ol>`, counted in the text part too). */
type Block = string | { steps: string[] };

function layout(
  title: string,
  paragraphs: Block[],
  action?: { label: string; url: string },
  options: { lang?: EmailLocale; footer?: string } = {},
) {
  const lang = options.lang ?? "pt-BR";
  const words = LAYOUT[lang];
  const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;padding:24px;background:#ffffff;color:#111111;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5">
<main style="max-width:560px;margin:0 auto">
<p style="font-weight:600;margin:0 0 24px">agentes</p>
<h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
${paragraphs
  .map((p) =>
    typeof p === "string"
      ? `<p style="margin:0 0 16px">${p}</p>`
      : `<ol style="margin:0 0 16px;padding-left:24px">${p.steps.map((step) => `<li style="margin:0 0 8px">${step}</li>`).join("")}</ol>`,
  )
  .join("\n")}
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
  const lines = paragraphs.flatMap((p) =>
    typeof p === "string" ? [strip(p)] : p.steps.map((step, i) => `${i + 1}. ${strip(step)}`),
  );
  const text = [title, "", ...lines, ...(action ? ["", `${action.label}: ${action.url}`] : [])].join("\n");
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
 * list's agent asks the person to approve. Tables and inline styles for
 * Gmail/Outlook; the art is PNGs from apps/web/public/email; a dark palette
 * where the client supports `prefers-color-scheme`.
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

/** The words of each email, per language (`html` parts are escaped by the caller's values). */
const WORDS = {
  "pt-BR": {
    role: { owner: "dono", admin: "admin", member: "membro" } as Record<string, string>,
    someone: "Alguém",
    anAgent: "Um agente",
    invitation: {
      subject: (inviter: string, org: string) => `${inviter} convidou você para ${org} no agentes`,
      title: (org: string) => `Convite para ${org}`,
      body: (inviter: string, org: string, role: string) =>
        `${inviter} convidou você para entrar em <strong>${org}</strong> como ${role}.`,
      note: "O convite vale por 7 dias. Use este mesmo endereço de e-mail para aceitar.",
      button: "Aceitar convite",
    },
    inviteRequest: {
      title: (org: string) => `Pedido de novo convite para ${org}`,
      someoneWithLink: "Alguém com o link de convite",
      body: (who: string, org: string) =>
        `${who} tentou entrar em <strong>${org}</strong>, mas o convite expirou e pediu um novo.`,
      note: "Se fizer sentido, envie um convite novo na página de membros.",
      button: "Abrir membros",
    },
    calendar: {
      subject: (inviter: string, title: string) => `${inviter} convidou você: ${title}`,
      body: (inviter: string, title: string, org: string) =>
        `${inviter} convidou você para <strong>${title}</strong> em ${org}.`,
      button: "Ver no calendário",
    },
    passwordReset: {
      subject: "Redefinir sua senha do agentes",
      title: "Redefinir sua senha",
      body: "Recebemos um pedido para redefinir a sua senha. O link vale por pouco tempo.",
      note: "Se não foi você, ignore este e-mail; nada muda.",
      button: "Criar uma senha nova",
    },
    verify: {
      subject: "Confirme seu e-mail no agentes",
      title: "Confirme seu e-mail",
      body: "Falta só confirmar que este endereço é seu.",
      button: "Confirmar e-mail",
    },
    budget: {
      subjectWarning: (agent: string) => `${agent} usou 80% do orçamento do mês`,
      subjectExhausted: (agent: string) => `${agent} atingiu o orçamento do mês`,
      titleWarning: (agent: string) => `${agent} chegou a 80% do orçamento`,
      titleExhausted: (agent: string) => `${agent} parou: orçamento atingido`,
      body: (agent: string, org: string, pct: string) => `${agent}, em ${org}, usou ${pct} do orçamento deste mês.`,
      warning: "Quando chegar a 100%, o agente para e avisa no canal. Um admin do workspace pode ajustar o limite.",
      exhausted: "O agente não responde mais até o mês virar ou até o limite subir.",
      button: "Ver o agente",
    },
    digest: {
      subject: (n: number, org: string) =>
        n === 1 ? `1 pedido de aprovação esperando em ${org}` : `${n} pedidos de aprovação esperando em ${org}`,
      title: (n: number) => (n === 1 ? "Um pedido espera sua decisão" : `${n} pedidos esperam sua decisão`),
      age: (hours: number) => `há ${hours} h`,
      note: "Pedidos sem decisão expiram em 24 horas e nada é executado.",
      button: "Abrir aprovações",
    },
    computerReady: {
      subject: (org: string) => `O computador da ${org} está pronto`,
      title: "O computador dos seus agentes está pronto",
      sizes: (cpus: string, memory: string, disk: string) => `${cpus}, ${memory} GB de memória e ${disk} GB de disco`,
      body: (org: string, sizes: string | null) =>
        `O computador da ${org} está ligado e configurado${sizes ? `: ${sizes}` : ""}, com um usuário só para cada agente. Ele fica ligado dia e noite, para os agentes trabalharem a qualquer hora.`,
      next: "Próximos passos",
      ai: "<strong>Conecte sua IA.</strong> Entre com o seu plano do Claude ou do ChatGPT, com o plano de código de outra IA, ou com uma chave de API. É com ela que os agentes pensam.",
      task: "<strong>Passe a primeira tarefa.</strong> No #general, chame um agente com @ e diga do que precisa.",
      watch:
        "<strong>Veja os agentes trabalhando.</strong> Na página de um agente, clique em Abrir para ver o computador dele ao vivo. Assuma o controle quando quiser e devolva quando terminar.",
      create: "<strong>Crie um agente.</strong> Ele trabalha neste computador desde o começo.",
      button: (org: string) => `Abrir ${org}`,
    },
  },
  en: {
    role: { owner: "owner", admin: "admin", member: "member" } as Record<string, string>,
    someone: "Someone",
    anAgent: "An agent",
    invitation: {
      subject: (inviter: string, org: string) => `${inviter} invited you to ${org} on agentes`,
      title: (org: string) => `Invitation to ${org}`,
      body: (inviter: string, org: string, role: string) =>
        `${inviter} invited you to join <strong>${org}</strong> as ${role}.`,
      note: "The invitation works for 7 days. Use this same email address to accept it.",
      button: "Accept invitation",
    },
    inviteRequest: {
      title: (org: string) => `Request for a new invitation to ${org}`,
      someoneWithLink: "Someone with the invite link",
      body: (who: string, org: string) =>
        `${who} tried to join <strong>${org}</strong>, but the invitation had expired, and asked for a new one.`,
      note: "If it makes sense, send a new invitation from the members page.",
      button: "Open members",
    },
    calendar: {
      subject: (inviter: string, title: string) => `${inviter} invited you: ${title}`,
      body: (inviter: string, title: string, org: string) =>
        `${inviter} invited you to <strong>${title}</strong> in ${org}.`,
      button: "View in the calendar",
    },
    passwordReset: {
      subject: "Reset your agentes password",
      title: "Reset your password",
      body: "We got a request to reset your password. The link works for a short time only.",
      note: "If it wasn't you, ignore this email; nothing changes.",
      button: "Create a new password",
    },
    verify: {
      subject: "Confirm your email on agentes",
      title: "Confirm your email",
      body: "All that's left is to confirm this address is yours.",
      button: "Confirm email",
    },
    budget: {
      subjectWarning: (agent: string) => `${agent} used 80% of this month's budget`,
      subjectExhausted: (agent: string) => `${agent} reached this month's budget`,
      titleWarning: (agent: string) => `${agent} reached 80% of the budget`,
      titleExhausted: (agent: string) => `${agent} stopped: budget reached`,
      body: (agent: string, org: string, pct: string) => `${agent}, in ${org}, used ${pct} of this month's budget.`,
      warning: "At 100% the agent stops and says so in the channel. A workspace admin can change the limit.",
      exhausted: "The agent won't answer until the month turns or the limit goes up.",
      button: "View the agent",
    },
    digest: {
      subject: (n: number, org: string) =>
        n === 1 ? `1 approval request waiting in ${org}` : `${n} approval requests waiting in ${org}`,
      title: (n: number) =>
        n === 1 ? "A request is waiting for your decision" : `${n} requests are waiting for your decision`,
      age: (hours: number) => `${hours} h ago`,
      note: "Requests without a decision expire after 24 hours and nothing runs.",
      button: "Open approvals",
    },
    computerReady: {
      subject: (org: string) => `${org}'s computer is ready`,
      title: "Your agents' computer is ready",
      sizes: (cpus: string, memory: string, disk: string) => `${cpus}, ${memory} GB of memory and ${disk} GB of disk`,
      body: (org: string, sizes: string | null) =>
        `${org}'s computer is on and set up${sizes ? `: ${sizes}` : ""}, with a user of its own for each agent. It stays on day and night, so your agents can work any time.`,
      next: "Next steps",
      ai: "<strong>Connect your AI.</strong> Sign in with your Claude or ChatGPT plan, another AI's coding plan, or an API key. Your agents think with it.",
      task: "<strong>Give a first task.</strong> In #general, call an agent with @ and say what you need.",
      watch:
        "<strong>Watch them work.</strong> On an agent's page, press Open to see its computer live. Take control whenever you want, and hand it back when you're done.",
      create: "<strong>Create an agent.</strong> It works on this computer from the start.",
      button: (org: string) => `Open ${org}`,
    },
  },
} satisfies Record<EmailLocale, unknown>;

export function renderEmail(t: EmailTemplate): { subject: string; html: string; text: string } {
  if (t.kind === "waitlist_confirm") return waitlistEmail(t);
  const lang = emailLocale(t.locale);
  const w = WORDS[lang];
  const page = (title: string, paragraphs: Block[], action: { label: string; url: string }) =>
    layout(title, paragraphs, action, { lang });
  switch (t.kind) {
    case "invitation": {
      const inviter = t.inviterName || w.someone;
      return {
        subject: w.invitation.subject(inviter, t.orgName),
        ...page(
          w.invitation.title(t.orgName),
          [w.invitation.body(esc(inviter), esc(t.orgName), esc(w.role[t.role] ?? t.role)), w.invitation.note],
          { label: w.invitation.button, url: t.url },
        ),
      };
    }
    case "invite_request": {
      const who = t.email ? esc(t.email) : w.inviteRequest.someoneWithLink;
      return {
        subject: w.inviteRequest.title(t.orgName),
        ...page(w.inviteRequest.title(t.orgName), [w.inviteRequest.body(who, esc(t.orgName)), w.inviteRequest.note], {
          label: w.inviteRequest.button,
          url: t.url,
        }),
      };
    }
    case "calendar_invite": {
      const inviter = t.inviterName || w.someone;
      return {
        subject: w.calendar.subject(inviter, t.title),
        ...page(t.title, [w.calendar.body(esc(inviter), esc(t.title), esc(t.orgName)), esc(t.when)], {
          label: w.calendar.button,
          url: t.url,
        }),
      };
    }
    case "password_reset":
      return {
        subject: w.passwordReset.subject,
        ...page(w.passwordReset.title, [w.passwordReset.body, w.passwordReset.note], {
          label: w.passwordReset.button,
          url: t.url,
        }),
      };
    case "verify_email":
      return {
        subject: w.verify.subject,
        ...page(w.verify.title, [w.verify.body], { label: w.verify.button, url: t.url }),
      };
    case "budget": {
      const warning = t.level === "warning";
      return {
        subject: warning ? w.budget.subjectWarning(t.agentName) : w.budget.subjectExhausted(t.agentName),
        ...page(
          warning ? w.budget.titleWarning(t.agentName) : w.budget.titleExhausted(t.agentName),
          [
            w.budget.body(esc(t.agentName), esc(t.orgName), esc(percent(t.percent))),
            warning ? w.budget.warning : w.budget.exhausted,
          ],
          { label: w.budget.button, url: t.url },
        ),
      };
    }
    case "computer_ready": {
      const c = w.computerReady;
      const num = (n: number) => n.toLocaleString(lang, { maximumFractionDigits: 1 });
      const sizes = t.specs
        ? c.sizes(
            `${num(t.specs.cpus)} ${t.specs.cpus === 1 ? "CPU" : "CPUs"}`,
            num(t.specs.memoryGb),
            num(t.specs.diskGb),
          )
        : null;
      const steps = [...(t.needsAi ? [c.ai] : []), ...(t.hasAgents ? [c.task, c.watch] : [c.create])];
      return {
        subject: c.subject(t.orgName),
        ...page(c.title, [c.body(esc(t.orgName), sizes), `<strong>${c.next}</strong>`, { steps }], {
          label: c.button(t.orgName),
          url: t.url,
        }),
      };
    }
    case "approval_digest": {
      const n = t.items.length;
      return {
        subject: w.digest.subject(n, t.orgName),
        ...page(
          w.digest.title(n),
          [
            ...t.items.map(
              (i) =>
                `<strong>${esc(i.agentName || w.anAgent)}</strong>: ${esc(i.title)} (${w.digest.age(Math.max(1, Math.round(i.ageHours)))})`,
            ),
            w.digest.note,
          ],
          { label: w.digest.button, url: t.url },
        ),
      };
    }
  }
}

/**
 * Recipients grouped by language, one email per group. The pt-BR group keeps
 * `key` as is (jobs queued before locales existed dedupe the same); others add ":en".
 */
export function emailsByLocale(recipients: { email: string; locale: EmailLocale }[], key: string) {
  const groups = new Map<EmailLocale, string[]>();
  for (const r of recipients) groups.set(r.locale, [...(groups.get(r.locale) ?? []), r.email]);
  return [...groups].map(([locale, to]) => ({ locale, to, key: locale === "pt-BR" ? key : `${key}:${locale}` }));
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
  const recipients = await db
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(inArray(users.id, recipientIds));
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, e.agent.orgId));
  if (recipients.length === 0 || !org) return;
  const month = new Date().toISOString().slice(0, 7);
  const groups = emailsByLocale(
    recipients.map((r) => ({ email: r.email, locale: emailLocale(r.locale) })),
    `budget:${e.agent.id}:${month}:${e.level}`,
  );
  for (const group of groups) {
    await queueEmail(db, {
      orgId: e.agent.orgId,
      key: group.key,
      to: group.to,
      template: {
        kind: "budget",
        locale: group.locale,
        level: e.level,
        agentName: e.agent.name,
        orgName: org.name,
        percent: budgetPercent(e.spentNanoUsd, e.budgetNanoUsd),
        url: `${publicUrl.replace(/\/$/, "")}/org/${e.agent.orgId}/agents/${e.agent.id}`,
      },
    });
  }
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
    const people = new Map(
      (byUser.size
        ? await db
            .select({ id: users.id, email: users.email, locale: users.locale })
            .from(users)
            .where(inArray(users.id, [...byUser.keys()]))
        : []
      ).map((u) => [u.id, u]),
    );
    await db.transaction(async (tx) => {
      for (const [userId, items] of byUser) {
        const person = people.get(userId);
        if (!person) continue;
        await queueEmail(tx, {
          orgId,
          key: `approval-digest:${userId}:${items
            .map((i) => i.id)
            .sort()
            .join(",")
            .slice(0, 200)}`,
          to: [person.email],
          template: {
            kind: "approval_digest",
            locale: emailLocale(person.locale),
            orgName: org?.name ?? "",
            items: items.map((i) => ({
              agentName: agentName.get(i.agentId) ?? "",
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

/**
 * Invitation email (create, batch and resend). The key changes with each new link.
 * In the invitee's language when they already have an account, else the inviter's.
 */
export async function queueInvitationEmail(
  db: Executor,
  input: { orgId: string; invitationId: string; email: string; role: string; url: string; inviterId: string },
) {
  const [inviter] = await db
    .select({ name: users.name, locale: users.locale })
    .from(users)
    .where(eq(users.id, input.inviterId));
  const [invitee] = await db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.email, input.email.trim().toLowerCase()));
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
      locale: emailLocale(invitee?.locale ?? inviter?.locale),
      orgName: org?.name ?? "",
      inviterName: inviter?.name ?? "",
      url: input.url,
      role: input.role,
    },
  });
}
