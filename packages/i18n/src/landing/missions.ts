import type { Widen } from "../widen";

/** Landing page strings: missions. pt-BR is the source; en is typed against it. */
export const pt = {
  missions: {
    eyebrow: "03 · Missões",
    title: "Trabalho de dias, com plano e prestação de contas.",
    lead: "Para o que não cabe numa mensagem. Os agentes montam o plano, dividem as partes, trazem as decisões para você e entregam com recibo. Arraste para ver a missão andar.",
    mission: {
      title: "Migrar o checkout para o novo gateway",
      meta: "Missão · aberta por {{person}} · {{a}}, {{b}} e {{c}}",
    },
    plan: {
      docs: "Ler a documentação do gateway novo",
      find: "Achar onde o checkout chama o gateway antigo",
      keys: "Criar as chaves do ambiente de teste",
      swap: "Trocar as chamadas e rodar os testes",
      compare: "Comparar 1.000 cobranças nos dois gateways",
      staging: "Publicar no staging",
      prod: "Virar a chave em produção",
    },
    feed: {
      title: "Andamento",
      sub: "O que os agentes contam enquanto trabalham",
      plan: "Plano montado: 7 passos, 3 agentes.",
      found: "Achei 4 lugares que chamam o gateway antigo.",
      asked: "Perguntei à Nina o volume de cobranças por dia: 3.200.",
      tests: "Testes passando: 212 de 212.",
      cents: "3 cobranças deram diferença de centavos, por arredondamento.",
      staging: "Staging publicado depois da aprovação do Rafael.",
      prod: "Produção virada. Nenhum erro em 1 hora. Missão concluída.",
    },
    when: "Dia {{day}} · {{time}}",
    day: "Dia {{day}}",
    delivered: "Entregue",
    scrub: "Andamento da missão",
    play: "Tocar",
    decision: {
      lead: "Decisão para o {{name}}:",
      question: "aceitar o arredondamento do gateway novo?",
      accept: "Aceitar",
      other: "Pedir outra opção",
      accepted: "{{name}} aceitou",
    },
  },
};

export const en: Widen<typeof pt> = {
  missions: {
    eyebrow: "03 · Missions",
    title: "Multi-day work, with a plan and accountability.",
    lead: "For what doesn't fit in a message. The agents build the plan, split the work, bring decisions to you and deliver with a receipt. Drag to watch the mission move.",
    mission: {
      title: "Migrate checkout to the new gateway",
      meta: "Mission · opened by {{person}} · {{a}}, {{b}} and {{c}}",
    },
    plan: {
      docs: "Read the new gateway's docs",
      find: "Find where checkout calls the old gateway",
      keys: "Create the test environment keys",
      swap: "Swap the calls and run the tests",
      compare: "Compare 1,000 charges on both gateways",
      staging: "Publish to staging",
      prod: "Flip the switch in production",
    },
    feed: {
      title: "Progress",
      sub: "What the agents share while they work",
      plan: "Plan ready: 7 steps, 3 agents.",
      found: "Found 4 places that call the old gateway.",
      asked: "I asked Nina for the daily charge volume: 3,200.",
      tests: "Tests passing: 212 of 212.",
      cents: "3 charges were off by a few cents, due to rounding.",
      staging: "Staging published after Rafael's approval.",
      prod: "Production switched. No errors in 1 hour. Mission complete.",
    },
    when: "Day {{day}} · {{time}}",
    day: "Day {{day}}",
    delivered: "Delivered",
    scrub: "Mission progress",
    play: "Play",
    decision: {
      lead: "Decision for {{name}}:",
      question: "accept the new gateway's rounding?",
      accept: "Accept",
      other: "Ask for another option",
      accepted: "{{name}} accepted",
    },
  },
};
