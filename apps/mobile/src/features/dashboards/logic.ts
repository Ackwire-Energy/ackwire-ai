import type {
  AppNotification,
  Dashboard,
  DashboardAudience,
  DashboardEditPolicy,
  DashboardList,
  DashboardSummary,
  Member,
  NotificationKind,
  OrgRole,
  ShareDashboardInput,
  WidgetFormat,
  WidgetKind,
  WidgetSpec,
} from "@agenteschat/client";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { chartAreaTones, chartInk } from "@agenteschat/ui/sky/chart";
import { bayerAt } from "@agenteschat/ui/sky/math";
import {
  defaultSize,
  exampleWidgetSpec,
  type ExampleWords,
  phoneSpan,
  sizeToLayout,
  WIDGET_LIMITS,
  type WidgetSize,
} from "@agenteschat/ui/widgets/spec";

/**
 * Dashboards and widgets on the phone (ADR 0134), without React: the agent's tones and the dither the widgets are
 * drawn with, the 2-column board, the thumbnails, the New widget preview, Share's draft, and the notices.
 */

// ── Notices ──────────────────────────────────────────────────────────────────

/** The inbox kinds dashboards produce: a widget's alert, a widget that stopped updating, an agent asking to publish. */
export const DASHBOARD_NOTICES = ["widget_alert", "widget_failed", "dashboard_proposal"] as const;
export type DashboardNotice = (typeof DASHBOARD_NOTICES)[number];

export const isDashboardNotice = (kind: NotificationKind | string): kind is DashboardNotice =>
  (DASHBOARD_NOTICES as readonly string[]).includes(kind);

/**
 * A dashboard notice waiting on you, as Activity's card says it: the kind's word ("Alert", "Dashboard"), the line
 * (the alert in the agent's words; for a proposal, the board and who it would show to) and the one button ("Open").
 * Null for any other notice. `say(key, values)` reads the words.
 */
export function dashboardWaitingCard(
  n: Pick<AppNotification, "kind" | "source" | "latest">,
  say: (key: string, values?: Record<string, unknown>) => string,
): { kind: string; title: string } | null {
  if (!isDashboardNotice(n.kind)) return null;
  const title = n.source.label ?? "";
  if (n.kind === "dashboard_proposal") {
    const roles = n.latest.names ?? [];
    const line =
      n.latest.statusTo === "roles" && roles.length > 0
        ? say("widgets.notice.proposalRoles", { title, roles: roles.join(", ") })
        : say("widgets.notice.proposalWorkspace", { title });
    return { kind: say("mobile.dashboards.notice.card.proposal"), title: line };
  }
  if (n.kind === "widget_failed")
    return { kind: say("mobile.dashboards.notice.card.failed"), title: n.latest.text || title };
  return { kind: say("mobile.dashboards.notice.card.alert"), title: n.latest.text || title };
}

// ── Tones and dither ─────────────────────────────────────────────────────────

/**
 * A widget's two tones from its agent's color, the same as the web's widgets and the chat's charts: the clean stroke
 * in the deep tone (its light one on a dark page) and the dither fill in the area's near tone.
 */
export function widgetTones(color: string, dark: boolean): { stroke: string; fill: string } {
  const c = color as AgentColorName;
  return { stroke: chartInk(c, dark), fill: chartAreaTones(c, dark)[0] };
}

/** Points per dither cell in a widget's fill (the 2px Bayer tile). */
export const WIDGET_CELL = 2;

/** A `cols` × `rows` field of dither cells: 1 where the 4×4 Bayer threshold is under `density`, else 0. */
export function ditherCells(cols: number, rows: number, density: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, cols * rows));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (bayerAt(x, y) < density) out[y * cols + x] = 1;
    }
  }
  return out;
}

const n2 = (v: number) => Number(v.toFixed(2));

/**
 * A rectangle with its top corners rounded, as SVG path data: a bar. Closed, it is the bar's clip; open (no bottom
 * edge), its outline sitting on the axis.
 */
export function topRoundedPath(x: number, y: number, w: number, h: number, r: number, closed = true): string {
  const k = Math.max(0, Math.min(r, w / 2, h));
  const d = [
    `M${n2(x)} ${n2(y + h)}`,
    `V${n2(y + k)}`,
    `Q${n2(x)} ${n2(y)} ${n2(x + k)} ${n2(y)}`,
    `H${n2(x + w - k)}`,
    `Q${n2(x + w)} ${n2(y)} ${n2(x + w)} ${n2(y + k)}`,
    `V${n2(y + h)}`,
  ].join("");
  return closed ? `${d}Z` : d;
}

