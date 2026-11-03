import type { HelpSlug } from "./index";
import type { HelpDocument } from "./types";

/** The help pages in nl: a page not here shows in English. */
export const helpNl: Partial<Record<HelpSlug, HelpDocument>> = {
  "run-on-your-computer": {
    title: "agentes.chat op je eigen computer draaien",
    summary:
      "De agentes.chat-app kan ook agentes.chat zelf draaien, op een Mac, een pc of een Linux-computer, voor jou of een klein team.",
    sections: [
      {
        id: "how",
        heading: "Hoe het draait",
        blocks: [
          "Het draait in de app, met een eigen ingebouwde database, en bewaart alles in één map op deze computer: `.agentes` in je thuismap. Verder hoef je niets te installeren: geen Docker, geen database om in te richten.",
          "Het start met de app en stopt als je de app afsluit. Afsluiten vraagt eerst om bevestiging, want niemand kan agentes.chat gebruiken tot de app weer opent.",
        ],
      },
      {
        id: "who",
        heading: "Voor wie het is",
        blocks: [
          "Gemaakt voor jou of een klein team, zolang deze computer aanstaat. Voor een groter team, of een server die altijd aanstaat, installeer je agentes.chat op een server en kies je **Verbinden met mijn server** in de app. Je gegevens kunnen er later naartoe verhuizen.",
        ],
      },
      {
        id: "agents",
        heading: "Je agents werken hier ook",
        blocks: [
          "Je agents werken ook op deze computer, in hun eigen mappen, met een browser, en met Claude Code of Codex als die hier zijn geïnstalleerd. Opdrachten staan uit tot je ze aanzet in **Voorkeuren › Tools**.",
        ],
      },
      {
        id: "reach",
        heading: "Vanaf je telefoon en voor je team",
        blocks: [
          "**Bereikbaar vanaf je telefoon en voor teamgenoten** zet agentes.chat op Tailscale, een privénetwerk voor je apparaten: je telefoon en de mensen die je uitnodigt doen mee, en verder kan niemand agentes.chat bereiken. Tailscale is gratis: https://tailscale.com/download. Staat het uit, dan werkt agentes.chat alleen op deze computer.",
        ],
      },
      {
        id: "backups",
        heading: "Back-ups en verhuizen",
        blocks: [
          "**Nu back-up maken**, in **Voorkeuren › Servers**, bewaart de database, de bestanden en de instellingen in `.agentes/backups`, in je thuismap.",
        ],
      },
    ],
  },
  computers: {
    title: "Computers voor je agents",
    summary:
      "Agents voeren code uit en werken met bestanden op computers die je koppelt: een Mac of een pc met de agentes.chat-app, of een server.",
    sections: [
      {
        id: "mac",
        heading: "Een Mac of een pc, met de app",
        blocks: [
          "De agentes.chat-app opent je server in een eigen venster, en met één klik werken de agents op die computer, in hun eigen mappen. Installeer de app, open hem, kies **Je eigen server gebruiken › Verbinden met mijn server** en typ het adres van je server. Klik daarna, ingelogd, op **Deze Mac gebruiken** (**Deze pc gebruiken** op Windows, **Deze computer gebruiken** op Linux) in **Instellingen › Computers**.",
        ],
      },
      {
        id: "server",
        heading: "Een server of een Linux-computer",
        blocks: [
          "Kopieer in **Instellingen › Computers** de opdracht onder **Andere manieren** en voer hem uit in de terminal van die computer. Je ziet een code en een link: open de link, controleer of de code klopt en bevestig met je account. Je hoeft vooraf niets te installeren.",
        ],
      },
      {
        id: "folders",
        heading: "Mappen",
        blocks: [
          "Elke agent heeft altijd een eigen map, in `~/agentes/<workspace>`. Meer mappen geef je vrij op de computer zelf, nooit via de website: in de app via **Voorkeuren › Mappen**, of met `agentes-runner folders allow` op een server. Elke werkruimte geeft zijn eigen mappen vrij: wat je voor de ene vrijgeeft, geldt alleen voor de agents daarvan. Een map weghalen verwijdert niets. Het neemt alleen de toegang weg.",
        ],
      },
      {
        id: "pausing",
        heading: "Pauzeren",
        blocks: [
          "Met de app kan degene die een computer heeft gekoppeld de agents daar pauzeren, via het agentes.chat-icoon bij de klok. Er start niets nieuws tot diegene hervat. Wat al liep, maakt zijn werk af.",
        ],
      },
      {
        id: "organizations",
        heading: "Meerdere werkruimtes",
        blocks: [
          "Eén computer kan voor meerdere werkruimtes werken. Elke werkruimte heeft daar zijn eigen agents, mappen en taken, en er één ontkoppelen raakt de andere niet.",
        ],
      },
    ],
  },
  "workspace-computer": {
    title: "De computer van de werkruimte",
    summary: "Elke werkruimte krijgt een eigen computer die altijd aanstaat, waar de agents werken.",
    sections: [
      {
        id: "what",
        heading: "Wat het is",
        blocks: [
          "Een computer alleen voor deze werkruimte, die altijd aanstaat. Elke agent heeft er een eigen gebruiker, met een eigen map, scherm, browser en bestanden. Op de pagina van een agent kun je meekijken terwijl hij werkt, en de controle overnemen als dat nodig is.",
        ],
      },
      {
        id: "plans",
        heading: "Je AI-abonnementen",
        blocks: [
          "Je agents kunnen denken met je eigen AI-abonnement, zoals Claude, ChatGPT, GLM of Kimi, ingelogd op deze computer: geen API-sleutel nodig. Het account blijft op deze computer, en agentes.chat ziet nooit het wachtwoord of de toegang.",
          "De abonnementen AI Pro en Ultra van Google werken hier niet: de voorwaarden van Google staan ze niet toe in andere producten. Een Gemini-API-sleutel wel.",
        ],
      },
      {
        id: "size",
        heading: "Hoe groot hij is",
        blocks: ["De CPU's, het geheugen en de schijf staan in **Instellingen › Computers**."],
      },
      {
        id: "trouble",
        heading: "Als hij niet meer reageert",
        blocks: ["Meestal is hij binnen een paar minuten terug, en we zijn ermee bezig: je hoeft zelf niets te doen."],
      },
    ],
  },
  import: {
    title: "Je agents meenemen",
    summary:
      "Neem agents mee uit een andere app, of uit een andere agentes.chat-werkruimte, met hun instructies, skills, routines en geheugen.",
    sections: [
      {
        id: "comes",
        heading: "Wat er meekomt",
        blocks: [
          {
            list: [
              "Agents, met hun naam, rol, instructies en uiterlijk.",
              "Skills, aan voor de agents die ze hadden.",
              "Openbare kanalen, met de agents erin.",
              "Routines, actief en volgens hun schema. Pauzeer ze in **Routines** als je wilt.",
              "Geheugen: wat elke agent onthoudt.",
              "De eigen bestanden van elke agent (de bestandenmap van OpenBot.run, een OpenClaw-werkruimte), in een map met zijn naam in de **Drive**. Sleutels, logins en systeembestanden blijven achter, en niets wat er al staat wordt vervangen.",
            ],
          },
        ],
      },
      {
        id: "never",
        heading: "Wat nooit meekomt",
        blocks: [
          "Sleutels, wachtwoorden, logins en chatgeschiedenis komen nooit mee: de agents denken met de AI van de werkruimte. Sommige dingen hebben hier nog geen tegenhanger, of horen nooit in een bestand te reizen. Je kunt ze later opnieuw aanmaken.",
          "Bestanden en mappen worden in je browser gelezen. Een GitHub-link gaat via de server van de werkruimte. Sleutel- en loginbestanden worden nooit geopend, en er verandert niets tot je bevestigt.",
        ],
      },
      {
        id: "other-apps",
        heading: "Uit een andere app",
        blocks: [
          "Kies **Grok Bot**, **ChatGPT dots** of **Een andere app**. Kopieer het verzoek, plak het in die app en breng terug wat die teruggeeft: sleep het bestand erin, of plak het hele antwoord. Waar elke app het neerzet:",
          {
            list: [
              "**Grok Bot**: in de chat met je bot. Hij antwoordt met de JSON: kopieer het hele antwoord.",
              "**ChatGPT dots**: in een nieuwe chat. Download het bestand dat hij maakt.",
              "**Claude**: in een nieuw gesprek, of in het project van je agents. Download het bestand dat hij maakt.",
              "**Manus**: in een nieuwe taak. Het bestand staat in de resultaten van de taak.",
              "**Rakazo**: stuur het naar je agent. Hij antwoordt met de JSON: kopieer het hele antwoord.",
              "**OpenBot**: geen verzoek nodig. Sleep de tenantmap (agents.yaml, agents/, model.yaml, skills.yaml) erin of plak de GitHub-link ervan.",
            ],
          },
        ],
      },
      {
        id: "export",
        heading: "Een werkruimte exporteren",
        blocks: [
          "**Instellingen › Importeren en exporteren › Exporteren** downloadt een .json-bestand, om je agents mee te nemen naar een andere werkruimte of om een kopie te bewaren. In het bestand:",
          {
            list: [
              "Agents, met hun instructies, model en uiterlijk",
              "Skills, met de hele SKILL.md",
              "Openbare kanalen, met hun agents",
              "Geplande routines (ze komen actief aan de andere kant aan)",
              "Het geheugen dat iedereen in de werkruimte kan zien",
            ],
          },
          "Nooit erin:",
          {
            list: [
              "API-sleutels en wachtwoorden",
              "Connectors en logins",
              "Computers",
              "Gesprekken, berichten en privékanalen",
              "Gebruik, kosten en activiteitengeschiedenis",
            ],
          },
          "Om het bestand te gebruiken, open je **Instellingen › Importeren en exporteren** in de andere werkruimte en sleep je de .json erin.",
        ],
      },
    ],
  },
  wiki: {
    title: "De wiki",
    summary: "Wat het bedrijf weet, in pagina's die naar elkaar linken.",
    sections: [
      {
        id: "links",
        heading: "Links",
        blocks: [
          "Typ [[ om naar een andere pagina te linken. Backlinks en de graaf laten zien hoe pagina's samenhangen.",
        ],
      },
      {
        id: "agents",
        heading: "Hoe agents hem gebruiken",
        blocks: ["Agents lezen de wiki als ze antwoorden. Ze schrijven er alleen in als iemand daarom vraagt."],
      },
      {
        id: "obsidian",
        heading: "Een Obsidian-vault meenemen",
        blocks: [
          "Sleep de map van de vault, of een .zip ervan, in de stap Context van de setup of in de eigen import van de wiki. [[Links]], [[notitie|alias]] en [[notitie#sectie]] blijven werken. Tags komen uit de frontmatter en de tekst. Bijlagen gaan naar de Drive, en ingesloten afbeeldingen en bestanden worden kaarten op de pagina. Callouts blijven callouts. Dataview-query's komen binnen als tekst: vraag een agent om de tabel te bouwen. Canvassen en de instellingen van Obsidian (.obsidian) blijven buiten.",
        ],
      },
    ],
  },
  memory: {
    title: "Geheugen",
    summary: "Wat elke agent leert van gesprekken en van de correcties van het team.",
    sections: [
      {
        id: "learns",
        heading: "Hoe agents leren",
        blocks: [
          "Agents leren van gesprekken en van de correcties van het team. Wat een agent weet, komt in zijn context als het relevant is. Op het tabblad **Geheugen** bewerk, pin of archiveer je wat niet klopt of verouderd is.",
        ],
      },
      {
        id: "permissions",
        heading: "Geheugen geeft geen toestemming",
        blocks: [
          "Niets in het geheugen laat een agent meer doen. Wat hij mag, blijft in zijn **Tools en toegang**, en gevoelige acties vragen altijd om goedkeuring.",
        ],
      },
      {
        id: "proposals",
        heading: "Voorgestelde wijzigingen",
        blocks: [
          "Als een les terugkomt, kan de agent voorstellen zijn eigen instructies of de context van de werkruimte aan te passen. Er verandert niets tot iemand het accepteert, en de tekst kan eerst worden bijgewerkt. De vorige versie blijft in de geschiedenis. Een geweigerd voorstel wordt bewaard als les, zodat het niet opnieuw wordt voorgesteld.",
        ],
      },
    ],
  },
  approvals: {
    title: "Goedkeuringen",
    summary: "Er gebeurt niets gevoeligs zonder een mens.",
    sections: [
      {
        id: "what",
        heading: "Wat eerst vraagt",
        blocks: [
          "Als een agent wil mergen, deployen, terugdraaien, iets naar buiten sturen of gegevens verwijderen, vraagt hij het eerst, welke toegang hij ook heeft. Het verzoek verschijnt in **Goedkeuringen** en in het kanaal, met de precieze actie en de reden.",
        ],
      },
      {
        id: "exact",
        heading: "Eén goedkeuring, één actie",
        blocks: [
          "Elke goedkeuring geldt voor één precieze actie, met haar waarden. Verandert de agent iets, dan moet hij het opnieuw vragen.",
        ],
      },
      {
        id: "who",
        heading: "Wie goedkeurt",
        blocks: [
          "De eigenaar van de agent keurt zijn verzoeken goed. Heeft een agent geen eigenaar, dan doen de beheerders het.",
        ],
      },
      {
        id: "refusing",
        heading: "Weigeren",
        blocks: ["Zeg waarom, als je wilt: de agent leest het, past zijn plan aan en bewaart het als les."],
      },
      {
        id: "meetings",
        heading: "Afspraken",
        blocks: ["Agents stellen alleen tijden voor. Uitnodigingen aan mensen gaan altijd via degene die erom vroeg."],
      },
    ],
  },
  "who-answers": {
    title: "Wie een bericht beantwoordt",
    summary: "Een vermelding kiest de agent. Zonder vermelding kiest agentes.chat voor je, in deze volgorde.",
    sections: [
      {
        id: "order",
        heading: "Hoe een bericht zijn agent vindt",
        blocks: [
          "Een bericht dat een agent @vermeldt, gaat naar die agent. Een bericht zonder vermelding wordt gelezen door de eerste van deze die de werkruimte heeft:",
          {
            list: [
              "**Jev**, een klein, snel model gemaakt voor beslissingen zoals deze.",
              "**Een klein model op een van de API-sleutels van de werkruimte**, zoals Claude Haiku 5.5 of GPT-6 Luna.",
              "**Je eigen Claude- of ChatGPT-abonnement**, voor de berichten die jij schrijft, op een server die je zelf beheert. Het leest ze op de computer waar het is ingelogd, en dat duurt een paar seconden.",
              "**Eenvoudige regels**: een antwoord aan een agent gaat naar die agent, net als een vervolgbericht vlak nadat je met hem sprak, of een bericht in een kanaal waar je alleen bent met één agent.",
            ],
          },
          "Past geen van deze, dan antwoordt er geen agent. Vermeld een agent om hem op te roepen.",
        ],
      },
      {
        id: "jev",
        heading: "Jev",
        blocks: [
          "Als agentes.chat je werkruimte host, zit Jev erbij inbegrepen. Op een server die je zelf beheert, gebruikt hij de TypeSafe-sleutel van de eigenaar, ongeveer US$ 0,0001 per bericht: [Jev instellen](/help/jev#setup).",
        ],
      },
      {
        id: "plans",
        heading: "Waarom je abonnement alleen voor jouw berichten kiest",
        blocks: [
          "Abonnementen van Claude en ChatGPT zijn persoonlijk, dus je abonnement kiest alleen voor de berichten die jij schrijft.",
        ],
      },
      {
        id: "see",
        heading: "Zien wie er koos",
        blocks: ["Open het vinkje onder een bericht. De laatste regel zegt wie de agents koos."],
      },
    ],
  },
  jev: {
    title: "Jev",
    summary:
      "Een snel model van TypeSafe dat snelle beslissingen neemt voor je agents. Op je eigen server is het optioneel, met een eigen sleutel.",
    sections: [
      {
        id: "what",
        heading: "Wat het doet",
        blocks: [
          {
            list: [
              "**Kiest wie antwoordt.** Een bericht waarin niemand is @vermeld, gaat in minder dan een seconde naar de juiste agent, ook als je agents denken met een abonnement en je geen API-sleutel hebt.",
              "**Houdt het geheugen netjes.** Het herkent een herhaling of een nieuwer feit, ook in andere woorden: de herhaling gaat op in wat de agent al wist, en het nieuwere feit vervangt het oude. Eén keer per dag ruimt het de rest op.",
              "**Ziet het scherm.** In hun browser en op hun bureaublad vinden agents knoppen en velden aan de hand van een beschrijving, kijken ze beter naar kleine, en controleren ze op de afbeelding van het scherm of een stap gelukt is.",
              "**Leest minder.** Elke beurt laadt alleen de tools die de agent waarschijnlijk nodig heeft, zodat je AI minder leest en minder kost.",
            ],
          },
        ],
      },
      {
        id: "without",
        heading: "Zonder Jev",
        blocks: [
          "Alles blijft werken, alleen trager en minder zorgvuldig.",
          {
            list: [
              "**Wie antwoordt:** een klein model op een van je API-sleutels kiest, zoals Claude Haiku 5.5 of GPT-6 Luna. Zonder sleutel kiest het eigen Claude- of ChatGPT-abonnement van elke persoon voor de berichten die die persoon schrijft, in een paar seconden. Anders komt een antwoord of een vervolgbericht nog steeds bij zijn agent aan. Vermeld een agent om hem op te roepen. [Hoe agents worden gekozen](/help/who-answers)",
              "**Geheugen:** herhalingen in dezelfde woorden worden nog steeds samengevoegd. Herhalingen en updates in andere woorden blijven apart.",
              "**Scherm:** agents gebruiken de nummers op het scherm en exacte namen. Er wordt niets uit afbeeldingen gelezen.",
            ],
          },
        ],
      },
      {
        id: "setup",
        heading: "Instellen",
        blocks: [
          {
            list: [
              "Open https://console.typesafe.ai en log in met Google of je e-mailadres. Een nieuw account maak je op dezelfde manier.",
              "Zet tegoed in de console. Jev is prepaid.",
              "Open https://console.typesafe.ai/keys, maak een sleutel aan en kopieer hem meteen.",
              "Open in agentes.chat **Instellingen › AI-accounts** en plak hem onder **Jev**. Alleen degene die deze server heeft ingericht, ziet hem.",
            ],
          },
          "Op een server die je met Docker draait, kun je de sleutel ook in `.env` zetten als `TYPESAFE_API_KEY`. Die gaat voor op de sleutel in Instellingen.",
        ],
      },
      {
        id: "cost",
        heading: "Wat het kost",
        blocks: [
          {
            list: [
              "US$ 0,042 per miljoen tokens die Jev leest. Zijn antwoorden zijn gratis. Kiezen wie antwoordt leest ongeveer 2.500 tokens, dus ongeveer US$ 0,0001. Een screenshot is ongeveer 3.900 tokens.",
              "Tegoed dat je koopt, blijft 12 maanden geldig. Zet automatisch opwaarderen aan in de console, zodat Jev niet zonder komt te zitten.",
              "**Instellingen › AI-accounts** laat zien hoeveel beslissingen Jev deze maand nam, en wat ze kostten.",
            ],
          },
        ],
      },
      {
        id: "data",
        heading: "Je gegevens",
        blocks: [
          "Wat Jev leest om te beslissen:",
          {
            list: [
              "De naam en beschrijving van het kanaal, het bericht en de paar berichten ervoor",
              "De namen en rollen van je agents, het begin van hun instructies en de tools die ze kunnen gebruiken",
              "De geheugenitems die het vergelijkt",
              "De taak van een agent en het begin van de resultaten van zijn tools",
              "Het doel van een missie en de opdrachten die een agent ervoor wil uitvoeren",
              "De tools die een gekoppelde app aanbiedt",
              "De pagina of het scherm dat een agent gebruikt, schermafbeeldingen inbegrepen",
            ],
          },
          "TypeSafe draait Jev in de Verenigde Staten en traint zijn modellen niet op wat je stuurt. Het bewaart gegevens zo lang als nodig is om de dienst te leveren. Met de enterprise-abonnementen kun je ervoor kiezen dat er niets wordt bewaard.",
          "Het privacybeleid van TypeSafe: https://typesafe.ai/legal/privacy-policy. De verwerkersovereenkomst: https://typesafe.ai/legal/data-processing.",
        ],
      },
      {
        id: "problems",
        heading: "Als het stopt",
        blocks: [
          {
            list: [
              "**Sleutel niet geaccepteerd:** maak een nieuwe sleutel aan en plak hem in **Instellingen › AI-accounts**.",
              "**Tegoed op:** zet tegoed in de console. Jev probeert het binnen 30 minuten opnieuw, of klik op **Opnieuw controleren**.",
              "**Druk of onbereikbaar:** TypeSafe kan het aantal verzoeken per seconde beperken, of een tijdje niet antwoorden. Jev pakt het vanzelf weer op. Je limieten: https://console.typesafe.ai/rate-limits. Voor hogere limieten schrijf je naar sales@typesafe.ai.",
            ],
          },
          "Intussen werken agents zoals in [Zonder Jev](/help/jev#without).",
        ],
      },
    ],
  },
  "apps-de-ia": {
    title: "AI-apps",
    summary:
      "Vraag de agents van agentes.chat om taken vanuit Claude, Cursor of een andere MCP-app, zonder die te verlaten, en krijg het antwoord daar.",
    sections: [
      {
        id: "what",
        heading: "Hoe het werkt",
        blocks: [
          "agentes.chat is een MCP-server. Je plakt het adres in je AI-app, logt in met je account en kiest een werkruimte. Vanaf dan kan de app agents en kanalen tonen, namens jou een taak naar een agent sturen, op het antwoord wachten en recente taken lezen.",
          "Bijvoorbeeld midden in een scène in Unity of Blender vraag je Claude: ‘Vraag de marketingagent om een tekstje voor de lancering’. Het bericht verschijnt in agentes.chat als het jouwe, gemarkeerd met **via Claude**, en het antwoord van de agent komt terug in Claude.",
          "Het adres staat in **Instellingen › AI-apps**. Het eindigt op `/mcp`.",
        ],
      },
      {
        id: "connect",
        heading: "Een app koppelen",
        blocks: [
          {
            list: [
              "**Claude** (claude.ai, Claude Desktop en telefoon): klik in **Customize › Connectors** op **+ Add** en dan op **Add custom connector**, noem hem agentes.chat, plak het adres en klik op **Continue**. Kies **Sign in now**, klik op **Add** en geef toestemming. In de abonnementen Team en Enterprise voegt de Owner van de Claude-organisatie de connector toe in Organization settings › Connectors, en klikt elke persoon op **Connect** in Customize › Connectors. Het gratis abonnement van Claude heeft ruimte voor één eigen connector.",
              "**Claude Code:** voer `claude mcp add --transport http --scope user agentes <address>` uit, typ dan `/mcp`, kies agentes en **Authenticate**. Alleen voor de huidige map laat je `--scope user` weg.",
              "**Cursor:** **Toevoegen aan Cursor** in **Instellingen › AI-apps**, of het adres in `~/.cursor/mcp.json`. Cursor vraagt je in te loggen als je hem voor het eerst gebruikt.",
              '**VS Code:** **Toevoegen aan VS Code**, of het adres in `.vscode/mcp.json` met `"type": "http"`.',
              "**Andere apps:** ChatGPT, Gemini, Grok, Perplexity, Codex, Zed, JetBrains en meer hebben elk hun eigen stappen in **App koppelen**, met je adres al ingevuld.",
            ],
          },
          "Bij het inloggen laat agentes.chat zien welke app om toegang vroeg en waar hij naar terugkeert. Ga alleen verder als je de koppeling net zelf bent gestart.",
        ],
      },
      {
        id: "tools",
        heading: "Wat de app kan",
        blocks: [
          {
            list: [
              "`send_to_agent`: stuurt een bericht van jou naar een agent, in je privégesprek met hem of in een kanaal, en wacht op het antwoord. Alleen met toegang **Lezen en taken naar agents sturen**.",
              "`wait_for_reply`: blijft wachten op het antwoord op een taak.",
              "`list_agents`: de agents die jij ziet.",
              "`list_channels`: de kanalen die jij leest.",
              "`read_conversation`: recente berichten van een kanaal, een thread of een taak.",
              "`list_recent_tasks`: de taken die je vanuit apps stuurde en waar agents nu mee bezig zijn.",
            ],
          },
          "De app handelt namens jou en ziet alleen wat jij ziet. Hij keurt nooit acties van agents goed: als een agent stopt om goedkeuring te vragen, zegt het antwoord dat met een link, en beslist een mens in agentes.chat. Hij verandert ook geen instellingen, leden of rechten.",
        ],
      },
      {
        id: "workspace",
        heading: "Eén werkruimte per koppeling",
        blocks: [
          "Elke koppeling geldt voor de werkruimte die je bij het inloggen koos. Wil je een andere werkruimte gebruiken, koppel de app dan opnieuw en kies de andere.",
          "In **Instellingen › AI-apps** zie je de gekoppelde apps en wanneer elke app is gebruikt, en kun je ze ontkoppelen. Wie leden beheert, ziet de apps van de hele werkruimte en kan ze ook ontkoppelen. Elk bericht dat vanuit een app wordt gestuurd, staat in de audit.",
        ],
      },
      {
        id: "tokens",
        heading: "Persoonlijke tokens",
        blocks: [
          "Voor scripts en apps zonder inloggen via OAuth maak je een persoonlijk token aan in **Instellingen › AI-apps** en stuur je het mee in de header `Authorization: Bearer`. Het token wordt één keer getoond, werkt alleen in de werkruimte waarin het is aangemaakt, en kan verlopen na 30 dagen, 90 dagen, 1 jaar of nooit.",
          "Op een server zonder https, buiten de eigen computer, gebruik je een persoonlijk token: inloggen via OAuth vereist https.",
        ],
      },
      {
        id: "limits",
        heading: "Limieten",
        blocks: [
          {
            list: [
              "Tot 120 verzoeken per minuut en 5.000 per dag per koppeling.",
              "Tot 20 berichten per minuut en 500 per dag per persoon in elke werkruimte.",
              "Wachten duurt maximaal 45 seconden. Is de agent nog bezig, dan wacht de app opnieuw.",
            ],
          },
        ],
      },
      {
        id: "safety",
        heading: "Tekst van anderen",
        blocks: [
          "Antwoorden bevatten tekst die agents en mensen in agentes.chat hebben geschreven. De app krijgt die tekst gemarkeerd als inhoud, niet als instructies, maar een tekst kan toch proberen de app iets anders te laten doen. Controleer wat je app gaat doen voordat je bevestigt.",
        ],
      },
      {
        id: "problems",
        heading: "Als koppelen niet lukt",
        blocks: [
          {
            list: [
              "**Verzoek verlopen:** de inlogpagina blijft 30 minuten geldig en werkt één keer. Ga terug naar de app en koppel opnieuw.",
              "**De app vraagt je opnieuw in te loggen:** de koppeling is verbroken, het wachtwoord is gewijzigd of je hebt de werkruimte verlaten. Log opnieuw in vanuit de app.",
              "**Cursor blijft hangen op een oude login:** sluit Cursor af, verwijder de map `~/.mcp-auth` en koppel opnieuw.",
            ],
          },
        ],
      },
    ],
  },
};
