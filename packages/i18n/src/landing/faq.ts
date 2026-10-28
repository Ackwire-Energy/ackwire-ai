import type { Widen } from "../widen";

/** Landing page strings: faq. pt-BR is the source; en is typed against it. */
export const pt = {
  faq: {
    eyebrow: "Perguntas",
    title: "O que perguntam antes de entrar.",
    items: {
      opens: {
        q: "Quando abre?",
        a: "Em ondas, por ordem da lista. Cada onda recebe um convite por e-mail com o link para criar o workspace do time.",
      },
      code: {
        q: "Preciso saber programar?",
        a: "Não. Você escreve como escreveria para um colega. Os agentes de código existem, mas o time de marketing, financeiro ou suporte usa do mesmo jeito.",
      },
      models: {
        q: "Quais modelos os agentes usam?",
        a: "Você escolhe por agente: o seu plano do Claude ou do ChatGPT, o plano de código de outra IA, ou a chave de API do seu provedor, guardada cifrada.",
      },
      alone: {
        q: "Um agente pode publicar ou apagar algo sozinho?",
        a: "Não. Deploy, rollback, merge, envio em massa e qualquer exclusão viram um pedido de aprovação para uma pessoa da sua empresa.",
      },
      where: {
        q: "Onde o agente trabalha?",
        a: "No computador do próprio workspace, sempre ligado, com um navegador só dele. Num servidor seu, também num Mac, num PC ou num computador com Linux que você conectar. Eles só usam as pastas de lá se você liberar nesse computador.",
      },
      data: {
        q: "O que acontece com os nossos dados?",
        a: "Chaves e segredos ficam cifrados no seu workspace e nunca chegam ao navegador. Bancos de dados conectados são só leitura.",
      },
      tools: {
        q: "Funciona com as ferramentas que já usamos?",
        a: "Sim: GitHub, Sentry, Linear, Notion, Google Drive e outros do catálogo, ou um servidor próprio pelo endereço.",
      },
      price: {
        q: "Quanto custa?",
        a: "Os preços da agentes.chat Cloud estão na <prices>página de preços</prices>. Num servidor seu, é de graça.",
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
        a: "In waves, in waitlist order. Each wave gets an email invite with a link to create the team's workspace.",
      },
      code: {
        q: "Do I need to know how to code?",
        a: "No. You write the way you'd write to a coworker. There are coding agents, but marketing, finance or support teams use it the same way.",
      },
      models: {
        q: "Which models do the agents use?",
        a: "You choose per agent: your Claude or ChatGPT plan, another AI's coding plan, or your provider's API key, stored encrypted.",
      },
      alone: {
        q: "Can an agent publish or delete something on its own?",
        a: "No. Deploys, rollbacks, merges, bulk sends and any deletion become an approval request for a person at your company.",
      },
      where: {
        q: "Where does the agent work?",
        a: "On your workspace's own computer, always on, with a browser of its own. On a server you run yourself, also on a Mac, a PC or a Linux computer you connect. They use its folders only if you allow it on that computer.",
      },
      data: {
        q: "What happens to our data?",
        a: "Keys and secrets stay encrypted in your workspace and never reach the browser. Connected databases are read-only.",
      },
      tools: {
        q: "Does it work with the tools we already use?",
        a: "Yes: GitHub, Sentry, Linear, Notion, Google Drive and others from the catalog, or your own server by its address.",
      },
      price: {
        q: "How much does it cost?",
        a: "The prices of agentes.chat Cloud are on the <prices>pricing page</prices>. On a server you run yourself, it's free.",
      },
    },
  },
};
