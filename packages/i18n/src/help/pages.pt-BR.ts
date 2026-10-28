import type { HelpSlug } from "./index";
import type { HelpDocument } from "./types";

export const helpPtBR: Record<HelpSlug, HelpDocument> = {
  "run-on-your-computer": {
    title: "Rodar o agentes.chat no seu computador",
    summary:
      "O app do agentes.chat também roda o próprio agentes.chat, num Mac ou num computador com Linux, para você ou uma equipe pequena.",
    sections: [
      {
        id: "how",
        heading: "Como ele roda",
        blocks: [
          "Ele roda dentro do app, com um banco de dados embutido, e guarda tudo numa pasta deste computador, `~/.agentes`. Nada mais para instalar: sem Docker, sem banco para configurar.",
          "Ele liga junto com o app e para quando você fecha o app. Fechar pergunta antes, porque ninguém consegue usar o agentes.chat até o app abrir de novo.",
        ],
      },
      {
        id: "who",
        heading: "Para quem é",
        blocks: [
          "Feito para você ou uma equipe pequena, enquanto este computador estiver ligado. Para uma equipe maior, ou um servidor sempre ligado, instale o agentes.chat num servidor e escolha **Conectar ao meu servidor** no app. Os dados podem ir para lá depois.",
        ],
      },
      {
        id: "agents",
        heading: "Os agentes também trabalham aqui",
        blocks: [
          "Os agentes também trabalham neste computador, em pastas só deles, com um navegador e com o Claude Code ou o Codex quando estão instalados aqui. Comandos ficam desligados até você ligar em **Preferências\u00a0›\u00a0Ferramentas**.",
        ],
      },
      {
        id: "reach",
        heading: "Pelo celular e pela equipe",
        blocks: [
          "**Acessar pelo celular e pela equipe** coloca o agentes.chat no Tailscale, uma rede particular dos seus aparelhos: o seu celular e quem você convidar entram nela, e mais ninguém chega ao agentes.chat. O Tailscale é grátis: https://tailscale.com/download. Com isso desligado, o agentes.chat funciona só neste computador.",
        ],
      },
      {
        id: "backups",
        heading: "Backup e mudança",
        blocks: [
          "**Fazer backup agora**, em **Preferências\u00a0›\u00a0Servidores**, guarda o banco de dados, os arquivos e os ajustes em `~/.agentes/backups`.",
        ],
      },
    ],
  },
  computers: {
    title: "Computadores para os agentes",
    summary:
      "Os agentes rodam código e mexem em arquivos nos computadores que você conecta: um Mac com o app do agentes.chat, ou um servidor.",
    sections: [
      {
        id: "mac",
        heading: "Um Mac, com o app",
        blocks: [
          "O app do agentes.chat abre o seu servidor numa janela própria e, com um clique, os agentes dele trabalham nesse Mac, em pastas só deles. Instale o app, abra, escolha **Usar o seu próprio servidor\u00a0›\u00a0Conectar ao meu servidor** e digite o endereço do seu servidor. Depois, já dentro, clique em **Usar este Mac** em **Configurações\u00a0›\u00a0Computadores**.",
        ],
      },
      {
        id: "server",
        heading: "Um servidor ou um computador com Linux",
        blocks: [
          "Em **Configurações\u00a0›\u00a0Computadores**, copie o comando em **Outras formas** e rode no terminal desse computador. Ele mostra um código e um link: abra o link, confira se o código é o mesmo e confirme com a sua conta. Não precisa instalar nada antes.",
        ],
      },
      {
        id: "folders",
        heading: "Pastas",
        blocks: [
          "Cada agente sempre tem a própria pasta, em `~/agentes/<workspace>`. Pastas a mais se liberam no próprio computador, nunca pelo site: no app, em **Preferências\u00a0›\u00a0Pastas**. Cada workspace libera as próprias pastas: o que você libera para um vale só para os agentes dele. Remover uma pasta não apaga nada; só tira o acesso.",
        ],
      },
      {
        id: "pausing",
        heading: "Pausar",
        blocks: [
          "Quem conectou um computador pode pausar os agentes nele mesmo, pela barra de menus do app. Nada novo começa até retomar; o que já rodava termina.",
        ],
      },
      {
        id: "organizations",
        heading: "Vários workspaces",
        blocks: [
          "Um computador pode trabalhar para vários workspaces. Cada um tem ali os próprios agentes, pastas e tarefas, e desconectar um não mexe nos outros.",
        ],
      },
    ],
  },
  "workspace-computer": {
    title: "O computador do workspace",
    summary: "Todo workspace ganha um computador só dele, sempre ligado, onde os agentes trabalham.",
    sections: [
      {
        id: "what",
        heading: "O que é",
        blocks: [
          "Um computador só deste workspace, sempre ligado. Cada agente tem nele um usuário próprio, com a própria pasta, tela, navegador e arquivos. Pela página de um agente, dá para ver ele trabalhando e assumir o controle quando precisar.",
        ],
      },
      {
        id: "plans",
        heading: "Os seus planos de IA",
        blocks: [
          "Os agentes podem pensar com o seu próprio plano de IA, como Claude, ChatGPT, GLM ou Kimi, com login neste computador: sem chave de API. A conta fica neste computador, e o agentes.chat nunca vê a senha nem o acesso.",
          "Os planos Google AI Pro e Ultra não funcionam aqui: os termos do Google não permitem usá-los em outros produtos. Uma chave de API do Gemini funciona.",
        ],
      },
      {
        id: "size",
        heading: "O tamanho",
        blocks: ["As CPUs, a memória e o disco aparecem em **Configurações\u00a0›\u00a0Computadores**."],
      },
      {
        id: "trouble",
        heading: "Se ele parar de responder",
        blocks: ["Costuma voltar em poucos minutos, e já estamos cuidando: não há nada a fazer do seu lado."],
      },
    ],
  },
  import: {
    title: "Trazer os seus agentes",
    summary:
      "Traga agentes de outro app, ou de outro workspace do agentes.chat, com instruções, skills, rotinas e memória.",
    sections: [
      {
        id: "comes",
        heading: "O que vem junto",
        blocks: [
          {
            list: [
              "Agentes, com nome, papel, instruções e aparência.",
              "Skills. Chegam desligadas: ligue as que os agentes já devem usar.",
              "Canais públicos, com os agentes dentro.",
              "Rotinas. Chegam pausadas: você liga em **Rotinas** quando quiser.",
              "Memória: o que cada agente lembra.",
            ],
          },
        ],
      },
      {
        id: "never",
        heading: "O que nunca vem",
        blocks: [
          "Chaves, senhas, logins e histórico de conversa nunca vêm: os agentes usam o modelo e a chave do workspace. Algumas coisas ainda não têm equivalente aqui, ou nunca devem viajar num arquivo; dá para recriar depois.",
          "Arquivos e pastas são lidos no seu navegador; um link do GitHub passa pelo servidor do workspace. Arquivos de chaves e de login nunca são abertos, e nada muda até você confirmar.",
        ],
      },
      {
        id: "other-apps",
        heading: "De outro app",
        blocks: [
          "Escolha **Grok Bot**, **ChatGPT dots** ou **Outro app**. Copie o pedido, cole nesse app e traga o que ele devolver: solte o arquivo ou cole a resposta inteira. Onde cada app entrega:",
          {
            list: [
              "**Grok Bot**: na conversa com o seu bot. Ele responde com o JSON: copie a resposta inteira.",
              "**ChatGPT dots**: num chat novo. Baixe o arquivo que ele criar.",
              "**Claude**: numa conversa nova, ou no projeto dos seus agentes. Baixe o arquivo que ele criar.",
              "**Manus**: numa tarefa nova. O arquivo fica nos resultados da tarefa.",
              "**Rakazo**: mande para o seu agente. Ele responde com o JSON: copie a resposta inteira.",
              "**OpenBot**: sem pedido. Arraste a pasta do tenant (agents.yaml, agents/, model.yaml, skills.yaml) ou cole o link do GitHub dela.",
            ],
          },
        ],
      },
      {
        id: "export",
        heading: "Exportar um workspace",
        blocks: [
          "**Configurações\u00a0›\u00a0Importar e exportar\u00a0›\u00a0Exportar este workspace** baixa um arquivo .json, para levar os agentes a outro workspace ou guardar uma cópia. Vai no arquivo:",
          {
            list: [
              "Agentes, com instruções, modelo e aparência",
              "Skills, com o SKILL.md inteiro",
              "Canais públicos, com os agentes de cada um",
              "Rotinas agendadas (chegam pausadas do outro lado)",
              "A memória que todo mundo no workspace pode ver",
            ],
          },
          "Nunca vai:",
          {
            list: [
              "Chaves de API e senhas",
              "Conectores e logins",
              "Computadores",
              "Conversas, mensagens e canais privados",
              "Uso, custos e histórico de ações",
            ],
          },
          "Para usar o arquivo, abra **Configurações\u00a0›\u00a0Importar e exportar** no outro workspace e solte o .json.",
        ],
      },
    ],
  },
  wiki: {
    title: "A wiki",
    summary: "O que a empresa sabe, em páginas ligadas umas às outras.",
    sections: [
      {
        id: "links",
        heading: "Links",
        blocks: ["Digite [[ para ligar outra página. Os backlinks e o grafo mostram como as páginas se conectam."],
      },
      {
        id: "agents",
        heading: "Como os agentes usam",
        blocks: ["Os agentes leem a wiki quando respondem. Escrevem nela só quando alguém pede."],
      },
      {
        id: "obsidian",
        heading: "Trazer uma vault do Obsidian",
        blocks: [
          "Solte a pasta da vault, ou um .zip dela, no passo Contexto da configuração ou na importação da própria wiki. [[Links]], [[nota|apelido]] e [[nota#seção]] continuam funcionando. As tags vêm do frontmatter e do texto. Os anexos vão para o Drive, e imagens e arquivos incorporados viram cards na página. Callouts continuam callouts. Consultas do Dataview chegam como texto: peça a um agente para montar a tabela. Canvases e os ajustes do Obsidian (.obsidian) ficam de fora.",
        ],
      },
    ],
  },
  memory: {
    title: "Memória",
    summary: "O que cada agente aprende com as conversas e as correções do time.",
    sections: [
      {
        id: "learns",
        heading: "Como os agentes aprendem",
        blocks: [
          "Os agentes aprendem com as conversas e com as correções do time. O que um agente sabe entra no contexto dele quando for relevante. Na aba **Memória**, edite, fixe ou arquive o que estiver errado ou velho.",
        ],
      },
      {
        id: "permissions",
        heading: "Memória não dá permissão",
        blocks: [
          "Nada na memória deixa um agente fazer mais. O que ele pode fazer continua em **Ferramentas e acesso**, e ações sensíveis sempre pedem aprovação.",
        ],
      },
      {
        id: "proposals",
        heading: "Mudanças propostas",
        blocks: [
          "Quando uma lição se repete, o agente pode propor mudar as próprias instruções ou o contexto do workspace. Nada muda sem alguém aceitar, e dá para ajustar o texto antes. A versão anterior fica no histórico. Uma proposta recusada vira lição, para não ser proposta de novo.",
        ],
      },
    ],
  },
  approvals: {
    title: "Aprovações",
    summary: "Nada sensível acontece sem uma pessoa.",
    sections: [
      {
        id: "what",
        heading: "O que pede antes",
        blocks: [
          "Quando um agente quiser fazer merge, deploy, rollback, mandar algo para fora ou apagar dados, ele pede antes, qualquer que seja o acesso dele. O pedido aparece em **Aprovações** e no canal, com a ação exata e o porquê.",
        ],
      },
      {
        id: "exact",
        heading: "Uma aprovação, uma ação",
        blocks: [
          "Cada aprovação vale para uma ação exata, com os valores dela. Se o agente mudar qualquer coisa, precisa pedir de novo.",
        ],
      },
      {
        id: "who",
        heading: "Quem aprova",
        blocks: [
          "Quem é responsável pelo agente aprova os pedidos dele; num agente sem responsável, os admins aprovam.",
        ],
      },
      {
        id: "refusing",
        heading: "Recusar",
        blocks: ["Diga o porquê, se quiser: o agente lê, ajusta o plano e guarda como lição."],
      },
      {
        id: "meetings",
        heading: "Reuniões",
        blocks: ["Agentes só propõem horários. Convites para pessoas sempre passam por quem pediu."],
      },
    ],
  },
  "who-answers": {
    title: "Quem responde uma mensagem",
    summary: "Uma menção escolhe o agente. Sem ela, o agentes.chat escolhe por você, nesta ordem.",
    sections: [
      {
        id: "order",
        heading: "Como uma mensagem encontra o seu agente",
        blocks: [
          "Uma mensagem que @menciona um agente vai para esse agente. Uma mensagem que não menciona ninguém é lida pelo primeiro destes que o workspace tiver:",
          {
            list: [
              "**Jev**, um modelo pequeno e rápido, feito para decisões como esta.",
              "**Um modelo pequeno numa das chaves de API do workspace**, como o Claude Haiku 5.5 ou o GPT-6 Luna.",
              "**O seu próprio plano do Claude ou do ChatGPT**, para as mensagens que você escreve, num servidor que você mesmo roda. Ele as lê no computador onde está conectado e leva alguns segundos.",
              "**Regras simples**: uma resposta a um agente vai para ele, e também uma continuação logo depois de você falar com ele, ou uma mensagem num canal onde você está sozinho com um agente.",
            ],
          },
          "Quando nada disso serve, nenhum agente responde. Mencione um agente para chamá-lo.",
        ],
      },
      {
        id: "jev",
        heading: "Jev",
        blocks: [
          "Quando o agentes.chat hospeda o seu workspace, o Jev está incluído. Num servidor que você mesmo roda, ele usa a chave da TypeSafe do dono, cerca de US$ 0,0001 por mensagem: [Configurar o Jev](/help/jev#setup).",
        ],
      },
      {
        id: "plans",
        heading: "Por que o seu plano só escolhe nas suas mensagens",
        blocks: [
          "Os planos do Claude e do ChatGPT são pessoais, então o seu plano só escolhe nas mensagens que você escreve.",
        ],
      },
      {
        id: "see",
        heading: "Ver quem escolheu",
        blocks: ["Abra o visto embaixo de uma mensagem. A última linha diz quem escolheu os agentes."],
      },
    ],
  },
  jev: {
    title: "Jev",
    summary:
      "Um modelo rápido da TypeSafe que toma decisões rápidas pelos seus agentes. No seu próprio servidor ele é opcional, com uma chave sua.",
    sections: [
      {
        id: "what",
        heading: "O que ele faz",
        blocks: [
          {
            list: [
              "**Escolhe quem responde.** Uma mensagem sem @menção vai para o agente certo em menos de um segundo, mesmo quando os agentes pensam com um plano e você não tem chave de API.",
              "**Organiza a memória.** Ele percebe uma repetição ou um fato novo mesmo com outras palavras: a repetição se junta ao que o agente já sabia, e o fato novo substitui o antigo. Uma vez por dia ele organiza o resto.",
              "**Enxerga a tela.** No navegador e no desktop, os agentes acham botões e campos pela descrição, olham de perto os pequenos e conferem na imagem da tela se um passo deu certo.",
              "**Lê menos.** A cada vez, o agente carrega só as ferramentas de que deve precisar. A sua IA lê menos e custa menos.",
            ],
          },
        ],
      },
      {
        id: "without",
        heading: "Sem ele",
        blocks: [
          "Tudo continua funcionando, mais devagar e com menos cuidado.",
          {
            list: [
              "**Quem responde:** um modelo pequeno numa das suas chaves de API escolhe, como o Claude Haiku 5.5 ou o GPT-6 Luna. Sem chave, o plano do Claude ou do ChatGPT de cada pessoa escolhe nas mensagens que ela escreve, em alguns segundos. Fora isso, uma resposta ou uma continuação ainda chega ao agente. Mencione um agente para chamá-lo. [Como os agentes são escolhidos](/help/who-answers)",
              "**Memória:** repetições com as mesmas palavras ainda se juntam. Repetições e novidades ditas de outro jeito ficam separadas.",
              "**Tela:** os agentes usam os números mostrados na tela e os nomes exatos. Nada é lido de imagens.",
            ],
          },
        ],
      },
      {
        id: "setup",
        heading: "Como configurar",
        blocks: [
          {
            list: [
              "Abra https://console.typesafe.ai e entre com o Google ou o seu e-mail. Uma conta nova é criada do mesmo jeito.",
              "Adicione crédito no console. O Jev é pré-pago.",
              "Abra https://console.typesafe.ai/keys, crie uma chave e copie na hora.",
              "No agentes.chat, abra **Configurações\u00a0›\u00a0Contas de IA** e cole em **Jev**. Só quem configurou este servidor vê essa parte.",
            ],
          },
          "Num servidor que você roda com Docker, dá para colocar a chave no `.env` como `TYPESAFE_API_KEY`. Essa vale mais que a das Configurações.",
        ],
      },
      {
        id: "cost",
        heading: "Quanto custa",
        blocks: [
          {
            list: [
              "US$ 0,042 por milhão de tokens que o Jev lê. As respostas são grátis. Escolher quem responde lê cerca de 2.500 tokens, ou seja, cerca de US$ 0,0001. Uma captura de tela tem cerca de 3.900 tokens.",
              "O crédito comprado vale por 12 meses. Ligue a recarga automática no console para o Jev não ficar sem crédito.",
              "**Configurações\u00a0›\u00a0Contas de IA** mostra quantas decisões o Jev tomou no mês e quanto custaram.",
            ],
          },
        ],
      },
      {
        id: "data",
        heading: "Os seus dados",
        blocks: [
          "O que o Jev lê para decidir:",
          {
            list: [
              "O nome e a descrição do canal, a mensagem e as poucas antes dela",
              "Os nomes e papéis dos agentes, o começo das instruções deles e as ferramentas que eles podem usar",
              "Os itens de memória que ele compara",
              "A tarefa de um agente e o começo dos resultados das ferramentas",
              "O objetivo de uma missão e os comandos que um agente quer rodar nela",
              "As ferramentas que um app conectado oferece",
              "A página ou a tela que um agente está usando, inclusive capturas",
            ],
          },
          "A TypeSafe roda o Jev nos Estados Unidos e não treina os modelos dela com o que você envia. Ela guarda os dados pelo tempo necessário para operar o serviço. A TypeSafe oferece retenção zero nos planos enterprise.",
          "Política de privacidade da TypeSafe: https://typesafe.ai/legal/privacy-policy. Contrato de tratamento de dados: https://typesafe.ai/legal/data-processing.",
        ],
      },
      {
        id: "problems",
        heading: "Quando ele para",
        blocks: [
          {
            list: [
              "**Chave recusada:** crie uma chave nova e cole em **Configurações\u00a0›\u00a0Contas de IA**.",
              "**Sem crédito:** adicione crédito no console. O Jev tenta de novo em até 30 minutos, ou clique em **Verificar de novo**.",
              "**Ocupado ou fora do ar:** a TypeSafe pode limitar os pedidos por segundo, ou parar de responder por um tempo. O Jev volta sozinho. Os seus limites: https://console.typesafe.ai/rate-limits. Para limites maiores, escreva para sales@typesafe.ai.",
            ],
          },
          "Enquanto isso, os agentes trabalham como em [Sem ele](/help/jev#without).",
        ],
      },
    ],
  },
};
