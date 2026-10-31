import type { EmailLocale, Inline, Text } from "./layout";

/**
 * Every email's words, in English and pt-BR. Plain text only (bold is `{ b }`): the layout escapes it.
 * Subjects, preheaders, headlines and buttons hold only these words; what people type or agents write
 * goes in the body, made inert by the caller. Plain voice, no em dashes or semicolons.
 * The layout keeps every text's last two words on one line, so a wrapped one never ends on a word alone. A card's
 * closing line ends in a `{ nobr }` of its own where those two would leave its last line above the baseline, short
 * of what the card's end margin expects (`END` in the layout), and a host keeps the word before it.
 */

type Step = [title: string, text: string];

/**
 * A self-hosted server's host and the word before it ("at", "em") on one line: a narrow screen moves them down
 * together, so the host is never split at a hyphen nor alone on the last line. A host over 36 characters moves down
 * alone: with the word it may not fit a 320 px phone's line (digits run wide), and would then break inside again or
 * leave the word alone on a line of its own.
 */
const atHost = (lead: string, word: string, host: string): Text =>
  host.length > 36 ? [`${lead} ${word} `, { nobr: `${host}.` }] : [`${lead} `, { nobr: `${word} ${host}.` }];

const en = {
  /** Who sent it: agentes.chat, or a self-hosted server named by its host. */
  sentBy: (host: string | null): Text =>
    host ? atHost("Sent by the agentes.chat server", "at", host) : "Sent by agentes.chat.",
  fallback: "Button not working? Copy this address into your browser:",
  role: { owner: "an owner", member: "a member" } as Record<string, string>,
  anAgent: "An agent",
  someone: "Someone",
  verify: {
    subject: "Confirm your email for agentes.chat",
    preheader: "One click to confirm this address. The link works for an hour.",
    headline: "Confirm your email",
    body: "One step left: confirm that this address is yours.",
    button: "Confirm email",
    small: "The link works for an hour. If you didn't sign up, you can ignore this email.",
    why: "You got this email because this address was used to sign up for agentes.chat.",
  },
  reset: {
    subject: "Reset your agentes.chat password",
    preheader: "Choose a new password. The link works for an hour.",
    headline: "Choose a new password",
    body: "We got a request to reset the password for this address.",
    button: "Choose a new password",
    note: "Didn't ask for this? Ignore this email. Your password stays the same.",
    small: "The link works for an hour.",
    why: "You got this email because someone asked to reset the password for this address on agentes.chat.",
  },
  invitation: {
    subject: "You're invited to a workspace on agentes.chat",
    preheader: "Accept within 7 days, with this email address.",
    headline: "You're invited to a workspace",
    body: (inviter: string, email: string | null, org: string, role: string): Text =>
      inviter
        ? [{ b: inviter }, `${email ? ` (${email})` : ""} invited you to join `, { b: org }, ` as ${role}.`]
        : ["You're invited to join ", { b: org }, ` as ${role}.`],
    what: "agentes.chat is where people and AI agents work together.",
    noteFrom: (inviter: string, note: string): Text => [{ b: inviter ? `${inviter}: ` : "Their note: " }, `“${note}”`],
    button: "Accept invitation",
    small: "The invitation works for 7 days. Accept it with this email address.",
    why: (org: string) =>
      `You got this email because someone at ${org} invited this address. If you don't know them, ignore it. Nothing happens until you accept.`,
  },
  inviteRequest: {
    subject: "Someone asked for a new invitation",
    preheader: "Their invitation expired. You can send a new one from Members.",
    headline: "Someone asked for a new invitation",
    body: (email: string, org: string): Text =>
      email
        ? [{ b: email }, " opened an expired invitation to ", { b: org }, " and asked for a new one."]
        : ["Someone with an expired invitation link to ", { b: org }, " asked for a new one."],
    next: "If you expect them, send a new invitation from Members. If not, there's nothing to do.",
    button: "Open Members",
    why: (org: string) => `You got this email because you created this invitation, or manage the members of ${org}.`,
  },
  calendar: {
    subject: "You're invited to an event",
    preheader: (when: string) => `${when}. See it in the calendar.`,
    headline: "You're invited to an event",
    facts: { event: "Event", when: "When", org: "Workspace", by: "Invited by" },
    someone: "Someone",
    button: "See the event",
    why: (org: string) => `You got this email because someone at ${org} invited you to an event.`,
  },
  waitlist: {
    subject: "Confirm your spot on the agentes.chat waiting list",
    preheader: "One click and your spot is saved.",
    headline: "Confirm your spot on the list",
    body: (email: string | null): Text =>
      email
        ? ["We got a request to put ", { b: email }, " on the agentes.chat waiting list."]
        : "We got a request to put this address on the agentes.chat waiting list.",
    approve: "Here, nothing important happens without a person approving it. That goes for this request too.",
    button: "Confirm my email",
    small:
      "The link works for 48 hours. Wasn't you? Ignore this email. Without the click, the address never joins the list.",
    why: "You got this email because this address was entered on the agentes.chat waiting list.",
  },
  earlyAccess: {
    subject: "Your invitation to agentes.chat is here",
    preheader: (days: number) => `Create your account within ${days} days, with this email address.`,
    headline: "Your access is ready",
    body: (email: string): Text => [{ b: email }, " can now create an account and a workspace on agentes.chat."],
    what: "agentes.chat is where people and AI agents work together.",
    button: "Create my account",
    small: (days: number) =>
      `The link works for ${days} days, for this address only. Sign up with a password, or with Google, GitHub or Apple on this same address.`,
    why: "You got this email because this address is on the agentes.chat waiting list, or was invited to agentes.chat. Nothing happens until you sign up.",
  },
  earlyAccessAllowed: {
    subject: "You can now create your own workspace",
    preheader: "Sign in with the account you already have and set it up.",
    headline: "Create your own workspace",
    body: (email: string): Text => [
      "You can now create your own workspace on agentes.chat with ",
      { b: email },
      ", the account you already have.",
    ],
    button: "Create my workspace",
    why: "You got this email because this account was given early access to agentes.chat.",
  },
  budget: {
    subject: {
      warning: "An agent passed 80% of its monthly budget",
      exhausted: "An agent stopped: monthly budget reached",
    },
    preheader: {
      warning: "At 100% it stops until the month turns or the limit goes up.",
      exhausted: "It won't answer until the month turns or the limit goes up.",
    },
    headline: { warning: "An agent passed 80% of its budget", exhausted: "An agent reached its budget" },
    used: (pct: string, org: string) => `Used ${pct} of this month's budget · ${org}`,
    warning: "At 100% it stops and says so in the channel. An admin can change the limit on the agent's page.",
    exhausted: "It won't answer until the month turns, or until an admin raises the limit.",
    button: "See the budget",
    why: (org: string) =>
      `You got this email because you own this agent, or are an admin of ${org}. It goes out at 80% and at 100%, once a month each.`,
  },
  digest: {
    subject: (n: number) =>
      n === 1 ? "A request is waiting for your approval" : `${n} requests are waiting for your approval`,
    preheader: "Requests expire after 24 hours, and nothing runs without a decision.",
    headline: (n: number) => (n === 1 ? "A request is waiting for you" : `${n} requests are waiting for you`),
    body: (n: number, org: string): Text =>
      n === 1
        ? ["In ", { b: org }, ", an agent asked to do something only a person can approve."]
        : ["In ", { b: org }, ", agents asked to do things only a person can approve."],
    age: (h: number) => `${h}\u00a0h\u00a0ago`,
    more: (k: number) => `And ${k} more.`,
    button: (n: number): string => (n === 1 ? "Review the request" : "Open approvals"),
    why: (org: string, hours: number | undefined) =>
      `You got this email because you can approve these requests in ${org}.${hours ? ` It goes out when a request waits more than ${hours} hours, once per request.` : ""}`,
  },
  ready: {
    subject: "Your agents' computer is ready",
    preheader: {
      ai: "Next: connect your AI, so your agents can think.",
      task: "Next: give your agents a first task.",
      create: "Next: create your first agent.",
    },
    headline: "Your agents' computer is ready",
    /** The picture's alt text: the computer, with the agents around it. */
    computer: "Your agents' computer",
    body: (org: string): Text => [
      "Thanks for waiting. ",
      { b: org },
      "'s computer is on and set up, with a user of its own for each agent. It stays on day and night, so your agents can work any time.",
    ],
    facts: { cpus: "CPUs", memory: "Memory", disk: "Disk" },
    next: "Next steps",
    steps: {
      ai: [
        "Connect your AI.",
        "Sign in with your Claude or ChatGPT plan, another AI's coding plan, or an API key. Your agents think with it.",
      ] as Step,
      task: ["Give a first task.", "In #general, call an agent with @ and say what you need."] as Step,
      watch: [
        "Watch them work.",
        "On an agent's page, press Open to see its computer live. Take control whenever you want, and hand it back when you're done.",
      ] as Step,
      create: ["Create an agent.", "It works on this computer from the start."] as Step,
    },
    button: { ai: "Connect your AI", task: "Give a first task", create: "Create an agent" },
    why: (org: string) =>
      `You got this email because you own ${org} on agentes.chat. It's the only email about this computer.`,
  },
  joinRequest: {
    subject: "Someone asks to join your workspace",
    preheader: "Approve or deny it in Members. Nothing happens until you answer.",
    headline: "A request to join is waiting",
    body: (org: string): Text => ["They opened ", { b: org }, "'s invitation link and asked to join."],
    note: "Approve only people you expect. They join as a member unless you pick another role on the page.",
    approve: "Approve",
    deny: "Deny",
    more: "All waiting requests are in Members." as Text,
    why: (org: string) =>
      `You got this email because you're an owner or admin of ${org}. It goes out at most once an hour.`,
  },
  joinAnswer: {
    someone: "Someone",
    joined: {
      subject: "Your request to join was approved",
      preheader: "You're in. Open the workspace to start.",
      headline: "You're in",
      body: (who: string, org: string, role: string): Text => [
        `${who} approved your request. You joined `,
        { b: org },
        ` as ${role}.`,
      ],
      button: "Open the workspace",
    },
    invited: {
      subject: "Your request to join was approved",
      preheader: "One step left: accept the invitation within 7 days.",
      headline: "Approved: one step left",
      body: (who: string, org: string): Text => [`${who} approved your request to join `, { b: org }, "."],
      next: "Accept the invitation with this email address within 7 days.",
      button: "Accept invitation",
    },
    denied: {
      subject: "Your request to join wasn't approved",
      preheader: "Someone at the workspace looked at it and didn't approve it.",
      headline: "Your request wasn't approved",
      body: (org: string): Text => ["Someone at ", { b: org }, " looked at your request and didn't approve it."],
      reason: (reason: string): Text => [{ b: "Their note: " }, `“${reason}”`],
      small: "If you think it's a mistake, ask someone there to invite you by email.",
    },
    why: (org: string) => `You got this email because this address asked to join ${org} on agentes.chat.`,
  },
  joinCode: {
    subject: (code: string) => `${code} is your agentes.chat code`,
    preheader: "Type it on the page to ask to join. It works for 10 minutes.",
    headline: "Your code",
    body: (org: string): Text => ["Type this code on the page to ask to join ", { b: org }, "."],
    small: ["It works for 10 minutes. If you didn't ask, ", { nobr: "ignore this email." }] as Text,
    why: (org: string) =>
      `You got this email because someone typed this address to ask to join ${org} on agentes.chat.`,
  },
  deletionCode: {
    subjectWorkspace: (code: string) => `${code} is your code to delete a workspace`,
    subjectAccount: (code: string) => `${code} is your code to delete your account`,
    preheader: "Type it in agentes.chat to confirm. It works for 10 minutes.",
    headline: "Your code",
    workspace: (org: string): Text => [
      "Type this code to delete the workspace ",
      { b: org },
      ". It closes for everyone at once and is deleted for good 7 days later.",
    ],
    account: (email: string): Text => [
      "Type this code to delete the account ",
      { b: email },
      ". It goes at once, and the workspaces only you are in close with it.",
    ],
    support: (address: string): Text => [
      "It works for 10 minutes, and nothing is deleted without it. If it wasn't you, don't share it and write to ",
      { mail: address },
      ".",
    ],
    noSupport:
      "It works for 10 minutes, and nothing is deleted without it. If it wasn't you, don't share it and tell the people who run this server." as Text,
    whyWorkspace: (org: string) => `You got this email because your account asked to delete ${org} on agentes.chat.`,
    whyAccount: "You got this email because your account asked to be deleted on agentes.chat.",
  },
  deleting: {
    subject: (day: string) => `A workspace you're in will be deleted on ${day}`,
    preheader: "It's closed now. An owner can still restore it until then.",
    headline: "A workspace is being deleted",
    body: (by: string, org: string, day: string, time: string): Text => [
      { b: by },
      " deleted the workspace ",
      { b: org },
      `. It's closed now and goes for good on ${day} at ${time}.`,
    ],
    owner: "Changed your mind? Restore it before then.",
    button: "Restore the workspace",
    member: "If it's a mistake, ask an owner to restore it." as Text,
    why: (org: string) => `You got this email because you're in ${org} on agentes.chat.`,
  },
  restored: {
    subject: "A workspace you're in is back",
    preheader: "An owner restored it. It works again.",
    headline: "The workspace is back",
    body: (by: string, org: string): Text => [{ b: by }, " restored ", { b: org }, ". It works again."],
    button: "Open the workspace",
    why: (org: string) => `You got this email because you're in ${org} on agentes.chat.`,
  },
  accountDeleted: {
    subject: "Your agentes.chat account was deleted",
    preheader: "It's signed out everywhere and can't sign in again.",
    headline: "Your account was deleted",
    body: (email: string): Text => ["We deleted the account ", { b: email }, "."],
    closes: (count: number, day: string, names: Inline[]): Text => [
      count === 1
        ? `The workspace only you were in is closed and will be deleted for good on ${day}: `
        : `The workspaces only you were in are closed and will be deleted for good on ${day}: `,
      ...names,
      ".",
    ],
    support: (address: string): Text => ["If it wasn't you, write to ", { mail: address }, "."],
    noSupport: "If it wasn't you, tell the people who run this server." as Text,
    why: "You got this email because this address had an account on agentes.chat.",
  },
};

