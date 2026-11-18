import { type AppLocale, appLocale } from "@agenteschat/i18n/locale";

/**
 * The words of the runner's own pages (the agent's start page, a crashed tab's notice, macOS's password window for
 * Xcode). The runner carries them itself rather than the app's catalog, which it doesn't bundle.
 */

/** Any language tag (an app code, a Mac's `de-DE`) → one of the app's languages, English when none matches. */
export const pageLocale = (tag?: string | null): AppLocale => appLocale([tag], true) ?? "en";

export interface StartWords {
  title: string;
  eyebrow: string;
  exitIp: string;
  hint: string;
  tip: string;
}

export const START_WORDS: Record<AppLocale, StartWords> = {
  en: {
    title: "New Tab",
    eyebrow: "AGENT'S COMPUTER",
    exitIp: "Exit IP",
    hint: "The address sites see",
    tip: "Type an address in the bar above",
  },
  "pt-BR": {
    title: "Nova guia",
    eyebrow: "COMPUTADOR DO AGENTE",
    exitIp: "IP de saída",
    hint: "É o endereço que os sites veem",
    tip: "Digite um endereço na barra acima",
  },
  es: {
    title: "Nueva pestaña",
    eyebrow: "COMPUTADORA DEL AGENTE",
    exitIp: "IP de salida",
    hint: "La dirección que ven los sitios",
    tip: "Escribe una dirección en la barra de arriba",
  },
  fr: {
    title: "Nouvel onglet",
    eyebrow: "ORDINATEUR DE L'AGENT",
    exitIp: "IP de sortie",
    hint: "L'adresse que voient les sites",
    tip: "Saisissez une adresse dans la barre ci-dessus",
  },
  de: {
    title: "Neuer Tab",
    eyebrow: "COMPUTER DES AGENTEN",
    exitIp: "Ausgangs-IP",
    hint: "Die Adresse, die Websites sehen",
    tip: "Gib oben in der Leiste eine Adresse ein",
  },
  it: {
    title: "Nuova scheda",
    eyebrow: "COMPUTER DELL'AGENTE",
    exitIp: "IP di uscita",
    hint: "L'indirizzo che vedono i siti",
    tip: "Scrivi un indirizzo nella barra in alto",
  },
  nl: {
    title: "Nieuw tabblad",
    eyebrow: "COMPUTER VAN DE AGENT",
    exitIp: "Uitgaand IP",
    hint: "Het adres dat websites zien",
    tip: "Typ een adres in de balk hierboven",
  },
  ja: {
    title: "新しいタブ",
    eyebrow: "エージェントのコンピューター",
    exitIp: "出口IP",
    hint: "サイトから見えるアドレスです",
    tip: "上のバーにアドレスを入力してください",
  },
  ko: {
    title: "새 탭",
    eyebrow: "에이전트의 컴퓨터",
    exitIp: "출구 IP",
    hint: "사이트에 보이는 주소예요",
    tip: "위쪽 주소창에 주소를 입력하세요",
  },
  "zh-Hans": {
    title: "新标签页",
    eyebrow: "智能体的电脑",
    exitIp: "出口 IP",
    hint: "网站看到的地址",
    tip: "在上方的地址栏中输入网址",
  },
  id: {
    title: "Tab Baru",
    eyebrow: "KOMPUTER AGEN",
    exitIp: "IP keluar",
    hint: "Alamat yang dilihat situs",
    tip: "Ketik alamat di bilah atas",
  },
  tr: {
    title: "Yeni Sekme",
    eyebrow: "AJANIN BİLGİSAYARI",
    exitIp: "Çıkış IP’si",
    hint: "Sitelerin gördüğü adres",
    tip: "Yukarıdaki çubuğa bir adres yazın",
  },
  pl: {
    title: "Nowa karta",
    eyebrow: "KOMPUTER AGENTA",
    exitIp: "IP wyjściowe",
    hint: "Adres, który widzą strony",
    tip: "Wpisz adres w pasku powyżej",
  },
  ru: {
    title: "Новая вкладка",
    eyebrow: "КОМПЬЮТЕР АГЕНТА",
    exitIp: "Внешний IP",
    hint: "Адрес, который видят сайты",
    tip: "Введите адрес в строке выше",
  },
};

