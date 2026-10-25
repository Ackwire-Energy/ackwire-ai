import type { Widen } from "../widen";

/** Landing page strings: faq. pt-BR is the source; en is typed against it. */
export const pt = {
  faq: {
    eyebrow: "Perguntas",
    title: "O que perguntam antes de entrar.",
    items: {
      opens: {
        q: "Quando abre?",
        a: "Em ondas, por ordem da lista. Cada onda recebe um convite por e-mail com o link para criar o espaço do time.",
      },
      code: {
        q: "Preciso saber programar?",
        a: "Não. Você escreve como escreveria para um colega. Os agentes de código existem, mas o time de marketing, financeiro ou suporte usa do mesmo jeito.",
      },
      models: {
        q: "Quais modelos os agentes usam?",
        a: "Você escolhe por agente: a chave da plataforma, a do seu provedor (guardada cifrada) ou a sua assinatura do Claude ou do ChatGPT no computador conectado.",
      },
      alone: {
        q: "Um agente pode publicar ou apagar algo sozinho?",
        a: "Não. Deploy, rollback, merge, envio em massa e qualquer exclusão viram um pedido de aprovação para uma pessoa da sua empresa.",
      },
      where: {
        q: "Onde o agente trabalha?",
        a: "No computador do próprio workspace, na nuvem e sempre ligado, com um navegador só dele. Num servidor seu, também num Mac ou Linux que você conectar; pastas ali só com a sua liberação, dada nesse computador.",
      },
      data: {
        q: "O que acontece com os nossos dados?",
        a: "Chaves e segredos ficam cifrados na sua organização e nunca chegam ao navegador. Bancos de dados conectados são só leitura.",
      },
      tools: {
        q: "Funciona com as ferramentas que já usamos?",
        a: "Sim: GitHub, Sentry, Linear, Notion, Google Drive e outros do catálogo, ou um servidor próprio pelo endereço.",
      },
      price: {
        q: "Quanto vai custar?",
        a: "Os planos saem antes da abertura. Quem está na lista fica sabendo primeiro.",
      },
    },
  },
};

export const en: Widen<typeof pt> = {
  faq: {
    eyebrow: "FAQ",
    title: "What people ask before joining.",
    items: {
      opens: {
        q: "When does it open?",
        a: "In waves, in waitlist order. Each wave gets an email invite with a link to create the team's space.",
      },
      code: {
        q: "Do I need to know how to code?",
        a: "No. You write the way you'd write to a coworker. There are coding agents, but marketing, finance or support teams use it the same way.",
      },
      models: {
        q: "Which models do the agents use?",
        a: "You choose per agent: the platform's key, your provider's key (stored encrypted) or your Claude or ChatGPT subscription on the connected computer.",
      },
      alone: {
        q: "Can an agent publish or delete something on its own?",
        a: "No. Deploys, rollbacks, merges, bulk sends and any deletion become an approval request for a person at your company.",
      },
      where: {
        q: "Where does the agent work?",
        a: "On your workspace's own computer in the cloud, always on, with a browser of its own. On a server you run yourself, also on a Mac or Linux computer you connect; folders there only with your permission, granted on that computer.",
      },
      data: {
        q: "What happens to our data?",
        a: "Keys and secrets stay encrypted in your organization and never reach the browser. Connected databases are read-only.",
      },
      tools: {
        q: "Does it work with the tools we already use?",
        a: "Yes: GitHub, Sentry, Linear, Notion, Google Drive and others from the catalog, or your own server by its address.",
      },
      price: {
        q: "How much will it cost?",
        a: "Plans come out before launch. People on the waitlist hear first.",
      },
    },
  },
};
