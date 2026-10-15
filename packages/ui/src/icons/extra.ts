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
} satisfies Record<string, IconShape[]>;
