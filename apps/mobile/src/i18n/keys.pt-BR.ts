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
    server: {
      line: "Servidor: {{host}} ·",
      change: "Trocar",
      title: "Seu servidor",
      subtitle: "O endereço do agentes.chat da sua equipe, o mesmo que aparece no navegador.",
      label: "Endereço do servidor",
      placeholder: "agentes.suaequipe.ts.net",
      use: "Usar este servidor",
      checking: "Conferindo…",
      scan: "Escanear QR code",
      backTo: "Voltar para {{host}}",
      now: "Agora em {{host}}",
      invalid: "Confira o endereço, algo como agentes.suaequipe.ts.net.",
      unreachable: "Não conseguimos falar com {{host}}. Confira o endereço e a internet, e tente de novo.",
      unreachableTailscale:
        "Não conseguimos falar com {{host}}. Ele está no Tailscale: abra o app do Tailscale, conecte e tente de novo.",
      certificate: "O certificado de {{host}} não é válido. Fale com quem cuida do servidor.",
      notAgentes: "{{host}} não é um servidor agentes.chat. Confira o endereço.",
      serverTooOld: "{{host}} precisa de uma atualização para funcionar com este app.",
      appTooOld: "Atualize o app agentes para usar {{host}}.",
      down: {
        line: "{{host}} não respondeu.",
        text: "Ele pode estar fora do ar ou fora da sua rede. O app abre sozinho quando ele voltar.",
      },
    },
    connect: {
      title: "Conectar a este servidor?",
      titleSignIn: "Entrar com a conta do computador?",
      on: "Servidor: {{host}}",
      leave: "Você sai da conta atual neste celular.",
      confirm: "Conectar",
      checking: "Conferindo o servidor…",
      notALink: "Este link não é de um servidor agentes.chat.",
      tokenFailed: "O código expirou ou já foi usado. Entre com seu e-mail, ou mostre um código novo no computador.",
      signInSlow:
        "Entrar está demorando mais que o normal. Entre com seu e-mail, ou mostre um código novo no computador.",
    },
    scan: {
      hint: "Aponte para o QR code que aparece no computador.",
      notOurs: "Esse QR code não é de um servidor agentes.chat.",
      cameraTitle: "Usar a câmera",
      cameraText: "Ela só serve para ler o QR code.",
      allow: "Permitir câmera",
      settings: "Abrir Ajustes",
    },
  },
  org: {
    noneTitle: "Você ainda não está em um workspace",
    noneSubtitle: "Peça um convite a alguém do seu time, ou crie o workspace pelo site.",
    openSite: "Abrir o site",
    signOut: "Sair",
  },
  account: {
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
    ask: {
      title: "Saiba quando um agente precisar de você",
      text: "Eles trabalham enquanto você faz outra coisa. Avisamos quando pedem seu ok, terminam o que você pediu ou chamam você.",
      on: "Ativar avisos",
      later: "Agora não",
      done: "Avisos ativados",
      failed: "Não deu para ativar os avisos. Tente de novo em Você\u00a0›\u00a0Notificações.",
      someone: "Um agente",
      examples: "Exemplos de avisos",
      now: "agora",
      minutes: "{{n}} min",
      approval: { title: "{{name}} pede seu ok", body: "Posso seguir com o que você pediu?" },
      finished: { title: "{{name}} terminou", body: "Está pronto o que você pediu." },
      mention: { title: "{{name}} chamou você", body: "Dá uma olhada quando puder?" },
    },
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