/** A rectangle with every corner rounded, as SVG path data (a goal's fill, a thumbnail's tile). */
export function roundRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  return [
    `M${n2(x + k)} ${n2(y)}`,
    `H${n2(x + w - k)}`,
    `Q${n2(x + w)} ${n2(y)} ${n2(x + w)} ${n2(y + k)}`,
    `V${n2(y + h - k)}`,
    `Q${n2(x + w)} ${n2(y + h)} ${n2(x + w - k)} ${n2(y + h)}`,
    `H${n2(x + k)}`,
    `Q${n2(x)} ${n2(y + h)} ${n2(x)} ${n2(y + h - k)}`,
    `V${n2(y + k)}`,
    `Q${n2(x)} ${n2(y)} ${n2(x + k)} ${n2(y)}`,
    "Z",
  ].join("");
}

// ── The board on the phone ───────────────────────────────────────────────────

/**
 * The 2-column board: in order, a 2-wide widget takes a row of its own; 1-wide ones pair up, and one left alone
 * (its next is 2-wide, or it is the last) takes half a row. Heights follow the content.
 */
export function phoneRows<T extends { w: number }>(items: readonly T[]): T[][] {
  const rows: T[][] = [];
  let open: T[] | null = null;
  for (const item of items) {
    if (phoneSpan(item.w) === 2) {
      open = null;
      rows.push([item]);
    } else if (open && open.length === 1) {
      open.push(item);
      open = null;
    } else {
      open = [item];
      rows.push(open);
    }
  }
  return rows;
}

/** The widgets of a board in their order. */
export const widgetsInOrder = <T extends { layout: { position: number } }>(widgets: readonly T[]): T[] =>
  [...widgets].sort((a, b) => a.layout.position - b.layout.position);

/**
 * A board's thumbnail: its first widgets as small tiles on a 2-column grid (`w` 2 takes the row), rows `rowH` tall,
 * in a `width` × `height` box with `pad` around and `gap` between. Tiles past the box are left out.
 */
export function thumbRects<T extends { agentId: string; w: number }>(
  thumbs: readonly T[],
  width: number,
  height: number,
  { pad = 5, gap = 3, rowH = 12 }: { pad?: number; gap?: number; rowH?: number } = {},
): { x: number; y: number; w: number; h: number; agentId: string }[] {
  const col = (width - pad * 2 - gap) / 2;
  const out: { x: number; y: number; w: number; h: number; agentId: string }[] = [];
  let row = 0;
  let at = 0;
  for (const t of thumbs) {
    const span = phoneSpan(t.w);
    if (at + span > 2) {
      row += 1;
      at = 0;
    }
    const y = pad + row * (rowH + gap);
    if (y >= height - pad) break;
    out.push({
      x: pad + at * (col + gap),
      y,
      w: span === 2 ? col * 2 + gap : col,
      h: Math.min(rowH, height - pad - y),
      agentId: t.agentId,
    });
    at += span;
  }
  return out;
}

/** A widget's number as people read it: "18,420", "4.5", "0.25" in English (more decimals the smaller it is). */
export function formatWidgetNumber(value: number, locale: string): string {
  const abs = Math.abs(value);
  const digits = abs < 10 ? 2 : abs < 1000 ? 1 : 0;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}

/** A value with its unit, as a chat chart writes it ("$9,200", "42%", "6 min"). */
export function formatWithUnit(value: number, unit: string | undefined, locale: string): string {
  const n = formatWidgetNumber(value, locale);
  if (!unit) return n;
  if (unit === "%") return `${n}%`;
  return ["R$", "US$", "$", "€", "£"].includes(unit) ? `${unit} ${n}` : `${n} ${unit}`;
}

/**
 * Which bars keep their words in a box `width` wide: every label while each bar has room for one (`minWidth`
 * points), else every n-th (the last always). The values over the bars show only with room.
 */
export function barWords(count: number, width: number, minWidth = 26): { every: number; values: boolean } {
  if (count <= 0 || width <= 0) return { every: 1, values: false };
  const per = width / count;
  return { every: per >= minWidth ? 1 : Math.ceil(minWidth / per), values: per >= 22 };
}

/** A goal's fill: 0 to 1. */
export const goalShare = (pct: number) => Math.max(0, Math.min(1, pct / 100));

// ── Organize ─────────────────────────────────────────────────────────────────

/**
 * Organize on the phone: a widget moved one place up (`-1`) or down (`1`) among the board's widgets. A home board's
 * tiles stay where they are (the phone doesn't show them): the widget trades places with the widget next to it.
 */
