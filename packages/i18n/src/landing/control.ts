import type { Widen } from "../widen";

/** Landing page strings: control. pt-BR is the source; en is typed against it. */
export const pt = {
  control: {
    eyebrow: "07 · Controle",
    title: "Autonomia com limite e recibo.",
    lead: "Ler e investigar nunca pede licença. Agir no mundo real pede. E cada chamada fica registrada com o agente e o custo.",
    exactTitle: "A ação exata, não um “posso?”",
    exact:
      "O pedido mostra o que vai rodar e com quais valores. Expira se ninguém decidir. O que é arriscado pede para segurar o botão.",
    ask: {
      title: "Theo quer enviar o e-mail de lançamento",
      to: "Para",
      toValue: "Lista “clientes” · 4.120 pessoas",
      subject: "Assunto",
      subjectValue: "Agora com Linear",
      approved: "Aprovado por você · enviado",
    },
    ownerTitle: "Uma pessoa por trás de cada agente",
    owner:
      "Ela recebe os pedidos, define o orçamento e vê o uso de cada um. Valores em dinheiro só para quem administra.",
    usage: "Uso do orçamento de {{agent}}",
    keysTitle: "Chaves que ninguém vê",
    keys: "Credenciais ficam cifradas no seu workspace e nunca chegam ao navegador. Segredos vão ao computador do agente de ponta a ponta.",
    lesson: "Recusou? O motivo vira lição para a próxima vez.",
  },
};

export const en: Widen<typeof pt> = {
  control: {
    eyebrow: "07 · Control",
    title: "Autonomy with limits and a receipt.",
    lead: "Reading and investigating never asks for permission. Acting in the real world does. And every call is logged with the agent and the cost.",
    exactTitle: "The exact action, not a “can I?”",
    exact:
      "The request shows what will run and with which values. It expires if nobody decides. Anything risky asks you to hold the button.",
    ask: {
      title: "Theo wants to send the launch email",
      to: "To",
      toValue: "List “customers” · 4,120 people",
      subject: "Subject",
      subjectValue: "Now with Linear",
      approved: "Approved by you · sent",
    },
    ownerTitle: "A person behind every agent",
    owner: "She gets the requests, sets the budget and sees each one's usage. Money amounts only for admins.",
    usage: "{{agent}}'s budget used",
    keysTitle: "Keys nobody sees",
    keys: "Credentials stay encrypted in your workspace and never reach the browser. Secrets go to the agent's computer end to end.",
    lesson: "Declined? The reason becomes a lesson for next time.",
  },
};
