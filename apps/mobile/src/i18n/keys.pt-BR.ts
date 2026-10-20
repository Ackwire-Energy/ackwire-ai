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
    email: {
      title: "Qual é o seu e-mail?",
      subtitle: "Use o mesmo e-mail do seu trabalho.",
      placeholder: "voce@empresa.com",
      invalid: "Confira o e-mail. Parece que falta alguma coisa.",
    },
    signIn: {
      passwordTitle: "Sua senha",
      passwordSubtitle: "Para {{email}}",
      passwordPlaceholder: "Senha",
      submit: "Entrar",
      forgot: "Esqueci a senha",
      noAccount: "Ainda não tem conta?",
      createAccount: "Criar conta",
      wrong: "E-mail ou senha não conferem.",
    },
    social: {
      google: "Continuar com Google",
      apple: "Continuar com Apple",
      failed: "Não deu para entrar agora. Tente de novo.",
    },
    signUp: {
      nameTitle: "Como podemos te chamar?",
      nameSubtitle: "Seu nome aparece para as pessoas e os agentes do seu time.",
      namePlaceholder: "Seu nome",
      passwordTitle: "Crie uma senha",
      passwordSubtitle: "Pelo menos 8 caracteres.",
      passwordPlaceholder: "Nova senha",
      tooShort: "A senha precisa de pelo menos 8 caracteres.",
      submit: "Criar conta",
      haveAccount: "Já tem conta?",
      signIn: "Entrar",
      closed: "Por enquanto, só entra quem recebe um convite.",
      taken: "Já existe uma conta com esse e-mail.",
    },
    forgot: {
      title: "Vamos trocar sua senha",
      subtitle: "Mandamos um link para o seu e-mail.",
      submit: "Mandar link",
      sentTitle: "Olhe seu e-mail",
      sentSubtitle: "Se existir uma conta com {{email}}, o link chega em instantes.",
      backToSignIn: "Voltar para entrar",
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
