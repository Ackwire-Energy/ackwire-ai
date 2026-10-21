import type { Widen } from "../widen";

/** Landing page strings: computer. pt-BR is the source; en is typed against it. */
export const pt = {
  computer: {
    eyebrow: "02 · Computador",
    title: "Um computador e um navegador para cada agente.",
    lead: "O agente entra em sites, preenche, baixa e roda código como uma pessoa faria. Quando precisa de um login ou de um código, chama você ali mesmo, sem sair do chat.",
    points: {
      live: { title: "Você vê tudo ao vivo", text: "A tela do navegador aparece dentro da mensagem." },
      login: {
        title: "Login é com você",
        text: "Ele pede, você assume, digita e devolve. Sua senha não passa pelo agente.",
      },
      drive: { title: "O resultado fica no Drive", text: "Arquivos, prints e relatórios salvos e versionados." },
    },
    brains: {
      label: "Quem pensa",
      where: "Na nuvem ou no seu Mac",
      subscription: "Use sua assinatura do Claude ou do ChatGPT",
      code: "Clona, testa e abre PR",
    },
    ask: "{{agent}}, baixa as notas de setembro do portal do fornecedor e confere com a planilha?",
    card: "Navegador da {{agent}}",
    head: {
      live: "{{agent}} está no navegador",
      need: "{{agent}} precisa de você",
      yours: "Você está no navegador da {{agent}}",
      done: "{{agent}} terminou",
    },
    liveNow: "ao vivo",
    waiting: "esperando",
    site: {
      name: "Portal do Fornecedor",
      email: "E-mail",
      password: "Senha",
      signIn: "Entrar",
      invoices: "Notas de setembro",
      download: "Baixar todas",
      downloading: "Baixando…",
    },
    handoff: {
      title: "Sua vez: faça o login",
      text: "Assuma o navegador, digite a senha e devolva. A {{agent}} não vê o que você digita.",
      take: "Assumir o navegador",
      control: "Você está no controle",
      ready: "Pronto?",
      giveBack: "Devolver à {{agent}}",
    },
    steps: {
      open: "Abriu o portal do fornecedor",
      need: "Precisa de você para entrar",
      back: "Você entrou e devolveu o navegador",
      download: "Baixou 5 notas de setembro",
      check: "Conferiu com a planilha: uma nota com R$ 0,50 de diferença",
      drive: "Salvou tudo no Drive em Financeiro/Notas",
    },
  },
};

export const en: Widen<typeof pt> = {
  computer: {
    eyebrow: "02 · Computer",
    title: "A computer and a browser for every agent.",
    lead: "The agent visits sites, fills things in, downloads and runs code like a person would. When it needs a login or a code, it calls you right there, without leaving the chat.",
    points: {
      live: { title: "You see everything live", text: "The browser screen shows up inside the message." },
      login: {
        title: "Logins are on you",
        text: "It asks, you take over, type and hand it back. Your password never goes through the agent.",
      },
      drive: { title: "The result lives in Drive", text: "Files, screenshots and reports saved and versioned." },
    },
    brains: {
      label: "Who thinks",
      where: "In the cloud or on your Mac",
      subscription: "Use your Claude or ChatGPT subscription",
      code: "Clones, tests and opens PRs",
    },
    ask: "{{agent}}, can you download September's invoices from the supplier portal and check them against the sheet?",
    card: "{{agent}}'s browser",
    head: {
      live: "{{agent}} is in the browser",
      need: "{{agent}} needs you",
      yours: "You're in {{agent}}'s browser",
      done: "{{agent}} is done",
    },
    liveNow: "live",
    waiting: "waiting",
    site: {
      name: "Supplier Portal",
      email: "Email",
      password: "Password",
      signIn: "Sign in",
      invoices: "September invoices",
      download: "Download all",
      downloading: "Downloading…",
    },
    handoff: {
      title: "Your turn: sign in",
      text: "Take over the browser, type the password and hand it back. {{agent}} doesn't see what you type.",
      take: "Take over the browser",
      control: "You're in control",
      ready: "Ready?",
      giveBack: "Hand back to {{agent}}",
    },
    steps: {
      open: "Opened the supplier portal",
      need: "Needs you to sign in",
      back: "You signed in and handed the browser back",
      download: "Downloaded 5 September invoices",
      check: "Checked against the sheet: one invoice off by R$ 0.50",
      drive: "Saved everything to Drive in Finance/Invoices",
    },
  },
};
