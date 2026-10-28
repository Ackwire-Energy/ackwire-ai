import type { Widen } from "../widen";

/** Landing page strings: demo (the Pixelpress workspace). pt-BR is the source; en is typed against it. */
export const pt = {
  demo: {
    eyebrow: "Demonstração",
    title: "Agora é com você.",
    lead: "O workspace da Pixelpress, uma startup que comprime arquivos, rodando como o produto. Troque de canal, pare um agente ou escreva enquanto ele trabalha.",
    scenario: "Cenário",
    tab: { incident: "Incidente", routine: "Rotina", two: "Dois agentes" },
    replay: "Repetir",
    sidebar: "Barra lateral da demonstração",
    message: "Mensagem",
    placeholder: "Escreva em #{{channel}}…",
    send: "Enviar",
    isWorking: "{{name}} está trabalhando…",
    joined: "<b>{{name}}</b> entrou na conversa",
    joinedTwo: "<b>{{a}}</b> e <b>{{b}}</b> entraram na conversa",
    considered: "Considerou sua mensagem: “{{text}}”",
    reactions: "Reações",
    react: "{{emoji}} {{n}}",
    fallback1:
      "Isto é uma demonstração, então não consigo trabalhar de verdade nesse pedido. Entre na lista: quando sua onda abrir, eu respondo com as ferramentas do seu time.",
    fallback2:
      "Anotei. No produto eu responderia com o contexto da sua empresa e as ferramentas que vocês liberaram para mim. Por enquanto, a lista de espera é o caminho.",
    incident: {
      ask: "o upload de arquivos grandes tá falhando desde o deploy das 14h",
      s1: "Leu 212 erros no Sentry",
      s2: "Comparou o que mudou no deploy das 14h",
      consultQ: "O deploy das 14h mexeu no compressor?",
      consultA: "Atlas: sim, subiu junto o PR #512, com a nova versão do compressor.",
      s3: "Comprimiu um arquivo de 5 GB no computador dele",
      summary: "<b>4 passos</b> · Sentry, GitHub, computador · 44 s",
      stoppedReply:
        "Parei aqui. Até agora: 212 erros, todos em arquivos grandes e todos desde o deploy das 14h. Quer que eu continue?",
      reply:
        "Achei. O PR #512 carrega o arquivo inteiro na memória antes de comprimir, e acima de 4 GB o processo morre. O mais rápido é voltar o deploy e corrigir com calma.",
      approval: "Atlas quer voltar produção para a v3.8.1",
      approvalDetail: "Desfaz o deploy das 14h02. O upload volta em cerca de 2 minutos.",
      action: "Voltar versão",
      refused: "Recusado por você · o motivo vira lição para o {{agent}}",
      noReply:
        "Combinado, ninguém mexe em produção. Abri o PR #513, que comprime em partes. O merge também vai pedir a sua aprovação.",
      yes1: "Voltou produção para a v3.8.1",
      yes2: "Conferiu os erros: nenhum em 2 minutos",
      yes3: "Criou a tarefa #88 para o Dev comprimir em partes",
      yesSummary: "<b>3 passos</b> · deploy, Sentry · 1 min 56 s",
      yesReply: "Pronto, o upload voltou. A correção ficou na tarefa #88.",
    },
    routine: {
      sys: "<b>Rotina</b> · Relatório semanal · toda segunda às 9h",
      s1: "Consultou o banco de métricas, só leitura",
      s2: "Comparou com a semana anterior",
      s3: "Montou a tabela e o gráfico",
      summary: "<b>3 passos</b> · Postgres · 18 s",
      reply:
        "Bom dia. A plataforma comprimiu 1,2 PB esta semana, 9% acima da anterior, e a taxa média de compressão subiu para 5,2. Ganhamos 41 contas novas, quase todas no plano para empresas.",
      fileTitle: "Relatório semanal · 12 a 18 de outubro",
      fileSub: "Tabela e gráfico · salvo no Drive",
      ask: "dá para quebrar as contas novas por tipo de arquivo?",
      t2: "Pôs uma aba nova no mesmo relatório",
      summary2: "<b>2 passos</b> · Postgres, Drive · 9 s",
      reply2:
        "Dá. Vídeo é 58% do volume das contas novas, backups 27% e imagens 15%. Coloquei isso numa aba nova do mesmo relatório.",
    },
    two: {
      ask: "alguém escreve o anúncio do app para Mac? sai na quinta",
      s1: "Leu a tarefa #74 do app para Mac",
      s2: "Buscou o tom de voz na wiki",
      summary: "<b>2 passos</b> · Tarefas, Wiki · 5 s",
      reply:
        "Eu escrevo. Primeiro rascunho: “Arraste qualquer arquivo para a barra de menus e ele fica até 5 vezes menor.” Faço as versões para LinkedIn e e-mail?",
      consultQ: "O app para Mac comprime sem internet?",
      consultA: "Dev: sim, tudo roda no próprio Mac.",
      adaReply:
        "Um detalhe que vale citar: tudo roda no próprio Mac, então funciona sem internet e o arquivo não sai do computador.",
      t1: "Revisou o rascunho",
      t2: "Salvou no Drive em Lançamentos/App para Mac",
      summary2: "<b>2 passos</b> · Drive · 5 s",
      reply2: "Boa. Ajustei o texto com o funcionamento sem internet e fiz as três versões.",
      fileTitle: "Anúncio do app para Mac",
      fileSub: "Documento · 3 versões · Drive",
    },
  },
};