export function moveWidgetItem<T extends { id: string; type: "widget" | "tile" }>(
  items: readonly T[],
  id: string,
  step: -1 | 1,
): T[] {
  const slots = items.flatMap((item, i) => (item.type === "widget" ? [i] : []));
  const at = slots.findIndex((i) => items[i]?.id === id);
  const from = slots[at];
  const to = slots[at + step];
  if (at < 0 || from === undefined || to === undefined) return [...items];
  const next = [...items];
  const a = next[from];
  const b = next[to];
  if (!a || !b) return next;
  next[from] = b;
  next[to] = a;
  return next;
}

/** Where a widget stands among the board's widgets (1-based), and how many there are: "2 of 5". */
export function widgetPlace(items: readonly { id: string; type: "widget" | "tile" }[], id: string) {
  const widgets = items.filter((item) => item.type === "widget");
  return { at: widgets.findIndex((item) => item.id === id) + 1, count: widgets.length };
}

/** Whether Organize changed anything: the order, or a size. */
export function layoutChanged(
  before: readonly { id: string; w: number; h: number }[],
  after: readonly { id: string; w: number; h: number }[],
): boolean {
  const key = (items: readonly { id: string; w: number; h: number }[]) =>
    items.map((item) => `${item.id}:${item.w}x${item.h}`).join(",");
  return key(before) !== key(after);
}

/** A tall (2-high, L) widget on the phone draws its data big, and stands taller. */
export const isTall = (h: number) => h >= 2;

/** What a board's "…" offers, by what the viewer may do (ADR 0134): My Home is only organized. */
export type BoardMenuKey = "organize" | "share" | "edit" | "pin" | "unpin" | "delete";

export function boardMenuKeys(
  board: Pick<DashboardSummary, "kind" | "canEdit" | "canManage" | "audience" | "pinned">,
): BoardMenuKey[] {
  const keys: BoardMenuKey[] = [];
  if (board.canEdit) keys.push("organize");
  if (board.kind === "home") return keys;
  if (board.canManage) keys.push("share");
  if (board.canEdit) keys.push("edit");
  // Only a workspace board is featured at the top of everyone's list.
  if (board.canManage && board.audience === "workspace") keys.push(board.pinned ? "unpin" : "pin");
  if (board.canManage) keys.push("delete");
  return keys;
}

// ── New widget ───────────────────────────────────────────────────────────────

/** The example words of a preview, in the reader's language (`widgets.example.*`). */
export function exampleWordsOf(say: (key: string) => string): ExampleWords {
  return {
    days: [1, 2, 3, 4, 5, 6, 7].map((i) => say(`widgets.example.days.d${i}`)),
    vsYesterday: say("widgets.example.vsYesterday"),
    goalLine: say("widgets.example.goalLine"),
    goalNote: say("widgets.example.goalNote"),
    lineNote: say("widgets.example.lineNote"),
    rows: [say("widgets.example.row1"), say("widgets.example.row2"), say("widgets.example.row3")],
    rowMeta: [say("widgets.example.meta1"), say("widgets.example.meta2"), say("widgets.example.meta3")],
    items: [say("widgets.example.item1"), say("widgets.example.item2")],
  };
}

/** The kind a preview shows: the format asked for, or with `auto` the suggestion's kind (a number without one). */
export const previewKind = (format: WidgetFormat, suggested: WidgetKind | null): WidgetKind =>
  format === "auto" ? (suggested ?? "kpi") : format;

/** The title a new widget starts with: the ask's first line, capitalized and cut short. */
export function draftTitle(text: string, max = 60): string {
  const first = (text.trim().split("\n")[0] ?? "").trim();
  const cut = first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
  return cut ? cut.charAt(0).toLocaleUpperCase() + cut.slice(1) : "";
}

/** A new widget's size: the one picked, else the web's default for its kind (S for a number or a goal, else M). */
export const sizeFor = (kind: WidgetKind, picked: WidgetSize | null): WidgetSize => picked ?? defaultSize(kind);

/**
 * What "New widget" shows on top while the person types: the widget with example data of the kind it will be, at
 * the size it will take on the phone. Null until something is asked.
 */
export function widgetPreview(
  text: string,
  format: WidgetFormat,
  suggested: WidgetKind | null,
  words: ExampleWords,
  size: WidgetSize | null = null,
): { title: string; kind: WidgetKind; spec: WidgetSpec; size: WidgetSize; w: 1 | 2; h: 1 | 2 } | null {
  if (!text.trim()) return null;
  const kind = previewKind(format, suggested);
  const picked = sizeFor(kind, size);
  return {
    title: draftTitle(text, WIDGET_LIMITS.title),
    kind,
    spec: exampleWidgetSpec(kind, words),
    size: picked,
    ...sizeToLayout(picked),
  };
}

