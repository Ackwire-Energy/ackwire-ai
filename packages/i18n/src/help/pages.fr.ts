import type { HelpSlug } from "./index";
import type { HelpDocument } from "./types";

/** The help pages in fr: a page not here shows in English. */
export const helpFr: Partial<Record<HelpSlug, HelpDocument>> = {
  "run-on-your-computer": {
    title: "Faire tourner agentes.chat sur votre ordinateur",
    summary:
      "L’app agentes.chat peut aussi faire tourner agentes.chat lui-même, sur un Mac, un PC ou un ordinateur sous Linux, pour vous ou une petite équipe.",
    sections: [
      {
        id: "how",
        heading: "Comment ça fonctionne",
        blocks: [
          "Il tourne dans l’app, avec sa propre base de données intégrée, et garde tout dans un seul dossier de cet ordinateur, `.agentes` dans votre dossier personnel. Rien d’autre à installer : ni Docker, ni base de données à configurer.",
          "Il démarre avec l’app et s’arrête quand vous la quittez. L’app vous demande confirmation avant de quitter, car personne ne peut utiliser agentes.chat tant qu’elle n’est pas rouverte.",
        ],
      },
      {
        id: "who",
        heading: "Pour qui",
        blocks: [
          "Conçu pour vous ou une petite équipe, tant que cet ordinateur est allumé. Pour une équipe plus grande, ou un serveur toujours allumé, [installez agentes.chat sur un serveur](/help/install-on-a-server) et choisissez **Se connecter à mon serveur** dans l’app. Vos données pourront y être transférées plus tard.",
        ],
      },
      {
        id: "agents",
        heading: "Vos agents travaillent ici aussi",
        blocks: [
          "Vos agents travaillent aussi sur cet ordinateur, dans des dossiers rien qu’à eux, avec un navigateur, et avec Claude Code ou Codex s’ils sont installés ici. Les commandes restent désactivées tant que vous ne les activez pas dans **Préférences › Outils**.",
        ],
      },
      {
        id: "reach",
        heading: "Depuis votre téléphone et votre équipe",
        blocks: [
          "**Y accéder depuis votre téléphone et vos collègues** place agentes.chat sur Tailscale, un réseau privé pour vos appareils : votre téléphone et les personnes que vous invitez le rejoignent, et personne d’autre ne peut atteindre agentes.chat. Tailscale est gratuit : https://tailscale.com/download. Quand cette option est désactivée, agentes.chat ne fonctionne que sur cet ordinateur.",
        ],
      },
      {
        id: "backups",
        heading: "Sauvegardes et déménagement",
        blocks: [
          "**Sauvegarder maintenant**, dans **Préférences › Serveurs**, enregistre la base de données, les fichiers et les réglages dans `.agentes/backups`, dans votre dossier personnel.",
        ],
      },
    ],
  },
  computers: {
    title: "Des ordinateurs pour vos agents",
    summary:
      "Les agents exécutent du code et travaillent sur des fichiers sur les ordinateurs que vous connectez : un Mac ou un PC avec l’app agentes.chat, ou un serveur.",
    sections: [
      {
        id: "mac",
        heading: "Un Mac ou un PC, avec l’app",
        blocks: [
          "L’app agentes.chat ouvre votre serveur dans sa propre fenêtre et, en un clic, ses agents travaillent sur cet ordinateur, dans des dossiers rien qu’à eux. Installez l’app, ouvrez-la, choisissez **Utiliser votre propre serveur › Se connecter à mon serveur** et saisissez l’adresse de votre serveur. Ensuite, une fois connecté, cliquez sur **Utiliser ce Mac** (**Utiliser ce PC** sous Windows, **Utiliser ce poste** sous Linux) dans **Paramètres › Ordinateurs**.",
        ],
      },
      {
        id: "server",
        heading: "Un serveur ou un ordinateur sous Linux",
        blocks: [
          "Dans **Paramètres › Ordinateurs**, copiez la commande sous **Autres méthodes** et exécutez-la dans le terminal de cet ordinateur. Elle affiche un code et un lien : ouvrez le lien, vérifiez que le code correspond et confirmez avec votre compte. Rien à installer au préalable.",
        ],
      },
      {
        id: "folders",
        heading: "Dossiers",
        blocks: [
          "Chaque agent a toujours son propre dossier, dans `~/agentes/<workspace>`. D’autres dossiers peuvent être autorisés sur l’ordinateur lui-même, jamais depuis le site : dans l’app, via **Préférences › Dossiers**, ou avec `agentes-runner folders allow` sur un serveur. Chaque espace de travail autorise ses propres dossiers : ce que vous autorisez pour l’un ne vaut que pour ses agents. Retirer un dossier ne supprime rien. Cela retire seulement l’accès.",
        ],
      },
      {
        id: "pausing",
        heading: "Mettre en pause",
        blocks: [
          "Avec l’app, la personne qui a connecté un ordinateur peut y mettre ses agents en pause, depuis l’icône agentes.chat près de l’horloge. Rien de nouveau ne démarre tant qu’elle ne reprend pas. Ce qui était en cours se termine.",
        ],
      },
      {
        id: "organizations",
        heading: "Plusieurs espaces de travail",
        blocks: [
          "Un même ordinateur peut travailler pour plusieurs espaces de travail. Chacun y a ses propres agents, dossiers et tâches, et en déconnecter un ne touche pas aux autres.",
        ],
      },
    ],
  },
  "workspace-computer": {
    title: "L’ordinateur de l’espace de travail",
    summary: "Chaque espace de travail a son propre ordinateur, toujours allumé, où ses agents travaillent.",
    sections: [
      {
        id: "what",
        heading: "Ce que c’est",
        blocks: [
          "Un ordinateur rien que pour cet espace de travail, toujours allumé. Chaque agent y a son propre utilisateur, avec son dossier, son écran, son navigateur et ses fichiers. Depuis la page d’un agent, vous pouvez le regarder travailler, et prendre la main quand vous en avez besoin.",
        ],
      },
      {
        id: "plans",
        heading: "Vos abonnements IA",
        blocks: [
          "Vos agents peuvent réfléchir avec votre propre abonnement IA, comme Claude, ChatGPT, GLM ou Kimi, connecté sur cet ordinateur : pas besoin de clé API. Le compte reste sur cet ordinateur, et agentes.chat ne voit jamais le mot de passe ni l’accès.",
          "Les abonnements AI Pro et Ultra de Google ne fonctionnent pas ici : les conditions de Google ne les autorisent pas dans d’autres produits. Une clé API Gemini, si.",
        ],
      },
      {
        id: "size",
        heading: "Sa taille",
        blocks: ["Ses processeurs, sa mémoire et son disque sont indiqués dans **Paramètres › Ordinateurs**."],
      },
      {
        id: "trouble",
        heading: "S’il ne répond plus",
        blocks: ["Il revient en général en quelques minutes, et nous nous en occupons : vous n’avez rien à faire."],
      },
    ],
  },
  import: {
    title: "Importer vos agents",
    summary:
      "Importez des agents depuis une autre app, ou depuis un autre espace de travail agentes.chat, avec leurs instructions, compétences, routines et mémoire.",
    sections: [
      {
        id: "comes",
        heading: "Ce qui est importé",
        blocks: [
          {
            list: [
              "Les agents, avec leur nom, leur rôle, leurs instructions et leur apparence.",
              "Les compétences, activées pour les agents qui les avaient.",
              "Les canaux publics, avec les agents qui s’y trouvent.",
              "Les routines, actives et selon leur planning. Mettez-les en pause dans **Routines** si vous le souhaitez.",
              "La mémoire : ce dont chaque agent se souvient.",
              "Les fichiers propres à chaque agent (le dossier de fichiers d’OpenBot.run, un espace de travail OpenClaw), dans un dossier à son nom dans le **Drive**. Les clés, identifiants et fichiers système restent de côté, et rien de ce qui s’y trouve déjà n’est remplacé.",
            ],
          },
        ],
      },
      {
        id: "never",
        heading: "Ce qui n’est jamais importé",
        blocks: [
          "Les clés, mots de passe, identifiants et l’historique des conversations ne sont jamais importés : les agents réfléchissent avec l’IA de l’espace de travail. Certaines choses n’ont pas encore d’équivalent ici, ou ne devraient jamais voyager dans un fichier. Vous pourrez les recréer plus tard.",
          "Les fichiers et dossiers sont lus dans votre navigateur. Un lien GitHub passe par le serveur de l’espace de travail. Les fichiers de clés et d’identifiants ne sont jamais ouverts, et rien ne change tant que vous n’avez pas confirmé.",
        ],
      },
      {
        id: "other-apps",
        heading: "Depuis une autre app",
        blocks: [
          "Choisissez **Grok Bot**, **ChatGPT dots** ou **Une autre app**. Copiez la demande, collez-la dans cette app, puis rapportez ce qu’elle renvoie : déposez le fichier, ou collez toute la réponse. Où chaque app la place :",
          {
            list: [
              "**Grok Bot** : dans la conversation avec votre bot. Il répond avec le JSON : copiez toute la réponse.",
              "**ChatGPT dots** : dans une nouvelle conversation. Téléchargez le fichier qu’il crée.",
              "**Claude** : dans une nouvelle conversation, ou dans le projet de vos agents. Téléchargez le fichier qu’il crée.",
              "**Manus** : dans une nouvelle tâche. Le fichier se trouve dans les résultats de la tâche.",
              "**Rakazo** : envoyez-la à votre agent. Il répond avec le JSON : copiez toute la réponse.",
              "**OpenBot** : aucune demande nécessaire. Glissez le dossier du tenant (agents.yaml, agents/, model.yaml, skills.yaml) ou collez son lien GitHub.",
            ],
          },
        ],
      },
      {
        id: "export",
        heading: "Exporter un espace de travail",
        blocks: [
          "**Paramètres › Importer et exporter › Exporter** télécharge un fichier .json, pour emmener vos agents dans un autre espace de travail ou garder une copie. Dans le fichier :",
          {
            list: [
              "Les agents, avec leurs instructions, leur modèle et leur apparence",
              "Les compétences, avec tout le SKILL.md",
              "Les canaux publics, avec leurs agents",
              "Les routines planifiées (elles arrivent actives de l’autre côté)",
              "La mémoire visible par tout l’espace de travail",
            ],
          },
          "Jamais dedans :",
          {
            list: [
              "Les clés API et les mots de passe",
              "Les connecteurs et les identifiants",
              "Les ordinateurs",
              "Les conversations, les messages et les canaux privés",
              "L’utilisation, les coûts et l’historique d’activité",
            ],
          },
          "Pour utiliser le fichier, ouvrez **Paramètres › Importer et exporter** dans l’autre espace de travail et déposez-y le .json.",
        ],
      },
    ],
  },
  wiki: {
    title: "Le wiki",
    summary: "Ce que l’entreprise sait, dans des pages reliées entre elles.",
    sections: [
      {
        id: "links",
        heading: "Liens",
        blocks: [
          "Tapez [[ pour créer un lien vers une autre page. Les rétroliens et le graphe montrent comment les pages sont reliées.",
        ],
      },
      {
        id: "agents",
        heading: "Comment les agents l’utilisent",
        blocks: ["Les agents lisent le wiki quand ils répondent. Ils n’y écrivent que si quelqu’un le leur demande."],
      },
      {
        id: "obsidian",
        heading: "Importer un coffre Obsidian",
        blocks: [
          "Déposez le dossier du coffre, ou un .zip de celui-ci, à l’étape Contexte de la configuration ou dans l’import du wiki lui-même. Les [[liens]], [[note|alias]] et [[note#section]] continuent de fonctionner. Les tags viennent du frontmatter et du texte. Les pièces jointes vont dans le Drive, et les images et fichiers intégrés deviennent des cartes sur la page. Les callouts restent des callouts. Les requêtes Dataview arrivent sous forme de texte : demandez à un agent de construire le tableau. Les canvas et les réglages d’Obsidian (.obsidian) restent de côté.",
        ],
      },
    ],
  },
  memory: {
    title: "Mémoire",
    summary: "Ce que chaque agent apprend des conversations et des corrections de l’équipe.",
    sections: [
      {
        id: "learns",
        heading: "Comment les agents apprennent",
        blocks: [
          "Les agents apprennent des conversations et des corrections de l’équipe. Ce qu’un agent sait entre dans son contexte quand c’est utile. Dans son onglet **Mémoire**, modifiez, épinglez ou archivez ce qui est faux ou dépassé.",
        ],
      },
      {
        id: "permissions",
        heading: "La mémoire ne donne aucune permission",
        blocks: [
          "Rien dans la mémoire ne permet à un agent d’en faire plus. Ce qu’il peut faire reste dans ses **Outils et accès**, et les actions sensibles demandent toujours une approbation.",
        ],
      },
      {
        id: "proposals",
        heading: "Changements proposés",
        blocks: [
          "Quand une leçon se répète, l’agent peut proposer de modifier ses propres instructions ou le contexte de l’espace de travail. Rien ne change tant que quelqu’un n’accepte pas, et le texte peut être ajusté avant. La version précédente reste dans l’historique. Une proposition refusée est gardée comme leçon, pour qu’elle ne soit pas proposée à nouveau.",
        ],
      },
    ],
  },
  approvals: {
    title: "Approbations",
    summary: "Les actions sensibles attendent une personne, une fois ou pour de bon.",
    sections: [
      {
        id: "what",
        heading: "Ce qui demande d’abord",
        blocks: [
          "Quand un agent veut fusionner, déployer, revenir en arrière, envoyer quelque chose à l’extérieur ou supprimer des données, il demande d’abord, quels que soient ses accès. La demande apparaît dans **Approbations** et dans la conversation, avec l’action exacte et sa raison.",
        ],
      },
      {
        id: "always",
        heading: "Une fois, ou toujours",
        blocks: [
          "Approuver couvre une action exacte, avec ses valeurs. Si l’agent change quoi que ce soit, il redemande.",
          "**Toujours approuver** laisse l’agent faire ce type d’action à partir de maintenant, avec n’importe quelles valeurs, sans demander. Sur la demande d’une routine, **Toujours dans cette routine** fait de même pour cette routine seulement. Aucun des deux n’est proposé pour un merge, un déploiement, un retour arrière et autres. Pour annuler, allez dans **Outils et accès** sur la page de l’agent, ou dans les réglages de la routine.",
        ],
      },
      {
        id: "who",
        heading: "Qui approuve",
        blocks: [
          {
            list: [
              "Le propriétaire de l’agent, pour ses demandes.",
              "Toute personne dont le rôle a **Approuver les actions des agents**, pour tous les agents.",
              "Les personnes que l’agent nomme en demandant, à la place de son propriétaire.",
              "Celui qui couvre quelqu’un dans **Qui approuve pour moi**, pour ce qui est demandé à cette personne. Merge, déploiement et autres actions à risque seulement quand c’est activé.",
            ],
          },
          "Une action dans la boîte mail de quelqu’un attend cette personne seule. Un nouvel accès pour un agent attend ceux qui gèrent les agents.",
          "Lodi, votre bras droit, peut aussi approuver pour vous les nouveaux agents que d’autres agents proposent et les changements de modèle, de budget et de canaux d’un agent, seulement quand c’est vous qui l’avez demandé. Qui vous couvre et ce que Lodi approuve se choisissent dans **Paramètres\u00a0›\u00a0Vous\u00a0›\u00a0Approbations**.",
        ],
      },
      {
        id: "refusing",
        heading: "Refuser",
        blocks: ["Dites pourquoi, si vous voulez : l’agent le lit, ajuste son plan et le garde comme leçon."],
      },
      {
        id: "meetings",
        heading: "Réunions",
        blocks: [
          "Les agents ne font que proposer des créneaux. Les invitations aux personnes passent toujours par celui qui a demandé.",
        ],
      },
    ],
  },
  "who-answers": {
    title: "Qui répond à un message",
    summary: "Une mention choisit l’agent. Sans mention, agentes.chat choisit pour vous, dans cet ordre.",
    sections: [
      {
        id: "order",
        heading: "Comment un message trouve son agent",
        blocks: [
          "Un message qui @mentionne un agent va à cet agent. Un message qui ne mentionne personne est lu par le premier de ceux-ci dont dispose l’espace de travail :",
          {
            list: [
              "**Jev**, un petit modèle rapide conçu pour ce genre de décision.",
              "**Un petit modèle sur l’une des clés API de l’espace de travail**, comme Claude Haiku 5.5 ou GPT-6 Luna.",
              "**Votre propre abonnement Claude ou ChatGPT**, pour les messages que vous écrivez, sur un serveur que vous gérez vous-même. Il les lit sur l’ordinateur où il est connecté, et cela prend quelques secondes.",
              "**Des règles simples** : une réponse à un agent lui revient, tout comme une relance juste après avoir échangé avec lui, ou un message dans un canal où vous êtes seul avec un agent.",
            ],
          },
          "Si aucun ne convient, aucun agent ne répond. Mentionnez un agent pour l’appeler.",
        ],
      },
      {
        id: "jev",
        heading: "Jev",
        blocks: [
          "Quand agentes.chat héberge votre espace de travail, Jev est inclus. Sur un serveur que vous gérez vous-même, il utilise la clé TypeSafe du propriétaire, environ 0,0001 USD par message : [Configurer Jev](/help/jev#setup).",
        ],
      },
      {
        id: "plans",
        heading: "Pourquoi votre abonnement ne choisit que pour vos messages",
        blocks: [
          "Les abonnements Claude et ChatGPT sont personnels, donc votre abonnement ne choisit que pour les messages que vous écrivez.",
        ],
      },
      {
        id: "see",
        heading: "Voir qui a choisi",
        blocks: ["Ouvrez la coche sous un message. Sa dernière ligne indique qui a choisi les agents."],
      },
    ],
  },
  jev: {
    title: "Jev",
    summary:
      "Un modèle rapide de TypeSafe qui prend des décisions rapides pour vos agents. Sur votre propre serveur, il est facultatif, avec votre propre clé.",
    sections: [
      {
        id: "what",
        heading: "Ce qu’il fait",
        blocks: [
          {
            list: [
              "**Il choisit qui répond.** Un message sans @mention va au bon agent en moins d’une seconde, même quand vos agents réfléchissent avec un abonnement et que vous n’avez pas de clé API.",
              "**Il garde la mémoire en ordre.** Il repère une répétition ou un fait plus récent même formulés autrement : la répétition fusionne avec ce que l’agent savait, et le fait plus récent remplace l’ancien. Une fois par jour, il range le reste.",
              "**Il voit l’écran.** Dans leur navigateur et leur bureau, les agents trouvent boutons et champs à partir d’une description, regardent de plus près les petits, et vérifient sur l’image de l’écran qu’une étape a fonctionné.",
              "**Il fait lire moins.** Chaque tour ne charge que les outils dont l’agent aura probablement besoin, donc votre IA lit moins et coûte moins.",
            ],
          },
        ],
      },
      {
        id: "without",
        heading: "Sans lui",
        blocks: [
          "Tout continue de fonctionner, plus lentement et avec moins de soin.",
          {
            list: [
              "**Qui répond :** un petit modèle sur l’une de vos clés API choisit, comme Claude Haiku 5.5 ou GPT-6 Luna. Sans clé, l’abonnement Claude ou ChatGPT de chaque personne choisit pour les messages qu’elle écrit, en quelques secondes. Sinon, une réponse ou une relance atteint quand même son agent. Mentionnez un agent pour l’appeler. [Comment les agents sont choisis](/help/who-answers)",
              "**Mémoire :** les répétitions dans les mêmes mots fusionnent toujours. Les répétitions et mises à jour formulées autrement restent séparées.",
              "**Écran :** les agents utilisent les numéros affichés à l’écran et les noms exacts. Rien n’est lu dans les images.",
            ],
          },
        ],
      },
      {
        id: "setup",
        heading: "Le configurer",
        blocks: [
          {
            list: [
              "Ouvrez https://console.typesafe.ai et connectez-vous avec Google ou votre e-mail. Un nouveau compte se crée de la même façon.",
              "Ajoutez du crédit dans la console. Jev est prépayé.",
              "Ouvrez https://console.typesafe.ai/keys, créez une clé et copiez-la tout de suite.",
              "Dans agentes.chat, ouvrez **Paramètres › IA et utilisation** et collez-la sous **Jev**. Seule la personne qui a installé ce serveur la voit.",
            ],
          },
          "Sur un serveur que vous faites tourner avec Docker, vous pouvez plutôt mettre la clé dans `.env` en tant que `TYPESAFE_API_KEY`. Celle-ci l’emporte sur celle des Paramètres.",
        ],
      },
      {
        id: "cost",
        heading: "Ce qu’il coûte",
        blocks: [
          {
            list: [
              "0,042 USD par million de jetons lus par Jev. Ses réponses sont gratuites. Choisir qui répond lit environ 2 500 jetons, soit environ 0,0001 USD. Une capture d’écran fait environ 3 900 jetons.",
              "Les crédits achetés durent 12 mois. Activez la recharge automatique dans la console pour que Jev ne tombe pas à court.",
              "**Paramètres › IA et utilisation** indique combien de décisions Jev a prises ce mois-ci, et ce qu’elles ont coûté.",
            ],
          },
        ],
      },
      {
        id: "data",
        heading: "Vos données",
        blocks: [
          "Ce que Jev lit pour décider :",
          {
            list: [
              "Le nom et la description du canal, le message et les quelques précédents",
              "Les noms et rôles de vos agents, le début de leurs instructions et les outils qu’ils peuvent utiliser",
              "Les éléments de mémoire qu’il compare",
              "La tâche d’un agent et le début des résultats de ses outils",
              "L’objectif d’une mission et les commandes qu’un agent veut exécuter pour elle",
              "Les outils proposés par une app connectée",
              "La page ou l’écran qu’un agent utilise, captures d’écran comprises",
            ],
          },
          "TypeSafe fait tourner Jev aux États-Unis et n’entraîne pas ses modèles sur ce que vous envoyez. Il conserve les données le temps nécessaire au fonctionnement du service. La rétention zéro est disponible dans ses offres entreprise.",
          "Politique de confidentialité de TypeSafe : https://typesafe.ai/legal/privacy-policy. Son accord de traitement des données : https://typesafe.ai/legal/data-processing.",
        ],
      },
      {
        id: "problems",
        heading: "Quand il s’arrête",
        blocks: [
          {
            list: [
              "**Clé refusée :** créez une nouvelle clé et collez-la dans **Paramètres › IA et utilisation**.",
              "**Plus de crédit :** ajoutez du crédit dans la console. Jev réessaie dans les 30 minutes, ou cliquez sur **Vérifier à nouveau**.",
              "**Occupé ou injoignable :** TypeSafe peut limiter les requêtes par seconde, ou cesser de répondre un moment. Jev reprend tout seul. Vos limites : https://console.typesafe.ai/rate-limits. Pour des limites plus élevées, écrivez à sales@typesafe.ai.",
            ],
          },
          "En attendant, les agents fonctionnent comme dans [Sans lui](/help/jev#without).",
        ],
      },
    ],
  },
  "apps-de-ia": {
    title: "Applications d’IA",
    summary:
      "Confiez des tâches aux agents d’agentes.chat depuis Claude, Cursor ou une autre app MCP, sans la quitter, et recevez la réponse au même endroit.",
    sections: [
      {
        id: "what",
        heading: "Comment ça fonctionne",
        blocks: [
          "agentes.chat est un serveur MCP. Vous collez son adresse dans votre app IA, vous vous connectez avec votre compte et vous choisissez un espace de travail. Ensuite, l’app peut lister les agents et les canaux, confier une tâche à un agent en votre nom, attendre la réponse et lire les tâches récentes.",
          "Par exemple, au milieu d’une scène dans Unity ou Blender, demandez à Claude : « Demande à l’agent marketing un texte pour le lancement ». Le message apparaît dans agentes.chat comme le vôtre, marqué **via Claude**, et la réponse de l’agent revient dans Claude.",
          "L’adresse se trouve dans **Paramètres › Applications d’IA**. Elle se termine par `/mcp`.",
        ],
      },
      {
        id: "connect",
        heading: "Connecter une app",
        blocks: [
          {
            list: [
              "**Claude** (claude.ai, Claude Desktop et mobile) : dans **Personnaliser › Connecteurs** (Customize › Connectors), cliquez sur **+ Ajouter**, puis sur **Ajouter un connecteur personnalisé** (Add custom connector), nommez-le agentes.chat, collez l’adresse et cliquez sur **Continuer**. Choisissez **Se connecter maintenant** (Sign in now), cliquez sur **Ajouter** et autorisez. Avec les abonnements Team et Enterprise, le propriétaire de l’organisation Claude ajoute le connecteur dans Paramètres de l’organisation › Connecteurs, puis chaque personne clique sur **Connecter** dans Personnaliser › Connecteurs. L’abonnement gratuit de Claude permet un connecteur personnalisé.",
              "**Claude Code :** exécutez `claude mcp add --transport http --scope user agentes <adresse>`, puis tapez `/mcp`, choisissez agentes et **Authenticate**. Pour le dossier courant uniquement, retirez `--scope user`.",
              "**Cursor :** **Ajouter à Cursor** dans **Paramètres › Applications d’IA**, ou l’adresse dans `~/.cursor/mcp.json`. Cursor vous demande de vous connecter à la première utilisation.",
              '**VS Code :** **Ajouter à VS Code**, ou l’adresse dans `.vscode/mcp.json` avec `"type": "http"`.',
              "**Autres apps :** ChatGPT, Gemini, Grok, Perplexity, Codex, Zed, JetBrains et d’autres ont chacune leurs étapes dans **Connecter une app**, avec votre adresse déjà remplie.",
            ],
          },
          "Lors de la connexion, agentes.chat indique quelle app a demandé l’accès et où elle renvoie. Ne continuez que si vous venez de lancer la connexion.",
        ],
      },
      {
        id: "tools",
        heading: "Ce que l’app peut faire",
        blocks: [
          {
            list: [
              "`send_to_agent` : envoie un message de votre part à un agent, dans votre conversation privée avec lui ou dans un canal, et attend la réponse. Uniquement avec l’accès **Lire et confier des tâches aux agents**.",
              "`wait_for_reply` : continue d’attendre la réponse à une tâche.",
              "`list_agents` : les agents que vous voyez.",
              "`list_channels` : les canaux que vous lisez.",
              "`read_conversation` : les messages récents d’un canal, d’un fil ou d’une tâche.",
              "`list_recent_tasks` : les tâches que vous avez envoyées depuis des apps et ce que font les agents en ce moment.",
            ],
          },
          "L’app agit en votre nom et ne voit que ce que vous voyez. Elle n’approuve jamais les actions des agents : quand un agent s’arrête pour demander une approbation, la réponse l’indique avec un lien, et une personne décide dans agentes.chat. Elle ne modifie pas non plus les paramètres, les membres ou les permissions.",
        ],
      },
      {
        id: "workspace",
        heading: "Un espace de travail par connexion",
        blocks: [
          "Chaque connexion couvre l’espace de travail choisi lors de la connexion. Pour utiliser un autre espace de travail, reconnectez l’app et choisissez l’autre.",
          "Dans **Paramètres › Applications d’IA**, vous voyez les apps connectées, quand chacune a été utilisée, et vous pouvez déconnecter n’importe laquelle. Les personnes qui gèrent les membres voient les apps de tout l’espace de travail et peuvent aussi les déconnecter. Chaque message envoyé depuis une app apparaît dans l’Audit.",
        ],
      },
      {
        id: "tokens",
        heading: "Jetons personnels",
        blocks: [
          "Pour les scripts et les apps sans connexion OAuth, créez un jeton personnel dans **Paramètres › Applications d’IA** et envoyez-le dans l’en-tête `Authorization: Bearer`. Le jeton s’affiche une seule fois, ne fonctionne que dans l’espace de travail où il a été créé, et peut expirer dans 30 jours, 90 jours, 1 an ou jamais.",
          "Sur un serveur sans https, ailleurs que sur son propre ordinateur, utilisez un jeton personnel : la connexion OAuth exige https.",
        ],
      },
      {
        id: "limits",
        heading: "Limites",
        blocks: [
          {
            list: [
              "Jusqu’à 120 requêtes par minute et 5 000 par jour par connexion.",
              "Jusqu’à 20 messages par minute et 500 par jour par personne dans chaque espace de travail.",
              "Une attente dure jusqu’à 45 secondes. Si l’agent travaille encore, l’app attend à nouveau.",
            ],
          },
        ],
      },
      {
        id: "safety",
        heading: "Le texte des autres",
        blocks: [
          "Les réponses contiennent du texte écrit par des agents et des personnes dans agentes.chat. L’app reçoit ce texte marqué comme contenu, pas comme instructions, mais un texte peut quand même tenter de pousser l’app à faire autre chose. Vérifiez ce que votre app s’apprête à faire avant de confirmer.",
        ],
      },
      {
        id: "problems",
        heading: "Quand la connexion échoue",
        blocks: [
          {
            list: [
              "**Demande expirée :** la page de connexion dure 30 minutes et ne sert qu’une fois. Revenez dans l’app et reconnectez-vous.",
              "**L’app demande de se reconnecter :** la connexion a été coupée, le mot de passe a changé ou vous avez quitté l’espace de travail. Reconnectez-vous depuis l’app.",
              "**Cursor bloqué sur une ancienne connexion :** quittez Cursor, supprimez le dossier `~/.mcp-auth` et reconnectez-vous.",
            ],
          },
        ],
      },
    ],
  },
  "install-on-a-server": {
    title: "Installer agentes.chat sur un serveur",
    summary:
      "Faites tourner agentes.chat sur votre propre serveur, gratuitement, pour toute votre équipe. Une commande suffit.",
    sections: [
      {
        id: "need",
        heading: "Ce qu'il vous faut",
        blocks: [
          {
            list: [
              "Un serveur ou un VPS sous Linux 64 bits, en x64 ou arm64. Pour une petite équipe, 2 CPU, 4 Go de mémoire et 20 Go de disque sont un bon début. Pour essayer, un Mac avec Docker Desktop, OrbStack ou Colima convient aussi.",
              "Docker avec Compose. Sous Linux, l'installateur les ajoute s'ils manquent, après vous avoir demandé.",
              "Un moyen d'y accéder\u00a0: un compte Tailscale gratuit (le choix par défaut, privé, sans domaine ni port ouvert), ou un domaine qui pointe vers le serveur, avec les ports 80 et 443 ouverts.",
            ],
          },
        ],
      },
      {
        id: "install",
        heading: "L'installer",
        blocks: [
          "Sur le serveur, lancez\u00a0:",
          {
            code: "curl -fsSL https://agentes.chat/install | sh",
          },
          "Il installe ce qui manque, puis pose quelques questions\u00a0: comment on y accède, l'e-mail, si ce serveur est aussi l'ordinateur de vos agents, et s'il envoie des statistiques d'utilisation anonymes. Entrée prend la réponse proposée. Il s'installe dans `/opt/agentes` (`~/agentes` pour un utilisateur qui peut déjà utiliser Docker), et la première fois il télécharge environ 2 Go.",
          "À la fin, il affiche l'adresse de votre serveur et un QR code pour votre téléphone. Le relancer ne casse rien\u00a0: il garde vos réglages et ne complète que ce qui manque.",
          "Avec Node.js 18 ou plus récent, `npx @agenteschat/setup` dans un dossier vide fait la même configuration. Sans Node, elle tourne depuis l'image de l'app, dans le dossier courant, et se termine par les commandes qui démarrent le reste\u00a0:",
          {
            code: 'docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD":/work -w /work ghcr.io/agentes-chat/agentes:latest setup',
          },
        ],
      },
      {
        id: "reach",
        heading: "Comment on y accède",
        blocks: [
          {
            list: [
              "**Tailscale**, le choix par défaut\u00a0: du HTTPS privé à `https://agentes.<votre-tailnet>.ts.net`, seulement pour les appareils de votre réseau Tailscale. Avant d'installer, activez MagicDNS et HTTPS sur https://console.tailscale.com/admin/dns et créez une clé d'accès (auth key) sur https://console.tailscale.com/admin/settings/keys pour que la configuration vous la demande.",
              "**Un domaine public**\u00a0: tout le monde sur internet peut l'ouvrir, à `https://chat.example.com` par exemple. Faites pointer le domaine vers le serveur et ouvrez les ports 80 et 443. La configuration obtient le certificat et le renouvelle, et vous fait créer votre compte avant que le domaine soit en ligne.",
              "**Cette machine seulement**\u00a0: `http://localhost:3000`, pour l'essayer sur votre propre ordinateur.",
            ],
          },
          "Sur Tailscale, le serveur quitte votre réseau quand sa clé expire, au bout de 180 jours. Pour le garder, ouvrez le menu **⋯** du serveur sur https://console.tailscale.com/admin/machines et choisissez **Disable Key Expiry**.",
          "Les webhooks qui lancent des routines et les apps d'IA qui appellent depuis leurs propres serveurs ont besoin d'une adresse publique. Sur Tailscale, Funnel ouvre la même adresse à internet\u00a0: ajoutez Funnel à la politique de votre tailnet sur https://console.tailscale.com/admin/acls et mettez `TAILSCALE_FUNNEL=true` dans `.env`, puis lancez `docker compose up -d`.",
        ],
      },
      {
        id: "owner",
        heading: "Votre compte",
        blocks: [
          "Ouvrez l'adresse de votre serveur et inscrivez-vous\u00a0: le premier compte devient le propriétaire. Les inscriptions se ferment ensuite, et les gens entrent sur invitation, depuis **Paramètres\u00a0›\u00a0Membres et invitations**.",
          "Sur Tailscale, les personnes que vous invitez doivent aussi être dans votre tailnet. Invitez-les d'abord sur https://console.tailscale.com/admin/users puis dans agentes.chat.",
        ],
      },
      {
        id: "email",
        heading: "E-mail",
        blocks: [
          "Sans e-mail, agentes.chat écrit chaque e-mail dans son journal au lieu de l'envoyer, vous pouvez donc y copier un lien d'invitation. La réinitialisation du mot de passe reste désactivée.",
          {
            code: "docker compose logs agentes | grep 'email (not sent'",
          },
          "La configuration accepte votre propre serveur de messagerie (SMTP) ou la clé d'une API compatible avec Resend, comme MillionSend ou Resend. Les e-mails partent de `ping@<domaine de votre serveur>`, sauf si vous choisissez un autre expéditeur, et ce domaine doit être vérifié chez votre fournisseur d'e-mail. Pour le configurer plus tard, relancez l'installation.",
        ],
      },
      {
        id: "phone",
        heading: "Votre téléphone",
        blocks: [
          {
            list: [
              "Sur Tailscale, installez l'app Tailscale sur votre téléphone et connectez-vous à la même tailnet.",
              "Installez l'app agentes.chat.",
              "Scannez le QR code affiché par la configuration, ou celui de **Paramètres\u00a0›\u00a0Votre compte\u00a0›\u00a0Ouvrir sur votre téléphone**, qui vous connecte aussi.",
            ],
          },
        ],
      },
      {
        id: "computers",
        heading: "Les ordinateurs de vos agents",
        blocks: [
          "La configuration peut faire de ce serveur l'ordinateur de vos agents, où ils lancent des commandes, utilisent un navigateur et gardent leurs fichiers. Elle vous demande, et propose oui là où le serveur s'y prête bien. Sous Linux, chaque agent a son propre utilisateur, avec un écran. Si vous avez dit non, relancez l'installation avec `--computer yes`\u00a0:",
          {
            code: "curl -fsSL https://agentes.chat/install | sh -s -- --computer yes",
          },
          "D'autres ordinateurs, comme un Mac avec l'app agentes.chat ou un autre serveur, se connectent depuis **Paramètres\u00a0›\u00a0Ordinateurs**, comme dans [Des ordinateurs pour vos agents](/help/computers). Sur Tailscale, ils rejoignent d'abord votre tailnet.",
        ],
      },
      {
        id: "backups",
        heading: "Sauvegardes et restauration",
        blocks: [
          "Votre serveur, c'est trois choses\u00a0: la base de données, les fichiers envoyés et `AGENTES_SECRET` dans `.env`. Gardez une copie de `.env` en lieu sûr, à part des sauvegardes\u00a0: sans le secret, les clés stockées dans une base restaurée sont illisibles.",
          "Pour une sauvegarde chaque jour, créez un bucket privé sur Cloudflare R2 ou un autre service compatible S3, et une clé qui peut y lire, écrire et supprimer. Ajoutez-les à `.env`, avec `backup` dans `COMPOSE_PROFILES` (`https,backup` avec un domaine public)\u00a0:",
          {
            code: "S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com\nS3_ACCESS_KEY_ID=…\nS3_SECRET_ACCESS_KEY=…\nS3_BACKUP_BUCKET=agentes-backups\nCOMPOSE_PROFILES=tailscale,backup",
          },
          "Puis lancez `docker compose up -d` dans le dossier d'installation. La base est sauvegardée à 03:00 UTC et chaque sauvegarde est gardée 14 jours. `docker compose run --rm backup now` en fait une tout de suite, et `docker compose run --rm backup list` les liste. Les sauvegardes ne contiennent que la base\u00a0: les fichiers envoyés, dans le volume `files`, ont besoin de leur propre copie, et le guide complet, plus bas, donne les commandes.",
          "Pour restaurer, récupérez une sauvegarde avec `docker compose run --rm -T backup fetch <nom> > agentes.dump`, puis chargez-la dans une base vide, l'app arrêtée\u00a0:",
          {
            code: "docker compose stop agentes\ndocker compose exec -T postgres dropdb -U agentes --force agentes\ndocker compose exec -T postgres createdb -U agentes agentes\ndocker compose exec -T postgres pg_restore -U agentes -d agentes --exit-on-error < agentes.dump\ndocker compose start agentes",
          },
          "Restaurez dans la version qui a fait la sauvegarde, ou une plus récente.",
        ],
      },
      {
        id: "upgrades",
        heading: "Mises à jour",
        blocks: [
          "Dans le dossier d'installation, lancez\u00a0:",
          {
            code: "curl -fsSLO https://agentes.chat/install/docker-compose.yml\ndocker compose pull\ndocker compose up -d",
          },
          "La base se met à jour toute seule au démarrage de la nouvelle version. Gardez vos réglages dans `.env` et ne modifiez jamais `docker-compose.yml`, que chaque mise à jour remplace. Sauvegardez avant un grand saut\u00a0: une base mise à jour par une version plus récente ne s'ouvre pas dans une plus ancienne.",
        ],
      },
      {
        id: "data",
        heading: "Ce qu'il envoie",
        blocks: [
          "Une fois par jour, le serveur envoie à agentes.chat des statistiques d'utilisation anonymes\u00a0: des comptes comme les personnes, les agents, la taille des machines, les tokens d'IA utilisés et la quantité de données que les navigateurs des agents envoient et reçoivent. Jamais de messages, de fichiers, de noms ni de sites. `docker compose run --rm agentes telemetry` affiche exactement ce qui serait envoyé. Le propriétaire le désactive dans **Paramètres\u00a0›\u00a0Général**, ou avec `TELEMETRY=off` dans `.env`.",
          "Les rapports d'erreur ne partent nulle part, sauf si vous mettez dans `SENTRY_DSN` un serveur compatible Sentry de votre choix. Un rapport contient l'erreur et l'endroit où elle s'est produite, jamais de messages, d'e-mails, d'adresses IP, de cookies ni de tokens.",
        ],
      },
      {
        id: "reference",
        heading: "Le guide complet",
        blocks: [
          "Tous les réglages, votre propre proxy comme nginx, l'usage sans Docker, un guide pour les agents d'IA qui l'installent seuls et que faire quand quelque chose échoue se trouvent dans `SELF_HOSTING.md`, dans le dépôt agentes.chat.",
        ],
      },
    ],
  },
};
