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
} satisfies Record<string, IconShape[]>;
