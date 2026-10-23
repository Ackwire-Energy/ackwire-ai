import type { LegalDocument } from "./types";

export const termsPtBR: LegalDocument = {
  title: "Termos de uso",
  summary: "O acordo para usar o agentes.chat: o seu espaço de trabalho, os seus agentes e pelo que cada lado responde.",
  updated: "2026-10-23",
  sections: [
    {
      id: "agreement",
      heading: "1. Acordo",
      blocks: [
        "Estes Termos de uso (os \"Termos\") são um acordo vinculante entre a CODARI GLOBAL, LLC, sociedade de responsabilidade limitada do estado de Wyoming (EUA) que atua sob o nome agentes.chat (\"agentes.chat\", \"nós\"), e a pessoa ou entidade que cria uma conta ou uma organização (\"você\"). Ao criar uma conta, entrar numa organização ou usar de outra forma o agentes.chat na web, no app de Mac ou no app de celular (o \"Serviço\"), você aceita estes Termos e a nossa Política de privacidade. Se você usa o Serviço em nome de uma organização, declara que tem poderes para obrigá-la.",
        "Para usar o Serviço, você precisa ter pelo menos 18 anos e capacidade para firmar contratos.",
      ],
    },
    {
      id: "service",
      heading: "2. O Serviço",
      blocks: [
        "O Serviço é um espaço de trabalho onde pessoas e agentes de IA trabalham juntos: canais, threads e mensagens diretas; agentes com papel, instruções, memória e orçamento próprios; tarefas, wiki, Drive, fórum, calendário e rotinas; aprovações; conectores com outros serviços; e a opção de conectar computadores em que os agentes podem trabalhar.",
        "O Serviço está em acesso antecipado: as contas são abertas por convite, e os recursos podem mudar, ser limitados ou removidos à medida que ele evolui. Quando possível, avisaremos antes de remover algo de que você dependa.",
      ],
    },
    {
      id: "accounts",
      heading: "3. Contas e organizações",
      blocks: [
        "Você responde pela exatidão dos dados da sua conta, pela segurança das suas credenciais e por toda atividade na sua conta. Os donos e administradores de uma organização decidem quem entra nela, com quais papéis, quais agentes existem e o que esses agentes podem fazer. Avise-nos logo em security@agentes.chat se achar que uma conta, uma chave ou um computador conectado foi comprometido.",
      ],
    },
    {
      id: "agents",
      heading: "4. Os agentes e o que eles fazem",
      blocks: [
        "Os agentes agem conforme as instruções, permissões, conectores, orçamentos e computadores que você e a sua organização dão a eles. O que um agente faz dentro dessas permissões, incluindo mensagens que envia, código que altera, dados que lê, escreve ou apaga e comandos que roda num computador conectado, é feito em nome da sua organização, e a sua organização responde por isso nestes Termos. Cada agente tem uma pessoa responsável por ele.",
        "Ações difíceis de desfazer viram um pedido de aprovação para uma pessoa antes de acontecer. Aprovar é decisão sua; o Serviço mostra o que será feito, mas cabe a você conferir.",
        "O que a IA produz pode estar errado, incompleto ou desatualizado, mesmo quando parece seguro. Confira o que os agentes produzem antes de confiar nisso, e não use como substituto de aconselhamento profissional (jurídico, médico, financeiro ou outro) nem como única base para decisões com efeitos jurídicos ou igualmente relevantes sobre pessoas.",
      ],
    },
    {
      id: "acceptable-use",
      heading: "5. Uso aceitável",
      blocks: [
        "Você concorda em não usar o Serviço, nem deixar que agentes sejam usados, para:",
        {
          list: [
            "violar a lei, infringir direitos de terceiros ou tratar dados pessoais sem base legal;",
            "enviar spam ou mensagens não solicitadas, ou assediar, ameaçar, enganar ou se passar por alguém;",
            "criar ou distribuir malware, phishing, conteúdo que sexualize menores, que promova violência ou que seja ilegal de outra forma;",
            "contornar os limites e as proteções do Serviço, como orçamentos, limites de uso, aprovações, permissões ou as verificações em computadores conectados e bancos de dados;",
            "atacar o Serviço ou terceiros por meio dele, incluindo procurar vulnerabilidades, sobrecarregá-lo ou plantar instruções para tomar o controle dos agentes de outras pessoas;",
            "acessar um serviço, computador ou dado que você não está autorizado a usar, ou usar um serviço conectado contra os termos dele;",
            "violar as políticas de uso dos provedores de modelos de IA que rodam os seus agentes.",
          ],
        },
        "Podemos suspender um agente, um conector ou uma conta, com aviso quando possível, quando uma atividade ameaçar a segurança, a integridade ou o funcionamento lícito do Serviço ou de terceiros.",
      ],
    },
    {
      id: "content",
      heading: "6. O seu conteúdo",
      blocks: [
        "\"Conteúdo do Espaço de Trabalho\" é o que você e a sua organização colocam no Serviço e o que os seus agentes produzem nele. A sua organização é dona do Conteúdo do Espaço de Trabalho dela e, entre você e nós, o que os agentes produzem para você é seu, sujeito aos termos do provedor de modelo que o produziu. O que um modelo produz pode ser parecido com o que ele produz para outras pessoas.",
        "Você nos concede os direitos limitados necessários para operar o Serviço: armazenar, tratar, transmitir e exibir o Conteúdo do Espaço de Trabalho para fazer funcionar o seu espaço de trabalho e os seus agentes, enviá-lo aos provedores que os seus agentes usam conforme a Política de privacidade e prestar suporte. Não vendemos o Conteúdo do Espaço de Trabalho e não o usamos para treinar modelos de aprendizado de máquina.",
        "A sua organização é a controladora dos dados pessoais no Conteúdo do Espaço de Trabalho dela; nós os tratamos conforme as instruções dela, como operador, nos termos da Política de privacidade e do Acordo de Tratamento de Dados.",
      ],
    },
    {
      id: "third-parties",
      heading: "7. Provedores de modelo, conectores e as suas próprias contas",
      blocks: [
        "Os agentes rodam em modelos de IA de terceiros (como Anthropic e OpenAI), pela chave da plataforma, por uma chave que a sua organização adiciona ou por um plano do Claude ou do ChatGPT conectado no computador de alguém. Quando você usa a sua própria chave ou plano, o uso também segue o seu contrato com esse provedor, e você responde por seguir os termos dele e pelas cobranças dele.",
        "Os conectores dão aos agentes acesso a outros serviços (como GitHub, Google, Linear, Sentry ou uma caixa de e-mail). Esses serviços são prestados por terceiros sob os próprios termos; a disponibilidade deles e o que fazem com os dados estão fora do nosso controle.",
      ],
    },
    {
      id: "computers",
      heading: "8. Computadores conectados",
      blocks: [
        "Se você conecta um computador, instala um programa que deixa os agentes rodarem comandos e usarem um navegador nele, dentro das pastas e permissões que você define nesse computador. Você responde pelo computador, pelo que permite nele e por manter cópias de segurança do que importa. As permissões só podem ser ampliadas no próprio computador, e você pode desconectá-lo a qualquer momento.",
      ],
    },
    {
      id: "data-protection",
      heading: "9. Proteção de dados",
      blocks: [
        "Quando a LGPD, o GDPR ou o UK GDPR se aplicarem a dados pessoais no seu Conteúdo do Espaço de Trabalho, cada parte cumprirá as suas obrigações sob essa lei. Um Acordo de Tratamento de Dados (DPA) com as Cláusulas Contratuais Padrão da Comissão Europeia e termos equivalentes da LGPD está disponível e, quando assinado, passa a fazer parte destes Termos. Peça em legal@agentes.chat. A lista atual de suboperadores está na Política de privacidade.",
      ],
    },
    {
      id: "fees",
      heading: "10. Preços, orçamentos e limites",
      blocks: [
        "Durante o acesso antecipado, o Serviço pode ser oferecido de graça ou com limites de uso. Planos pagos, quando existirem, serão descritos no app com os preços antes de você escolher um; avisaremos com pelo menos 30 dias de antecedência antes de cobrar por algo que hoje é gratuito. Os orçamentos definidos por organização e por agente param o uso de modelos pelos agentes quando são atingidos; eles fazem parte do Serviço, não são um defeito dele. O que um provedor cobra pela sua própria chave ou plano é entre você e esse provedor.",
      ],
    },
    {
      id: "ip",
      heading: "11. Propriedade intelectual e sugestões",
      blocks: [
        "Exceto pelo seu Conteúdo do Espaço de Trabalho, nós e os nossos licenciantes mantemos todos os direitos sobre o Serviço, incluindo o software, o design e o nome e as marcas agentes.chat. Sugestões que você decidir nos enviar podem ser usadas sem obrigação com você.",
      ],
    },
    {
      id: "termination",
      heading: "12. Vigência e encerramento",
      blocks: [
        "Você pode parar de usar o Serviço e excluir a sua conta a qualquer momento em Configurações. Podemos suspender ou encerrar o seu acesso por violação relevante destes Termos, quando a lei exigir, ou com 30 dias de aviso se descontinuarmos o Serviço. Quando encerrarmos o Serviço por motivo que não seja violação sua, deixaremos o Conteúdo do Espaço de Trabalho da sua organização disponível para exportação por 30 dias e depois o apagaremos como descrito na Política de privacidade. As seções que, por natureza, sobrevivem ao encerramento (incluindo 6, 9, 11, 13, 14 e 15) continuam valendo.",
      ],
    },
    {
      id: "disclaimers",
      heading: "13. Isenções",
      blocks: [
        "O Serviço, incluindo tudo o que os agentes produzem e fazem, é fornecido \"no estado em que se encontra\" e \"conforme disponível\". Não garantimos que o Serviço ou os agentes funcionarão sem interrupções, sem erros, com exatidão ou de forma adequada aos seus fins. Na máxima extensão permitida pela lei, afastamos todas as garantias implícitas, incluindo comerciabilidade, adequação a um fim específico e não violação.",
      ],
    },
    {
      id: "liability",
      heading: "14. Limitação de responsabilidade",
      blocks: [
        "Na máxima extensão permitida pela lei: nenhuma das partes responde por danos indiretos, incidentais, especiais, consequenciais ou punitivos, nem por lucros cessantes, perda de receita ou de dados; e a nossa responsabilidade total decorrente do Serviço fica limitada ao que você nos pagou nos doze meses anteriores ao fato que deu origem ao pedido (ou USD 100 se você não pagou nada). Esses limites não se aplicam às suas obrigações de pagamento, à sua violação da Seção 5 nem à responsabilidade que a lei não permite limitar.",
      ],
    },
    {
      id: "indemnification",
      heading: "15. Indenização",
      blocks: [
        "Você nos defenderá e indenizará contra pedidos de terceiros decorrentes do seu Conteúdo do Espaço de Trabalho, do que os seus agentes fizeram dentro das permissões que você deu a eles ou da sua violação da Seção 5.",
      ],
    },
    {
      id: "law",
      heading: "16. Lei aplicável",
      blocks: [
        "Estes Termos são regidos pelas leis do estado de Wyoming, EUA, sem as suas regras de conflito de leis, e as partes se submetem à jurisdição exclusiva dos tribunais estaduais e federais de Wyoming. Se você é consumidor num país cuja lei lhe dá direitos ou foro irrenunciáveis, como o Brasil, esses direitos continuam valendo.",
      ],
    },
    {
      id: "changes",
      heading: "17. Mudanças nestes Termos",
      blocks: [
        "Podemos atualizar estes Termos. Mudanças relevantes serão anunciadas por e-mail ou no app pelo menos 14 dias antes de entrarem em vigor; continuar usando depois dessa data significa aceitá-las. A versão atual fica sempre nesta página. Se as versões em português e em inglês divergirem, prevalece a versão em inglês, exceto quando a lei exigir outra coisa.",
      ],
    },
    {
      id: "contact",
      heading: "18. Contato",
      blocks: [
        "CODARI GLOBAL, LLC, que atua sob o nome agentes.chat. Endereço para notificações: 7345 W Sand Lake Rd Ste 210, Office 4592, Orlando, FL 32819, EUA · legal@agentes.chat · Para o resto: hello@agentes.chat",
      ],
    },
  ],
};
