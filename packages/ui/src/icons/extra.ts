import type { IconShape } from "./types";

/**
 * Icons drawn in the approved screens (docs/design/telas) that don't have a
 * file in docs/design/icons yet. Same grid (20px), stroke (1.6) and rules.
 * Move them to docs/design/icons when the design files are added.
 */
export const extraIcons = {
  /** Sidebar.dc.html: Issues (closed shape keeps the cut corner). */
  issues: [
    ["path", { d: "M7 3h6a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H3V7a4 4 0 0 1 4-4z" }],
    ["path", { d: "M7 8h6M7 12h4" }],
  ],
  /** Sidebar.dc.html: Drive. */
  drive: [["path", { d: "M3 6.5A2.5 2.5 0 0 1 5.5 4H8l2 2h4.5A2.5 2.5 0 0 1 17 8.5v5a2.5 2.5 0 0 1-2.5 2.5H3z" }]],
  /** Sidebar.dc.html: Membros. */
  members: [
    ["circle", { cx: "8", cy: "7", r: "2.8" }],
    ["path", { d: "M3 16c.6-2.6 2.5-4 5-4s4.4 1.4 5 4M13.5 4.5a2.6 2.6 0 0 1 0 5M15 12.3c1.1.6 1.8 1.9 2 3.7" }],
  ],
  /** Sidebar.dc.html: Criar agente. */
  plus: [["path", { d: "M10 4.5v11M4.5 10h11" }]],
  /** Onboarding / Agente dialogs: remove, close. */
  close: [["path", { d: "m6 6 8 8M14 6l-8 8" }]],
  /** Select.dc.html: trigger chevron. */
  chevronDown: [["path", { d: "m6 8 4 4 4-4" }]],
  /** Main.dc.html: approved chip; Select.dc.html: selected option. */
  check: [["path", { d: "m5.5 10.5 3 3 6-7" }]],
  /** Entrar.dc.html: error alert. */
  alert: [
    ["circle", { cx: "10", cy: "10", r: "7" }],
    ["path", { d: "M10 6.5v4M10 13.5v.01" }],
  ],
  /** Main.dc.html: pull request attachment. */
  pullRequest: [["path", { d: "M6 3v14M14 9v8M6 7a3 3 0 0 0 3 3h2a3 3 0 0 1 3 3" }]],
  /** Organization settings (sliders). Not in the screens yet; drawn on the same grid. */
  settings: [
    ["path", { d: "M3.5 6h7M15.5 6h1M3.5 14h1M9.5 14h7" }],
    ["circle", { cx: "13", cy: "6", r: "2" }],
    ["circle", { cx: "7", cy: "14", r: "2" }],
  ],
  /** Memoria.dc.html: fact. */
  info: [
    ["circle", { cx: "10", cy: "10", r: "7" }],
    ["path", { d: "M10 9v4.5M10 6.5v.01" }],
  ],
  /** Memoria.dc.html: preference. */
  preference: [
    ["circle", { cx: "8", cy: "7", r: "2.8" }],
    ["path", { d: "M3 16c.6-2.6 2.5-4 5-4s4.4 1.4 5 4" }],
  ],
  /** Memoria.dc.html: "Sempre no contexto". */
  pin: [["path", { d: "M7 3h6l-1 5 3 3H5l3-3zM10 11v6" }]],
  /** Memoria.dc.html, Propostas.dc.html: back link. */
  chevronLeft: [["path", { d: "M12 5 7 10l5 5" }]],
  /** Receipts: an agent answered (two checks, same stroke as `check`). */
  checks: [["path", { d: "m2.5 10.5 3 3 6-7M9 13l.5.5 6-7" }]],
  /** Feedback on an agent reply: helpful. Not in the screens yet; drawn on the same grid. */
  thumbUp: [["path", { d: "M7 9v8H4V9zM7 9l3-6a2 2 0 0 1 2 2v3h4a1.6 1.6 0 0 1 1.6 1.9l-1.2 6A2 2 0 0 1 14.4 17H7" }]],
  /** Feedback on an agent reply: not helpful. */
  thumbDown: [
    ["path", { d: "M7 11V3H4v8zM7 11l3 6a2 2 0 0 0 2-2v-3h4a1.6 1.6 0 0 0 1.6-1.9l-1.2-6A2 2 0 0 0 14.4 3H7" }],
  ],
  /** "Corrigir resposta". */
  edit: [["path", { d: "M4 16l1-4 8-8 3 3-8 8zM12 5l3 3" }]],
  /** Artifacts (from the prototype's Drive icons, redrawn on the 20px grid): document. */
  document: [["path", { d: "M6 3h6l3.5 3.5V17H6zM12 3v3.5h3.5M8.5 10h4M8.5 12.5h4M8.5 15h2.5" }]],
  /** Artifacts: table. */
  table: [
    ["rect", { x: "3.5", y: "4.5", width: "13", height: "11", rx: "1.5" }],
    ["path", { d: "M3.5 8.5h13M3.5 12h13M8 4.5v11" }],
  ],
  /** Artifacts: code change (diff). */
  code: [["path", { d: "M7.5 6.5 4 10l3.5 3.5M12.5 6.5 16 10l-3.5 3.5" }]],
  /** Artifacts: diagram. */
  diagram: [
    ["rect", { x: "7.5", y: "2.5", width: "5", height: "3.5", rx: "1" }],
    ["rect", { x: "2.5", y: "13.5", width: "5", height: "3.5", rx: "1" }],
    ["rect", { x: "12.5", y: "13.5", width: "5", height: "3.5", rx: "1" }],
    ["path", { d: "M10 6v3M5 13.5V11h10v2.5" }],
  ],
  /** Artifacts: HTML page. */
  page: [
    ["rect", { x: "3", y: "4", width: "14", height: "12", rx: "2" }],
    ["path", { d: "M3 7.5h14" }],
  ],
  /** Sidebar.dc.html: Rotinas (clock with a refresh arrow). */
  routines: [
    ["path", { d: "M16 10a6 6 0 1 1-1.8-4.3" }],
    ["path", { d: "M16 4v3h-3" }],
    ["path", { d: "M10 7v3l2 1.5" }],
  ],
  /** Sidebar.dc.html: Calendário. */
  calendar: [
    ["path", { d: "M6 3.5h8a3 3 0 0 1 3 3V14a3 3 0 0 1-3 3H3V6.5a3 3 0 0 1 3-3z" }],
    ["path", { d: "M3 8h14M7 2v3M13 2v3" }],
  ],
  /** Rotinas.dc.html: event trigger. */
  bolt: [["path", { d: "M11 3 5 11h5l-1 6 6-8h-5z" }]],
  /** Issues.dc.html: high priority. */
  arrowUp: [["path", { d: "M10 15V5M5.5 9.5 10 5l4.5 4.5" }]],
  /** Calendario.dc.html: next week. */
  chevronRight: [["path", { d: "m8 5 5 5-5 5" }]],
  /** "…" menu (more actions). */
  more: [
    ["circle", { cx: "5", cy: "10", r: "1.1" }],
    ["circle", { cx: "10", cy: "10", r: "1.1" }],
    ["circle", { cx: "15", cy: "10", r: "1.1" }],
  ],
  /** Access matrix: off (not granted). */
  dash: [["path", { d: "M6 10h8" }]],
  /** "Bloquear" (deny a tool). */
  block: [
    ["circle", { cx: "10", cy: "10", r: "6.5" }],
    ["path", { d: "m5.5 14.5 9-9" }],
  ],
  /** "Baixar". */
  download: [["path", { d: "M10 3.5v9M6 9l4 4 4-4M4.5 16.5h11" }]],
  /** "Copiar link". */
  link: [
    [
      "path",
      {
        d: "M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8A3 3 0 0 0 9.2 15l1-1",
      },
    ],
  ],
  /** "Parar" (stop an agent's run). */
  stop: [["rect", { x: "5.5", y: "5.5", width: "9", height: "9", rx: "2" }]],
  /** "Wiki" (the org's knowledge base). */
  book: [
    [
      "path",
      { d: "M4 4.5h4.5A2.5 2.5 0 0 1 10 6v10a2 2 0 0 0-2-2H4zM16 4.5h-4.5A2.5 2.5 0 0 0 10 6v10a2 2 0 0 1 2-2h4z" },
    ],
  ],
  /** "Lembrete" (a reminder routine). */
  bell: [["path", { d: "M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.2 1.5H4.3zM8.5 17h3" }]],
  /** Something is in progress (spins unless reduced motion). */
  spinner: [["path", { d: "M10 3.5a6.5 6.5 0 1 1-6.5 6.5" }]],
  /** "Quem pode falar": restricted agent. */
  lock: [
    ["rect", { x: "4.5", y: "9", width: "11", height: "8", rx: "2" }],
    ["path", { d: "M7 9V6.5a3 3 0 0 1 6 0V9" }],
  ],
  /** "Duplicar", "Copiar". */
  copy: [
    ["rect", { x: "7", y: "7", width: "9.5", height: "9.5", rx: "2" }],
    ["path", { d: "M13 7V5.5a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2V11a2 2 0 0 0 2 2H7" }],
  ],
  /** "Apagar". */
  trash: [
    [
      "path",
      { d: "M4 6h12M8 6V4.5h4V6M5.5 6l.8 9.5a1.5 1.5 0 0 0 1.5 1.5h4.4a1.5 1.5 0 0 0 1.5-1.5L14.5 6M8.5 9v5M11.5 9v5" },
    ],
  ],
  /** A recurring event or routine. */
  repeat: [
    [
      "path",
      { d: "M4 9.5V8a3 3 0 0 1 3-3h8.5M13 2.5 15.5 5 13 7.5M16 10.5V12a3 3 0 0 1-3 3H4.5M7 17.5 4.5 15 7 12.5" },
    ],
  ],
  /** "Filtros". */
  filter: [["path", { d: "M3.5 5h13M6 10h8M8.5 15h3" }]],
  /** Opens the workspace navigation on narrow screens (the last line is shorter). */
  menu: [["path", { d: "M3.5 5.5h13M3.5 10h13M3.5 14.5h8" }]],
  /** Side panel toggle. */
  sidebar: [
    ["rect", { x: "3", y: "4", width: "14", height: "12", rx: "2.5" }],
    ["path", { d: "M12.5 4v12" }],
  ],
  /** "Ativa", "Rodar agora". */
  play: [["path", { d: "M7 4.8v10.4a.6.6 0 0 0 .9.5l8-5.2a.6.6 0 0 0 0-1L7.9 4.3a.6.6 0 0 0-.9.5z" }]],
  /** "Pausada". */
  pause: [
    ["rect", { x: "5.5", y: "4.5", width: "3", height: "11", rx: "1" }],
    ["rect", { x: "11.5", y: "4.5", width: "3", height: "11", rx: "1" }],
  ],
  /** An uploaded file of any type (Drive). */
  file: [["path", { d: "M6 3h6l3.5 3.5V17H6zM12 3v3.5h3.5" }]],
  /** An image file. */
  image: [
    ["rect", { x: "3.5", y: "4.5", width: "13", height: "11", rx: "2" }],
    ["circle", { cx: "8", cy: "8.5", r: "1.3" }],
    ["path", { d: "m4 14 4-3.5 3 2.5 2.5-2 3 2.5" }],
  ],
  /** A zip or other archive. */
  archive: [
    ["path", { d: "M6 3h6l3.5 3.5V17H6zM12 3v3.5h3.5" }],
    ["path", { d: "M9 5v1.5M9 8v1.5M8 11.5h2V14H8z" }],
  ],
  /** "Enviar arquivo". */
  upload: [["path", { d: "M10 13V4M6 7.5 10 3.5l4 4M4.5 16.5h11" }]],
  /** A connected computer. */
  computer: [
    ["rect", { x: "3", y: "4", width: "14", height: "9.5", rx: "2" }],
    ["path", { d: "M7.5 16.5h5M10 13.5v3" }],
  ],
  /** The cloud computer. */
  cloud: [["path", { d: "M6 15.5a3.5 3.5 0 0 1-.4-7 4.5 4.5 0 0 1 8.7-.9A3.5 3.5 0 0 1 14 15.5z" }]],
  /** "Reagir" and the composer's emoji button (our face, never an emoji glyph). */
  smile: [
    ["circle", { cx: "10", cy: "10", r: "7" }],
    ["path", { d: "M7.2 11.8c.7.9 1.7 1.4 2.8 1.4s2.1-.5 2.8-1.4M7.6 8.2v.01M12.4 8.2v.01" }],
  ],
  /** "Responder" (quote reply). */
  reply: [["path", { d: "M8 5 4 9l4 4M4 9h7a5 5 0 0 1 5 5v1.5" }]],
  /** Composer formatting: bold. */
  bold: [["path", { d: "M6 4h4.8a3 3 0 0 1 0 6H6zM6 10h5.6a3 3 0 0 1 0 6H6z" }]],
  /** Composer formatting: italic. */
  italic: [["path", { d: "M9 4h6M5 16h6M12 4 8 16" }]],
  /** Composer formatting: strikethrough. */
  strike: [
    [
      "path",
      {
        d: "M4 10h12M13.4 6.3C12.9 5 11.6 4 9.9 4 8 4 6.6 5.1 6.6 6.7c0 .7.3 1.3.9 1.8M6.6 13.5c.5 1.5 1.8 2.5 3.6 2.5 2 0 3.4-1.1 3.4-2.7 0-.5-.1-.9-.4-1.3",
      },
    ],
  ],
  /** Composer formatting: code block. */
  codeBlock: [
    ["rect", { x: "3", y: "4", width: "14", height: "12", rx: "3" }],
    ["path", { d: "M8.2 8.2 6.4 10l1.8 1.8M11.8 8.2l1.8 1.8-1.8 1.8" }],
  ],
  /** Composer formatting: bulleted list. */
  bulletList: [["path", { d: "M8.5 6H16M8.5 10H16M8.5 14H16M4.5 6v.01M4.5 10v.01M4.5 14v.01" }]],
  /** Composer formatting: numbered list. */
  numberedList: [
    [
      "path",
      { d: "M9 6h7M9 10h7M9 14h7M4 4.8l1-.6v3.6M3.8 12.2c.2-.4.6-.7 1.1-.7.6 0 1 .4 1 .9 0 .8-2.1 1.3-2.1 2.4h2.1" },
    ],
  ],
  /** Composer formatting: quote. */
  quote: [["path", { d: "M4.5 4.5v11M8.5 6.5H16M8.5 10H16M8.5 13.5h5" }]],
  /** NovoAgente.html: the model key. */
  key: [
    ["circle", { cx: "7", cy: "12.5", r: "3.2" }],
    ["path", { d: "m9.3 10.2 7-7M14 5.5l2.3 2.3M12.3 7.2l1.7 1.7" }],
  ],
  /** NovoAgente.html: the monthly budget. */
  wallet: [
    ["path", { d: "M3.5 6.5a2 2 0 0 1 2-2H15v3" }],
    ["rect", { x: "3.5", y: "7.5", width: "13", height: "9", rx: "2" }],
    ["path", { d: "M13.5 12h.01" }],
  ],
  /** NovoAgente.html: "Sortear" (a random look). */
  shuffle: [
    ["rect", { x: "3.5", y: "3.5", width: "13", height: "13", rx: "3.5" }],
    ["path", { d: "M7.5 7.5h.01M12.5 12.5h.01M12.5 7.5h.01M7.5 12.5h.01" }],
  ],
  /** NovoAgente.html: sensitive actions always ask for approval. */
  shield: [["path", { d: "M10 3 4 5.5v4.5c0 3.6 2.6 6.4 6 7 3.4-.6 6-3.4 6-7V5.5z" }]],
  /** NovoAgente.html: "Conectar outro app". */
  plug: [["path", { d: "M7.5 3v4M12.5 3v4M5 7h10v2.5a5 5 0 0 1-10 0zM10 14.5V17" }]],
  /** NovoAgente.html: "Voltar ao original". */
  undo: [["path", { d: "M7.5 11.5 3.5 7.5l4-4M3.5 7.5h8a5 5 0 0 1 0 10H9" }]],
  /** NovoAgente.html: go somewhere (a channel). */
  arrowRight: [["path", { d: "M4 10h12M11 5l5 5-5 5" }]],
  /** Drive.html: grid view. */
  grid: [
    ["rect", { x: "3.5", y: "3.5", width: "5.5", height: "5.5", rx: "1.6" }],
    ["rect", { x: "11", y: "3.5", width: "5.5", height: "5.5", rx: "1.6" }],
    ["rect", { x: "3.5", y: "11", width: "5.5", height: "5.5", rx: "1.6" }],
    ["rect", { x: "11", y: "11", width: "5.5", height: "5.5", rx: "1.6" }],
  ],
  /** Drive.html: list view. */
  list: [["path", { d: "M7.5 5h9M7.5 10h9M7.5 15h9M3.8 5h.01M3.8 10h.01M3.8 15h.01" }]],
  /** Drive.html: group and sort ("Organizar"). */
  layers: [
    ["path", { d: "m10 2.8 7 3.9-7 3.9-7-3.9z" }],
    ["path", { d: "m3 10.6 7 3.9 7-3.9" }],
  ],
  /** Drive.html: time left in the trash, group by date. */
  clock: [
    ["circle", { cx: "10", cy: "10", r: "7" }],
    ["path", { d: "M10 6.5V10l2.5 1.7" }],
  ],
  /** Drive.html: open (in the viewer). */
  external: [
    ["path", { d: "M11.5 3.5h5v5M16.5 3.5 9.5 10.5M15 11.5v4a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" }],
  ],
} satisfies Record<string, IconShape[]>;