export interface CrashWords {
  stopped: string;
  memory: string;
  told: string;
}

export const CRASH_WORDS: Record<AppLocale, CrashWords> = {
  en: { stopped: "The page stopped working", memory: "The page ran out of memory", told: "The agent will be told." },
  "pt-BR": {
    stopped: "A página parou de funcionar",
    memory: "A página ficou sem memória",
    told: "O agente será avisado.",
  },
  es: {
    stopped: "La página dejó de funcionar",
    memory: "La página se quedó sin memoria",
    told: "Se avisará al agente.",
  },
  fr: {
    stopped: "La page a cessé de fonctionner",
    memory: "La page a manqué de mémoire",
    told: "L'agent sera prévenu.",
  },
  de: {
    stopped: "Die Seite funktioniert nicht mehr",
    memory: "Der Seite ist der Speicher ausgegangen",
    told: "Der Agent wird benachrichtigt.",
  },
  it: {
    stopped: "La pagina ha smesso di funzionare",
    memory: "La pagina ha esaurito la memoria",
    told: "L'agente verrà avvisato.",
  },
  nl: {
    stopped: "De pagina werkt niet meer",
    memory: "De pagina heeft geen geheugen meer",
    told: "De agent krijgt het te horen.",
  },
  ja: {
    stopped: "ページが動作しなくなりました",
    memory: "ページのメモリが不足しました",
    told: "エージェントに伝えます。",
  },
  ko: {
    stopped: "페이지가 작동을 멈췄어요",
    memory: "페이지의 메모리가 부족해요",
    told: "에이전트에게 알려 줄게요.",
  },
  "zh-Hans": {
    stopped: "页面已停止运行",
    memory: "页面内存不足",
    told: "会告知智能体。",
  },
  id: {
    stopped: "Halaman berhenti berfungsi",
    memory: "Halaman kehabisan memori",
    told: "Agen akan diberi tahu.",
  },
  tr: {
    stopped: "Sayfa çalışmayı durdurdu",
    memory: "Sayfanın belleği tükendi",
    told: "Ajana haber verilecek.",
  },
  pl: {
    stopped: "Strona przestała działać",
    memory: "Stronie zabrakło pamięci",
    told: "Agent zostanie powiadomiony.",
  },
  ru: {
    stopped: "Страница перестала работать",
    memory: "Странице не хватило памяти",
    told: "Агенту сообщат.",
  },
};

/** The line macOS's password window shows when the Mac sets up Xcode for an iPhone. */
export const XCODE_PROMPT: Record<AppLocale, string> = {
  en: "agentes.chat wants to put Xcode in use to connect iPhones.",
  "pt-BR": "O agentes.chat quer colocar o Xcode em uso para conectar iPhones.",
  es: "agentes.chat quiere usar Xcode para conectar iPhones.",
  fr: "agentes.chat veut utiliser Xcode pour connecter des iPhone.",
  de: "agentes.chat möchte Xcode verwenden, um iPhones zu verbinden.",
  it: "agentes.chat vuole usare Xcode per collegare gli iPhone.",
  nl: "agentes.chat wil Xcode gebruiken om iPhones te verbinden.",
  ja: "agentes.chat が iPhone を接続するために Xcode を使おうとしています。",
  ko: "agentes.chat에서 iPhone을 연결하기 위해 Xcode를 사용하려고 해요.",
  "zh-Hans": "agentes.chat 想要使用 Xcode 来连接 iPhone。",
  id: "agentes.chat ingin memakai Xcode untuk menghubungkan iPhone.",
  tr: "agentes.chat, iPhone'ları bağlamak için Xcode'u kullanmak istiyor.",
  pl: "agentes.chat chce użyć Xcode, aby połączyć iPhone'y.",
  ru: "agentes.chat хочет использовать Xcode, чтобы подключать iPhone.",
};
