/**
 * The app's own strings (pt-BR, the primary locale), under `mobile.*`.
 * They live here until they move into `@agenteschat/i18n` (packages/i18n); `./index.ts` merges them
 * into the shared resources at runtime. `keys.en.ts` must have exactly the same shape (typed below).
 */
export const mobilePtBR = {
  common: {
    back: "Voltar",
    cancel: "Cancelar",
    close: "Fechar",
    continue: "Continuar",
    done: "Pronto",
    retry: "Tentar de novo",
    loading: "Carregando",
    or: "ou",
  },
  auth: {
    skyLabel: "Céu com agentes",
    social: {
      failed: "Não deu para entrar agora. Tente de novo.",
    },
    errors: {
      network: "Sem conexão. Confira a internet e tente de novo.",
      generic: "Algo deu errado. Tente de novo.",
    },
  },
  org: {
    noneTitle: "Você ainda não está em uma organização",
    noneSubtitle: "Peça um convite a alguém do seu time, ou crie a organização pelo site.",
    openSite: "Abrir o site",
    signOut: "Sair",
  },
  account: {
    deleteSoleOwner:
      "Você é a única pessoa dona de uma organização com outros membros. Passe a organização para alguém antes de apagar sua conta.",
    deleteFailed: "Não deu para apagar sua conta agora. Tente de novo.",
    deleted: "Sua conta foi apagada.",
    signedOut: "Você saiu.",
  },
  theme: {
    system: "Igual ao celular",
    light: "Claro",
    dark: "Escuro",
  },
  push: {
    channel: "Avisos",
    channelDescription: "O que espera você, menções e conversas.",
  },
  a11y: {
    agent: "{{name}}, agente",
    agentWorking: "{{name}}, agente, trabalhando",
    agentPlain: "Agente",
    person: "{{name}}",
    loading: "Carregando",
    grabber: "Arraste para baixo para fechar",
    closeSheet: "Fechar",
    send: "Enviar",
    attach: "Anexar e mais",
    hold: "Segure para confirmar",
    clearSearch: "Limpar busca",
  },
  composer: {
    placeholder: "Escreva uma mensagem",
    join: "Juntar ao que está fazendo",
    now: "Parar e mandar",
    choice: "Como mandar enquanto o agente trabalha",
  },
  search: {
    placeholder: "Buscar",
  },
};

type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/** Every locale of the app's strings has this shape. */
export type MobileTranslations = Shape<typeof mobilePtBR>;
