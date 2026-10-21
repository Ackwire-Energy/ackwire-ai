import type { Widen } from "../widen";

/** Landing page strings: onboarding. pt-BR is the source; en is typed against it. */
export const pt = {
  onboarding: {
    eyebrow: "08 · Começar",
    title: "Pronto em cinco minutos.",
    lead: "Uma pergunta por vez, com uma resposta já sugerida. Traga a wiki do Obsidian e os agentes que você já tem em outros apps.",
    rail: "Etapas para começar",
    done: "concluída",
    selected: "marcado",
    skip: "Pular esta etapa",
    steps: {
      company: {
        name: "Empresa",
        say: "Oi! Eu sou a Ada e vou te ajudar a começar. Como se chama a empresa?",
        cta: "Continuar",
      },
      about: {
        name: "O que vocês fazem",
        say: "Em uma frase, o que a {{org}} faz? Isso entra no contexto de todos os agentes.",
        answer: "Loja online de café",
        cta: "Continuar",
        opts: { shop: "Loja online de café especial", wiki: "Importar a wiki do Obsidian" },
      },
      code: {
        name: "Código",
        say: "Vocês têm código no GitHub?",
        cta: "Conectar",
        opts: { repo: "Conectar {{repo}}", none: "Não temos código" },
      },
      agents: {
        name: "Agentes",
        say: "Quem entra no time primeiro? Já deixei três marcados.",
        answer: "Dev, Theo e Nina",
        cta: "Criar 3 agentes",
        opts: {
          dev: "{{name}} · desenvolvimento",
          theo: "{{name}} · marketing",
          nina: "{{name}} · dados",
          import: "Trazer agentes de outros apps",
        },
      },
      tools: {
        name: "Ferramentas",
        say: "Onde o trabalho de vocês acontece?",
        answer: "3 conectores",
        cta: "Conectar 3",
        opts: { three: "Sentry, Linear e Google Drive", later: "Escolher depois" },
      },
      team: {
        name: "Time",
        say: "Quem você quer chamar agora?",
        answer: "2 convites",
        cta: "Convidar 2",
      },
      ready: {
        name: "Pronto",
        say: "Tudo pronto. O {{name}} já está lendo o repositório e vai te mandar um resumo no canal.",
        cta: "Abrir o app",
      },
    },
  },
};

export const en: Widen<typeof pt> = {
  onboarding: {
    eyebrow: "08 · Getting started",
    title: "Ready in five minutes.",
    lead: "One question at a time, with an answer already suggested. Bring your Obsidian wiki and the agents you already have in other apps.",
    rail: "Getting started steps",
    done: "done",
    selected: "selected",
    skip: "Skip this step",
    steps: {
      company: {
        name: "Company",
        say: "Hi! I'm Ada and I'll help you get started. What's the company called?",
        cta: "Continue",
      },
      about: {
        name: "What you do",
        say: "In one sentence, what does {{org}} do? This goes into every agent's context.",
        answer: "Online coffee shop",
        cta: "Continue",
        opts: { shop: "Online specialty coffee shop", wiki: "Import the Obsidian wiki" },
      },
      code: {
        name: "Code",
        say: "Do you have code on GitHub?",
        cta: "Connect",
        opts: { repo: "Connect {{repo}}", none: "We don't have code" },
      },
      agents: {
        name: "Agents",
        say: "Who joins the team first? I've already picked three.",
        answer: "Dev, Theo and Nina",
        cta: "Create 3 agents",
        opts: {
          dev: "{{name}} · development",
          theo: "{{name}} · marketing",
          nina: "{{name}} · data",
          import: "Bring agents from other apps",
        },
      },
      tools: {
        name: "Tools",
        say: "Where does your work happen?",
        answer: "3 connectors",
        cta: "Connect 3",
        opts: { three: "Sentry, Linear and Google Drive", later: "Choose later" },
      },
      team: {
        name: "Team",
        say: "Who do you want to invite now?",
        answer: "2 invites",
        cta: "Invite 2",
      },
      ready: {
        name: "Done",
        say: "All set. {{name}} is already reading the repository and will send you a summary in the channel.",
        cta: "Open the app",
      },
    },
  },
};
