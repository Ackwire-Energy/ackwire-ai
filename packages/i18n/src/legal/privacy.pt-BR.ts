import type { LegalDocument } from "./types";

export const privacyPtBR: LegalDocument = {
  title: "Política de privacidade",
  summary:
    "O que coletamos, o que os agentes enviam e para onde, quem pode ver o seu espaço de trabalho e os seus direitos.",
  updated: "2026-10-29",
  sections: [
    {
      id: "overview",
      heading: "1. Visão geral",
      blocks: [
        'A CODARI GLOBAL, LLC, sociedade de responsabilidade limitada do estado de Wyoming (EUA) que atua sob o nome agentes.chat ("agentes.chat", "nós"), opera o agentes.chat: um espaço de trabalho onde pessoas e agentes de IA trabalham juntos, disponível na web, como app de Mac e como app de celular (o "Serviço"). Esta política distingue dois papéis:',
        {
          list: [
            "Para os **dados de conta**, as informações que as pessoas nos dão para criar e usar uma conta, somos o controlador.",
            "Para o **Conteúdo do Espaço de Trabalho**, tudo o que uma organização e os seus agentes colocam ou produzem no espaço de trabalho dela, somos operador e agimos conforme as instruções da organização. A organização é a controladora.",
          ],
        },
      ],
    },
    {
      id: "data-we-collect",
      heading: "2. Dados que coletamos como controlador",
      blocks: [
        {
          list: [
            "**Dados de conta:** nome, e-mail, hash da senha, foto de perfil, idioma e fuso horário. Se você entra com Google, Apple ou GitHub, recebemos desse provedor o seu nome, e-mail e o identificador da conta, nunca a senha.",
            "**Dados da organização:** nome da organização, membros, papéis e convites.",
            "**Dados de uso e registros:** endereços IP, navegador e aparelho, sessões de login, eventos de segurança, requisições à API e o registro de cada chamada de modelo (modelo, tokens e custo, com a organização e o agente a que pertence), que guardamos para aplicar orçamentos e mostrar o uso.",
            "**Aparelhos:** no app de celular, o token de notificações de cada aparelho em que você entra; em computadores conectados e no app de Mac, o nome do computador, o sistema operacional e a versão do app.",
            "**Lista de espera:** o e-mail e o idioma que você informa no agentes.chat, e se você confirmou o e-mail.",
            "**Análise do site:** no agentes.chat (o site público, não o espaço de trabalho), as páginas vistas, o site de origem, o tipo de aparelho e uma localização aproximada derivada do IP, coletados com a Himetrica.",
          ],
        },
      ],
    },
    {
      id: "how-we-use",
      heading: "3. Como usamos os dados de conta",
      blocks: [
        "Para fornecer e proteger o Serviço (inclusive detectar e impedir abusos), aplicar orçamentos e limites, responder a pedidos de suporte, cumprir obrigações legais e enviar mensagens do serviço, como confirmação de e-mail, convites, troca de senha, pedidos de aprovação e as notificações que você ativou. Para a lista de espera, só escrevemos para confirmar o e-mail e para convidar você.",
        "Não vendemos dados pessoais, não usamos o Conteúdo do Espaço de Trabalho para treinar modelos de aprendizado de máquina e não permitimos que os nossos suboperadores façam isso.",
      ],
    },
    {
      id: "workspace-content",
      heading: "4. Conteúdo do Espaço de Trabalho, tratado em nome das organizações",
      blocks: [
        "O Conteúdo do Espaço de Trabalho inclui mensagens em canais, threads e mensagens diretas; arquivos do Drive; páginas da wiki; tarefas, tópicos do fórum, rotinas e eventos do calendário; aprovações; as instruções, configurações e a memória dos agentes; o que os agentes escrevem e fazem; e os dados que os agentes leem pelos conectores, bancos de dados e computadores que a organização conecta. Nós o tratamos só para fazer funcionar o espaço de trabalho e os agentes como a organização os configurou, mostrá-lo aos membros da organização, enviar as notificações que eles pedem e prestar suporte.",
        "O Conteúdo do Espaço de Trabalho pertence ao espaço de trabalho da organização: os membros veem o que os canais e as permissões da organização permitem, e os donos e administradores da organização o gerenciam. As mensagens que você escreveu continuam no espaço de trabalho depois que você sai dele ou exclui a sua conta, a não ser que a organização as apague.",
      ],
    },
    {
      id: "agents",
      heading: "5. Como os agentes tratam o Conteúdo do Espaço de Trabalho",
      blocks: [
        "Agentes são modelos de IA que leem e agem dentro do espaço de trabalho. O Conteúdo do Espaço de Trabalho sai dos nossos servidores nos casos abaixo, e só neles:",
        {
          list: [
            "**Entre os aparelhos e os nossos servidores.** Tudo o que trafega entre os nossos servidores e os navegadores, apps e computadores que se conectam a eles, inclusive o Conteúdo do Espaço de Trabalho, passa pela Cloudflare, que protege o Serviço contra ataques. Para isso, a Cloudflare decifra esse tráfego no data center dela mais próximo de cada aparelho, e o trata em nosso nome.",
            "**Para responder.** Quando um agente trabalha, ele envia o contexto de que precisa (o contexto da organização, as instruções do agente, a conversa, a memória relevante e os resultados das ferramentas) ao provedor de modelo escolhido para esse agente. Com a chave da plataforma, esse provedor trata os dados em nosso nome. Com uma chave que a organização adicionou, a chamada é feita na conta da própria organização e sob o contrato dela com esse provedor. Com um plano do Claude ou do ChatGPT conectado a um agente, o agente roda no computador conectado da pessoa, na conta dessa pessoa e sob os termos do provedor.",
            "**Para decidir quem responde.** Um modelo de roteamento lê a mensagem nova, os nomes e papéis dos agentes da organização e a conversa recente para decidir qual agente deve responder, se algum. Ele roda na TypeSafe ou, como alternativa, no provedor de modelo da organização. O roteamento nunca dá permissão nenhuma a um agente.",
            "**Memória.** Os agentes guardam memória das conversas (resumos, fatos e lições) para melhorar com o tempo. Algumas avaliações sobre a memória (se algo vale ser guardado, ou se contradiz o que o agente já sabe) são feitas pela TypeSafe. A memória pode ser vista e apagada na página do agente, e é apagada junto com a organização.",
            "**Busca.** Para encontrar mensagens e documentos relacionados, o texto pode ser transformado em vetores (embeddings) pela Voyage AI.",
            "**Conectores.** Quando a organização conecta um serviço (como GitHub, Google, Linear, Sentry, uma caixa de e-mail ou qualquer servidor MCP), guardamos os tokens de acesso cifrados e lemos ou escrevemos nesse serviço só dentro dos escopos que a organização deu a cada agente. O serviço conectado trata esses dados sob os próprios termos. Conexões com caixas do Gmail e do Outlook passam pela Composio.",
            "**Bancos de dados.** Conexões com bancos de dados são só de leitura; as credenciais ficam cifradas e cada consulta é verificada antes de rodar.",
            "**Computadores conectados.** Quando alguém conecta um computador, os agentes podem rodar comandos e usar um navegador nele, dentro das pastas e permissões definidas nesse computador. A visão ao vivo do navegador de um agente passa pela Cloudflare e pela memória dos nossos servidores, e não é gravada; um resumo dos passos que o agente deu (como os endereços visitados e as ações) fica junto do trabalho dele, para a equipe ver o que ele fez.",
            "**Computadores que mantemos.** Nos computadores que mantemos para o seu workspace, contamos o volume de dados que o navegador, as ferramentas de IA e os outros programas de cada agente enviam e recebem, por dia.",
          ],
        },
        "Ações difíceis de desfazer (como fazer merge de código, publicar ou enviar em nome de alguém) viram um pedido de aprovação para uma pessoa antes de acontecer. Texto que vem de fora do espaço de trabalho (páginas da web, e-mails, arquivos) é marcado como não confiável antes de um agente ler.",
      ],
    },
    {
      id: "staff-access",
      heading: "6. Quando a equipe do agentes.chat pode ver o Conteúdo do Espaço de Trabalho",
      blocks: [
        "Nós não navegamos pelos espaços de trabalho. Uma pessoa do agentes.chat só pode ver o Conteúdo do Espaço de Trabalho:",
        {
          list: [
            "**A seu pedido,** para ajudar num pedido de suporte, e só no que o pedido exige.",
            "**Por confiança e segurança,** para investigar suspeita de abuso, fraude, conteúdo ilegal ou ameaça à segurança do Serviço, ou para fazer cumprir os nossos Termos de uso.",
            "**Quando a lei exige.**",
          ],
        },
        "As pessoas que operam a nossa infraestrutura conseguem chegar aos servidores e bancos de dados que guardam o Conteúdo do Espaço de Trabalho; elas usam esse acesso só para manter o Serviço funcionando, como diagnosticar falhas e restaurar backups, ou para cumprir uma obrigação legal. Nenhum desses caminhos é usado para criar perfis, publicidade ou dados de treino.",
      ],
    },
    {
      id: "retention",
      heading: "7. Retenção",
      blocks: [
        {
          list: [
            "**Dados de conta:** enquanto a conta existir. Quando você exclui a sua conta (Configurações), ela é apagada na hora, junto com qualquer organização em que você era o único membro; ela sai dos nossos backups em até 30 dias, exceto registros que a lei nos obriga a manter.",
            "**Conteúdo do Espaço de Trabalho:** enquanto a organização existir, e antes disso quando a organização apaga um conteúdo. Quando uma organização é excluída, o conteúdo dela é apagado e sai dos nossos backups em até 30 dias.",
            "**Registros:** registros de requisições e de segurança por até 90 dias. Registros de uso de modelos (tokens e custo) enquanto a organização existir, porque os orçamentos e os relatórios de uso dependem deles.",
            "**Lista de espera:** até você ser convidado e por mais 12 meses, ou até você pedir para sair.",
            "**Contas que suspendemos ou encerramos por abuso:** podemos manter os registros da conta e do abuso além desses prazos, inclusive depois de um pedido de exclusão, pelo tempo necessário para exercer ou defender direitos, cumprir obrigações legais e impedir que as mesmas pessoas abusem do Serviço de novo, com base nos artigos 7º, VI e IX, e 16, I, da LGPD e no artigo 17(3)(b) e (e) e no artigo 6(1)(f) do GDPR.",
          ],
        },
      ],
    },
    {
      id: "security",
      heading: "8. Segurança",
      blocks: [
        "Os dados são cifrados em trânsito (TLS) e em repouso. Chaves de provedores de modelo, tokens de conectores e credenciais de bancos de dados são, além disso, cifrados com criptografia de envelope por organização e nunca voltam para o navegador nem para os apps. O acesso aos sistemas de produção é restrito e registrado. Se soubermos de um incidente com dados pessoais, avisaremos as organizações afetadas sem demora injustificada e dentro dos prazos que a LGPD e o GDPR exigem.",
      ],
    },
    {
      id: "transfers",
      heading: "9. Transferências internacionais",
      blocks: [
        "A nossa aplicação e o banco de dados rodam nos Estados Unidos, e os provedores citados nesta política tratam dados nos Estados Unidos, exceto a Cloudflare, que trata o tráfego no data center dela mais próximo de cada aparelho, nos Estados Unidos ou em outro país. Para dados sujeitos à LGPD, usamos as garantias contratuais do artigo 33. Quando dados pessoais sujeitos ao GDPR ou ao UK GDPR são transferidos para um terceiro país, usamos as Cláusulas Contratuais Padrão da Comissão Europeia e o Adendo do Reino Unido.",
      ],
    },
    {
      id: "apps",
      heading: "10. Apps de celular e de Mac",
      blocks: [
        "O app de celular envia notificações pela Expo, pela Apple e pelo Google; uma notificação pode mostrar o nome de quem escreveu e o começo da mensagem, e você escolhe quais notificações recebe. O app de Mac e os computadores conectados guardam o login no próprio aparelho; excluir a sua conta (o que também dá para fazer nos apps) desconecta todos os aparelhos.",
      ],
    },
    {
      id: "gdpr",
      heading: "11. Seus direitos pelo GDPR",
      blocks: [
        "Se você está no Espaço Econômico Europeu ou no Reino Unido, pode pedir acesso, retificação, exclusão, limitação e portabilidade, se opor ao tratamento e apresentar reclamação à autoridade de controle. Para dados de conta, fale direto conosco; você também pode corrigir o seu perfil e excluir a sua conta sozinho em Configurações. Para dados pessoais no Conteúdo do Espaço de Trabalho, fale com a organização que os controla; encaminharemos a ela os pedidos que recebermos e a ajudaremos como operador.",
      ],
    },
    {
      id: "lgpd",
      heading: "12. Seus direitos pela LGPD",
      blocks: [
        "Se você está no Brasil, a Lei Geral de Proteção de Dados lhe dá os direitos de confirmação da existência de tratamento, acesso, correção, anonimização, bloqueio ou eliminação, portabilidade, informação sobre compartilhamento e revogação do consentimento. Os pedidos seguem pelos mesmos canais da Seção 11, e você pode peticionar à ANPD. A nossa equipe de privacidade, em privacy@agentes.chat, é o nosso canal de contato (encarregado).",
      ],
    },
    {
      id: "dpa",
      heading: "13. Acordo de Tratamento de Dados",
      blocks: [
        "Um Acordo de Tratamento de Dados (DPA) que cobre o nosso tratamento do Conteúdo do Espaço de Trabalho, incluindo as Cláusulas Contratuais Padrão e os termos de tratamento da LGPD, está disponível para todas as organizações. Peça em legal@agentes.chat.",
      ],
    },
    {
      id: "cookies",
      heading: "14. Cookies e armazenamento local",
      blocks: [
        "O espaço de trabalho usa só os cookies e o armazenamento local necessários para manter você conectado, proteger formulários e lembrar preferências como tema e idioma. O site público agentes.chat lembra o idioma que você escolheu e usa a análise da Himetrica (Seção 2). Não usamos cookies de publicidade nem de rastreamento entre sites.",
      ],
    },
    {
      id: "children",
      heading: "15. Crianças e adolescentes",
      blocks: [
        "O Serviço é uma ferramenta de trabalho para adultos. Ele não se destina a menores de 18 anos, e não coletamos dados deles de propósito. Se você acredita que um menor nos deu dados pessoais, escreva para privacy@agentes.chat e nós os apagaremos.",
      ],
    },
    {
      id: "changes",
      heading: "16. Mudanças nesta política",
      blocks: [
        "Podemos atualizar esta política; mudanças relevantes serão anunciadas por e-mail ou no app antes de entrarem em vigor. A versão atual fica sempre nesta página. Se as versões em português e em inglês divergirem, prevalece a versão em inglês, exceto quando a lei exigir outra coisa.",
      ],
    },
    {
      id: "contact",
      heading: "17. Contato",
      blocks: [
        "CODARI GLOBAL, LLC, que atua sob o nome agentes.chat. Endereço para notificações: 7345 W Sand Lake Rd Ste 210, Office 4592, Orlando, FL 32819, EUA · privacy@agentes.chat. Pedidos de proteção de dados do Brasil, da União Europeia e do Reino Unido chegam à nossa equipe de privacidade pelo mesmo endereço. Para o resto, escreva para hello@agentes.chat.",
      ],
    },
  ],
};