export const en: Widen<typeof pt> = {
  demo: {
    eyebrow: "Demo",
    title: "Your turn.",
    lead: "The workspace of Pixelpress, a startup that compresses files, running like the product. Switch channels, stop an agent or write while it works.",
    scenario: "Scenario",
    tab: { incident: "Incident", routine: "Routine", two: "Two agents" },
    replay: "Replay",
    sidebar: "Demo sidebar",
    message: "Message",
    placeholder: "Message #{{channel}}…",
    send: "Send",
    isWorking: "{{name}} is working…",
    joined: "<b>{{name}}</b> joined the conversation",
    joinedTwo: "<b>{{a}}</b> and <b>{{b}}</b> joined the conversation",
    considered: "Took your message into account: “{{text}}”",
    reactions: "Reactions",
    react: "{{emoji}} {{n}}",
    fallback1:
      "This is a demo, so I can't really work on that request. Join the waitlist: when your wave opens, I'll answer with your team's tools.",
    fallback2:
      "Noted. In the product I'd answer with your company's context and the tools you've given me. For now, the waitlist is the way in.",
    incident: {
      ask: "uploads of large files have been failing since the 2pm deploy",
      s1: "Read 212 errors in Sentry",
      s2: "Compared what changed in the 2pm deploy",
      consultQ: "Did the 2pm deploy touch the compressor?",
      consultA: "Atlas: yes, PR #512 shipped with it, with the new compressor version.",
      s3: "Compressed a 5 GB file on its computer",
      summary: "<b>4 steps</b> · Sentry, GitHub, computer · 44 s",
      stoppedReply:
        "Stopped here. So far: 212 errors, all on large files and all since the 2pm deploy. Want me to keep going?",
      reply:
        "Found it. PR #512 loads the whole file into memory before compressing, and above 4 GB the process dies. The fastest fix is to roll back the deploy and fix it calmly.",
      approval: "Atlas wants to roll production back to v3.8.1",
      approvalDetail: "Undoes the 2:02pm deploy. Uploads are back in about 2 minutes.",
      action: "Roll back version",
      refused: "Declined by you · the reason becomes a lesson for {{agent}}",
      noReply:
        "Got it, nobody touches production. I opened PR #513, which compresses in chunks. The merge will also ask for your approval.",
      yes1: "Rolled production back to v3.8.1",
      yes2: "Checked errors: none in 2 minutes",
      yes3: "Created task #88 for Dev to compress in chunks",
      yesSummary: "<b>3 steps</b> · deploy, Sentry · 1 min 56 s",
      yesReply: "Done, uploads are back. The fix is in task #88.",
    },
    routine: {
      sys: "<b>Routine</b> · Weekly report · every Monday at 9am",
      s1: "Queried the metrics database, read-only",
      s2: "Compared with the previous week",
      s3: "Built the table and the chart",
      summary: "<b>3 steps</b> · Postgres · 18 s",
      reply:
        "Good morning. The platform compressed 1.2 PB this week, 9% more than the last, and the average compression ratio rose to 5.2. We gained 41 new accounts, almost all on the business plan.",
      fileTitle: "Weekly report · October 12–18",
      fileSub: "Table and chart · saved to Drive",
      ask: "can you break the new accounts down by file type?",
      t2: "Added a new tab to the same report",
      summary2: "<b>2 steps</b> · Postgres, Drive · 9 s",
      reply2:
        "Sure. Video is 58% of the new accounts' volume, backups 27% and images 15%. I put it in a new tab of the same report.",
    },
    two: {
      ask: "can someone write the Mac app announcement? it ships Thursday",
      s1: "Read task #74 for the Mac app",
      s2: "Looked up the voice and tone in the wiki",
      summary: "<b>2 steps</b> · Tasks, Wiki · 5 s",
      reply:
        "I'll write it. First draft: “Drag any file to the menu bar and it gets up to 5 times smaller.” Should I do the LinkedIn and email versions?",
      consultQ: "Does the Mac app compress offline?",
      consultA: "Dev: yes, everything runs on the Mac itself.",
      adaReply:
        "A detail worth mentioning: everything runs on the Mac itself, so it works offline and the file never leaves the computer.",
      t1: "Reviewed the draft",
      t2: "Saved it to Drive in Launches/Mac app",
      summary2: "<b>2 steps</b> · Drive · 5 s",
      reply2: "Nice. I updated the copy with the offline angle and made all three versions.",
      fileTitle: "Mac app announcement",
      fileSub: "Document · 3 versions · Drive",
    },
  },
};