/** Where a new widget can go: My Home first (`home`), then the boards the person edits, in the list's order. */
export function destinationsOf(list: DashboardList | undefined): { id: string; title: string | null; home: boolean }[] {
  const boards = (list?.dashboards ?? []).filter((d) => d.kind === "board" && d.canEdit).sort(byOrder);
  return [{ id: HOME, title: null, home: true }, ...boards.map((d) => ({ id: d.id, title: d.title, home: false }))];
}

/** Pinned first, then by position, then by title (the Dashboards list's order). */
const byOrder = (a: DashboardSummary, b: DashboardSummary) =>
  Number(b.pinned) - Number(a.pinned) || a.position - b.position || a.title.localeCompare(b.title);

/** The id that stands for My Home in the phone's routes (`/board/home`) and pickers, until its board is known. */
export const HOME = "home";

/** A board id from a route or a picker: My Home's real id when `HOME` and the home board is loaded. */
export const realBoardId = (id: string, homeId: string | null | undefined): string | null =>
  id === HOME ? (homeId ?? null) : id;

// ── Who sees, who edits ──────────────────────────────────────────────────────

export interface AudienceDraft {
  audience: DashboardAudience;
  roleIds: string[];
  editPolicy: DashboardEditPolicy;
}

/** Share's starting point: the board as it is (a new board starts for the whole workspace, edited by who sees it). */
export function audienceDraftOf(
  board?: Pick<DashboardSummary, "audience" | "roleIds" | "editPolicy"> | null,
): AudienceDraft {
  if (!board) return { audience: "workspace", roleIds: [], editPolicy: "viewers" };
  return { audience: board.audience, roleIds: [...board.roleIds], editPolicy: board.editPolicy };
}

/** A role chip tapped: in or out of the draft. */
export const toggleRole = (draft: AudienceDraft, roleId: string): AudienceDraft => ({
  ...draft,
  roleIds: draft.roleIds.includes(roleId) ? draft.roleIds.filter((r) => r !== roleId) : [...draft.roleIds, roleId],
});

/** Roles need at least one picked. */
export const audienceReady = (draft: AudienceDraft) => draft.audience !== "roles" || draft.roleIds.length > 0;

/** What Share sends: the roles only for a `roles` audience. */
export const shareInputOf = (draft: AudienceDraft): ShareDashboardInput => ({
  audience: draft.audience,
  roleIds: draft.audience === "roles" ? draft.roleIds : [],
  editPolicy: draft.editPolicy,
});

/** Whether the draft changes who sees or edits the board. */
export function audienceChanged(
  board: Pick<Dashboard, "audience" | "roleIds" | "editPolicy">,
  draft: AudienceDraft,
): boolean {
  const roles = (ids: readonly string[]) => [...ids].sort().join(",");
  return (
    board.audience !== draft.audience ||
    board.editPolicy !== draft.editPolicy ||
    (draft.audience === "roles" && roles(board.roleIds) !== roles(draft.roleIds))
  );
}

/** A member as Share's access rule needs them: an owner, or someone with an `administrator` role, is an admin. */
export function accessPerson(
  member: Pick<Member, "userId" | "role" | "roleIds">,
  roles: readonly Pick<OrgRole, "id" | "permissions">[],
): { userId: string; roleIds: string[]; admin: boolean } {
  const roleIds = member.roleIds ?? [];
  const admin =
    member.role === "owner" || roles.some((r) => roleIds.includes(r.id) && r.permissions.includes("administrator"));
  return { userId: member.userId, roleIds, admin };
}

/** The names of a board's roles, in the workspace's order (unknown ones left out). */
export function roleNamesOf(
  roleIds: readonly string[],
  roles: readonly Pick<OrgRole, "id" | "name">[],
): string[] {
  return roles.filter((r) => roleIds.includes(r.id)).map((r) => r.name);
}

// ── Pin from a message ───────────────────────────────────────────────────────

/** A message's charts handed to "Pin to a dashboard" (a route can't carry them in its URL). */
export interface PinDraft {
  messageId: string;
  agentId: string;
  /** The ```chart blocks' JSON, in order. */
  blocks: string[];
}

let pinDraft: PinDraft | null = null;

export const setPinDraft = (draft: PinDraft | null) => {
  pinDraft = draft;
};
export const pinDraftNow = (): PinDraft | null => pinDraft;