type Words = typeof en;

const ptBR: Words = {
  sentBy: (host) => (host ? atHost("Enviado pelo servidor do agentes.chat", "em", host) : "Enviado pelo agentes.chat."),
  fallback: "O botão não funcionou? Copie e cole este endereço no navegador:",
  role: { owner: "dono", member: "membro" },
  anAgent: "Um agente",
  someone: "Alguém",
  verify: {
    subject: "Confirme seu e-mail no agentes.chat",
    preheader: "Um clique para confirmar este endereço. O link vale por uma hora.",
    headline: "Confirme seu e-mail",
    body: "Falta um passo: confirmar que este endereço é seu.",
    button: "Confirmar e-mail",
    small: "O link vale por uma hora. Se não foi você que se cadastrou, pode ignorar este e-mail.",
    why: "Você recebeu este e-mail porque este endereço foi usado para criar uma conta no agentes.chat.",
  },
  reset: {
    subject: "Redefina sua senha do agentes.chat",
    preheader: "Escolha uma senha nova. O link vale por uma hora.",
    headline: "Escolha uma senha nova",
    body: "Recebemos um pedido para redefinir a senha deste endereço.",
    button: "Escolher senha nova",
    note: "Não pediu isso? Ignore este e-mail. Sua senha continua a mesma.",
    small: "O link vale por uma hora.",
    why: "Você recebeu este e-mail porque alguém pediu para redefinir a senha deste endereço no agentes.chat.",
  },
  invitation: {
    subject: "Você recebeu um convite para um workspace no agentes.chat",
    preheader: "Aceite em até 7 dias, com este endereço de e-mail.",
    headline: "Você recebeu um convite",
    body: (inviter, email, org, role) =>
      inviter
        ? [{ b: inviter }, `${email ? ` (${email})` : ""} convidou você para entrar na `, { b: org }, ` como ${role}.`]
        : ["Você recebeu um convite para entrar na ", { b: org }, ` como ${role}.`],
    what: "O agentes.chat é onde pessoas e agentes de IA trabalham juntos.",
    noteFrom: (inviter, note) => [{ b: inviter ? `${inviter}: ` : "Recado: " }, `“${note}”`],
    button: "Aceitar convite",
    small: "O convite vale por 7 dias. Aceite com este endereço de e-mail.",
    why: (org) =>
      `Você recebeu este e-mail porque alguém da ${org} convidou este endereço. Se não conhece essa pessoa, ignore. Nada acontece até você aceitar.`,
  },
  inviteRequest: {
    subject: "Pediram um novo convite",
    preheader: "O convite expirou. Dá para mandar um novo em Membros.",
    headline: "Pediram um novo convite",
    body: (email, org) =>
      email
        ? [{ b: email }, " abriu um convite vencido da ", { b: org }, " e pediu um novo."]
        : ["Alguém com um link de convite vencido da ", { b: org }, " pediu um novo."],
    next: "Se você espera essa pessoa, mande um novo convite em Membros. Se não, não precisa fazer nada.",
    button: "Abrir Membros",
    why: (org) => `Você recebeu este e-mail porque criou este convite, ou cuida dos membros da ${org}.`,
  },
  calendar: {
    subject: "Você recebeu um convite para um evento",
    preheader: (when) => `${when}. Veja no calendário.`,
    headline: "Convite para um evento",
    facts: { event: "Evento", when: "Quando", org: "Workspace", by: "Convite de" },
    someone: "Alguém",
    button: "Ver o evento",
    why: (org) => `Você recebeu este e-mail porque alguém da ${org} convidou você para um evento.`,
  },
  waitlist: {
    subject: "Confirme seu lugar na lista do agentes.chat",
    preheader: "Um clique e seu lugar está guardado.",
    headline: "Confirme seu lugar na lista",
    body: (email) =>
      email
        ? ["Recebemos um pedido para colocar ", { b: email }, " na lista de espera do agentes.chat."]
        : "Recebemos um pedido para colocar este endereço na lista de espera do agentes.chat.",
    approve: "Aqui, nada importante acontece sem uma pessoa aprovar. Isso vale para este pedido também.",
    button: "Confirmar meu e-mail",
    small: "O link vale por 48 horas. Não foi você? Ignore este e-mail. Sem o clique, o endereço não entra na lista.",
    why: "Você recebeu este e-mail porque este endereço foi informado na lista de espera do agentes.chat.",
  },
  earlyAccess: {
    subject: "Seu convite para o agentes.chat chegou",
    preheader: (days) => `Crie sua conta em até ${days} dias, com este endereço de e-mail.`,
    headline: "Seu acesso está pronto",
    body: (email) => [{ b: email }, " já pode criar uma conta e um workspace no agentes.chat."],
    what: "O agentes.chat é onde pessoas e agentes de IA trabalham juntos.",
    button: "Criar minha conta",
    small: (days) =>
      `O link vale por ${days} dias, só para este endereço. Cadastre-se com uma senha, ou com Google, GitHub ou Apple neste mesmo endereço.`,
    why: "Você recebeu este e-mail porque este endereço está na lista de espera do agentes.chat, ou foi convidado para o agentes.chat. Nada acontece até você se cadastrar.",
  },
  earlyAccessAllowed: {
    subject: "Agora você pode criar o seu workspace",
    preheader: "Entre com a conta que você já tem e monte o seu.",
    headline: "Crie o seu workspace",
    body: (email) => [
      "Agora você pode criar o seu workspace no agentes.chat com ",
      { b: email },
      ", a conta que você já tem.",
    ],
    button: "Criar meu workspace",
    why: "Você recebeu este e-mail porque esta conta ganhou acesso antecipado ao agentes.chat.",
  },
  budget: {
    subject: {
      warning: "Um agente passou de 80% do orçamento do mês",
      exhausted: "Um agente parou: orçamento do mês atingido",
    },
    preheader: {
      warning: "Em 100%, ele para até o mês virar ou o limite subir.",
      exhausted: "Ele não responde até o mês virar ou o limite subir.",
    },
    headline: { warning: "Um agente passou de 80% do orçamento", exhausted: "Um agente atingiu o orçamento" },
    used: (pct, org) => `Usou ${pct} do orçamento deste mês · ${org}`,
    warning: "Em 100%, ele para e avisa no canal. Um admin pode mudar o limite na página do agente.",
    exhausted: "Ele não responde até o mês virar, ou até um admin subir o limite.",
    button: "Ver o orçamento",
    why: (org) =>
      `Você recebeu este e-mail porque é dono deste agente, ou admin da ${org}. É enviado em 80% e em 100%, uma vez por mês cada.`,
  },
  digest: {
    subject: (n) => (n === 1 ? "Um pedido espera sua aprovação" : `${n} pedidos esperam sua aprovação`),
    preheader: "Pedidos expiram em 24 horas, e nada roda sem uma decisão.",
    headline: (n) => (n === 1 ? "Um pedido espera por você" : `${n} pedidos esperam por você`),
    body: (n, org) =>
      n === 1
        ? ["Na ", { b: org }, ", um agente pediu para fazer algo que só uma pessoa pode aprovar."]
        : ["Na ", { b: org }, ", agentes pediram para fazer coisas que só uma pessoa pode aprovar."],
    age: (h) => `há\u00a0${h}\u00a0h`,
    more: (k) => `E mais ${k}.`,
    button: (n) => (n === 1 ? "Ver o pedido" : "Abrir aprovações"),
    why: (org, hours) =>
      `Você recebeu este e-mail porque pode aprovar estes pedidos na ${org}.${hours ? ` É enviado quando um pedido espera mais de ${hours} horas, uma vez por pedido.` : ""}`,
  },
  ready: {
    subject: "O computador dos seus agentes está pronto",
    preheader: {
      ai: "Agora: conecte sua IA, para os agentes pensarem.",
      task: "Agora: passe a primeira tarefa aos agentes.",
      create: "Agora: crie o primeiro agente.",
    },
    headline: "O computador dos seus agentes está pronto",
    computer: "O computador dos seus agentes",
    body: (org) => [
      "Obrigado por esperar. O computador da ",
      { b: org },
      " está ligado e configurado, com um usuário só para cada agente. Ele fica ligado dia e noite, para os agentes trabalharem a qualquer hora.",
    ],
    facts: { cpus: "CPUs", memory: "Memória", disk: "Disco" },
    next: "Próximos passos",
    steps: {
      ai: [
        "Conecte sua IA.",
        "Entre com o seu plano do Claude ou do ChatGPT, com o plano de código de outra IA, ou com uma chave de API. É com ela que os agentes pensam.",
      ],
      task: ["Passe a primeira tarefa.", "No #general, chame um agente com @ e diga do que precisa."],
      watch: [
        "Veja os agentes trabalhando.",
        "Na página de um agente, clique em Abrir para ver o computador dele ao vivo. Assuma o controle quando quiser e devolva quando terminar.",
      ],
      create: ["Crie um agente.", "Ele trabalha neste computador desde o começo."],
    },
    button: { ai: "Conectar sua IA", task: "Passar a primeira tarefa", create: "Criar um agente" },
    why: (org) =>
      `Você recebeu este e-mail porque é dono da ${org} no agentes.chat. É o único e-mail sobre este computador.`,
  },
  joinRequest: {
    subject: "Alguém pede para entrar no seu workspace",
    preheader: "Aprove ou recuse em Membros. Nada acontece até você responder.",
    headline: "Um pedido para entrar espera por você",
    body: (org) => ["Essa pessoa abriu o link de convite da ", { b: org }, " e pediu para entrar."],
    note: "Aprove só quem você espera. A pessoa entra como membro, a não ser que você escolha outro papel na página.",
    approve: "Aprovar",
    deny: "Recusar",
    more: ["Todos os pedidos ", { nobr: "em espera estão em Membros." }],
    why: (org) => `Você recebeu este e-mail porque é dono ou admin da ${org}. É enviado no máximo uma vez por hora.`,
  },
  joinAnswer: {
    someone: "Alguém",
    joined: {
      subject: "Seu pedido para entrar foi aprovado",
      preheader: "Você já está dentro. Abra o workspace para começar.",
      headline: "Você entrou",
      body: (who, org, role) => [`${who} aprovou seu pedido. Você entrou na `, { b: org }, ` como ${role}.`],
      button: "Abrir o workspace",
    },
    invited: {
      subject: "Seu pedido para entrar foi aprovado",
      preheader: "Falta um passo: aceite o convite em até 7 dias.",
      headline: "Aprovado: falta um passo",
      body: (who, org) => [`${who} aprovou seu pedido para entrar na `, { b: org }, "."],
      next: "Aceite o convite com este endereço de e-mail em até 7 dias.",
      button: "Aceitar convite",
    },
    denied: {
      subject: "Seu pedido para entrar não foi aprovado",
      preheader: "Alguém do workspace viu e não aprovou.",
      headline: "Seu pedido não foi aprovado",
      body: (org) => ["Alguém da ", { b: org }, " viu seu pedido e não aprovou."],
      reason: (reason) => [{ b: "Recado: " }, `“${reason}”`],
      small: "Se acha que foi engano, peça a alguém de lá para convidar você por e-mail.",
    },
    why: (org) => `Você recebeu este e-mail porque este endereço pediu para entrar na ${org} no agentes.chat.`,
  },
  joinCode: {
    subject: (code) => `${code} é seu código do agentes.chat`,
    preheader: "Digite na página para pedir para entrar. Vale por 10 minutos.",
    headline: "Seu código",
    body: (org) => ["Digite este código na página para pedir para entrar na ", { b: org }, "."],
    small: ["Vale por 10 minutos. Se não foi você, ", { nobr: "ignore este e-mail." }],
    why: (org) =>
      `Você recebeu este e-mail porque alguém digitou este endereço para pedir para entrar na ${org} no agentes.chat.`,
  },
  deletionCode: {
    subjectWorkspace: (code) => `${code} é seu código para apagar um workspace`,
    subjectAccount: (code) => `${code} é seu código para apagar sua conta`,
    preheader: "Digite no agentes.chat para confirmar. Vale por 10 minutos.",
    headline: "Seu código",
    workspace: (org) => [
      "Digite este código para apagar o workspace ",
      { b: org },
      ". Ele fecha para todos na hora e é apagado de vez 7 dias depois.",
    ],
    account: (email) => [
      "Digite este código para apagar a conta ",
      { b: email },
      ". Ela some na hora, e os workspaces em que só você está fecham com ela.",
    ],
    support: (address) => [
      "Vale por 10 minutos, e nada é apagado sem ele. Se não foi você, não passe para ninguém e escreva para ",
      { mail: address },
      ".",
    ],
    noSupport:
      "Vale por 10 minutos, e nada é apagado sem ele. Se não foi você, não passe para ninguém e avise quem cuida deste servidor.",
    whyWorkspace: (org) =>
      `Você recebeu este e-mail porque sua conta pediu para apagar o workspace ${org} no agentes.chat.`,
    whyAccount: "Você recebeu este e-mail porque sua conta pediu para ser apagada no agentes.chat.",
  },
  deleting: {
    subject: (day) => `Um workspace em que você está vai ser apagado em ${day}`,
    preheader: "Ele está fechado agora. Um dono ainda pode restaurar até lá.",
    headline: "Um workspace está sendo apagado",
    body: (by, org, day, time) => [
      { b: by },
      " apagou o workspace ",
      { b: org },
      `. Ele está fechado agora e some de vez em ${day} às ${time}.`,
    ],
    owner: "Mudou de ideia? Restaure antes disso.",
    button: "Restaurar o workspace",
    member: "Se foi um engano, peça para um dono restaurar.",
    why: (org) => `Você recebeu este e-mail porque está na ${org} no agentes.chat.`,
  },
  restored: {
    subject: "Um workspace em que você está voltou",
    preheader: "Um dono restaurou. Ele voltou a funcionar.",
    headline: "O workspace voltou",
    body: (by, org) => [{ b: by }, " restaurou ", { b: org }, ". Ele voltou a funcionar."],
    button: "Abrir o workspace",
    why: (org) => `Você recebeu este e-mail porque está na ${org} no agentes.chat.`,
  },
  accountDeleted: {
    subject: "Sua conta do agentes.chat foi apagada",
    preheader: "Ela saiu de todos os aparelhos e não entra mais.",
    headline: "Sua conta foi apagada",
    body: (email) => ["Apagamos a conta ", { b: email }, "."],
    closes: (count, day, names) => [
      count === 1
        ? `O workspace em que só você estava está fechado e vai ser apagado de vez em ${day}: `
        : `Os workspaces em que só você estava estão fechados e vão ser apagados de vez em ${day}: `,
      ...names,
      ".",
    ],
    support: (address) => ["Se não foi você, escreva para ", { mail: address }, "."],
    noSupport: "Se não foi você, avise quem cuida deste servidor.",
    why: "Você recebeu este e-mail porque este endereço tinha uma conta no agentes.chat.",
  },
};

export const WORDS: Record<EmailLocale, Words> = { en, "pt-BR": ptBR };
