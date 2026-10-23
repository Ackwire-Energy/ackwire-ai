import { clipLines, describeElement, type ScreenChanges, type ScreenObservation, screenOverview } from "./observation";
import type { PlanReport, ScreenStep, ScreenVerb, StepReport } from "./plan";

/**
 * A plan's report as the agent reads it (ADR 0054): what was done, where it
 * stopped and why, and the screen at the end: what changed on it, or, on a
 * new page, what can be acted on. The agent rarely needs a separate read
 * after acting.
 */

const DONE: Record<ScreenVerb, string> = {
  open: "Opened",
  click: "Clicked",
  fill: "Filled in",
  select: "Selected in",
  check: "Ticked",
  uncheck: "Unticked",
  press: "Pressed",
  type_secret: "Typed the secret into",
  scroll: "Scrolled",
  hover: "Hovered",
  wait: "Waited",
  back: "Went back",
  read: "Read",
};

/** One step in a few words ("click "the Sign in button""). */
export function stepLabel(step: ScreenStep): string {
  switch (step.do) {
    case "open":
      return `open ${step.url ?? step.target ?? ""}`.trim();
    case "press":
      return `press ${step.key ?? ""}`.trim();
    case "scroll":
      return `scroll ${step.direction ?? "down"}`;
    case "wait":
      return step.until ? `wait until "${step.until}"` : step.text ? `wait for "${step.text}"` : "wait";
    case "back":
      return "back";
    case "read":
      return step.find || step.target ? `read "${step.find ?? step.target}"` : "read the page";
    default:
      return `${step.do.replace("_", " ")} "${step.target ?? ""}"`;
  }
}

function stepLine(r: StepReport): string {
  const what =
    r.step.do === "press"
      ? `${DONE.press} ${r.step.key ?? ""}`
      : r.step.do === "scroll"
        ? `${DONE.scroll} ${r.step.direction ?? "down"}`
        : r.step.do === "type_secret"
          ? `${DONE.type_secret} ${r.note ?? "the field"} (${r.step.secret ?? ""})`
          : `${DONE[r.step.do]}${r.note ? ` ${r.note}` : ""}`;
  const extra = [
    r.dismissed ? `closed ${r.dismissed} first: it covered the page` : null,
    r.via === "image" ? "found on the screen image" : null,
    r.expected?.met === true ? `✓ ${JSON.stringify(r.step.expect?.trim() ?? "")}` : null,
  ].filter(Boolean);
  return `${what.trim()}${extra.length > 0 ? ` (${extra.join("; ")})` : ""}.`;
}

export interface FormattedReport {
  /** What was done and where it stopped (no page text). */
  summary: string;
  /** The screen at the end (page text: untrusted, wrapped by the caller), or null. */
  screen: string | null;
  /** The plan stopped before its end. */
  failed: boolean;
}

/** What changed, or the new page's controls, at most `max` characters. */
export function describeScreen(
  after: ScreenObservation | null,
  changes: ScreenChanges | null,
  options: { maxChanges?: number; maxOverview?: number; overview?: boolean } = {},
): string | null {
  if (!after) return null;
  const head = after.url ? `Now at ${after.url}` : null;
  if (!changes || changes.newPage || options.overview) {
    const { text, omitted } = screenOverview(after, options.maxOverview ?? 6000);
    const rest = omitted > 0 ? `\n[${omitted} more lines: read the page for its text]` : "";
    return [
      head,
      `${changes?.newPage === false ? "On the page" : "New page"}: what you can act on`,
      text || "(nothing to act on)",
    ]
      .filter(Boolean)
      .join("\n")
      .concat(rest);
  }
  if (changes.added.length === 0 && changes.removed.length === 0) {
    return [head, "Nothing changed on the page."].filter(Boolean).join("\n");
  }
  const lines = [...changes.added.map((l) => `+ ${l.trim()}`), ...changes.removed.map((l) => `- ${l.trim()}`)];
  const { text, omitted } = clipLines(lines, options.maxChanges ?? 3500);
  return [
    head,
    "Changed on the page (+ new, - gone):",
    text,
    omitted > 0 ? `[${omitted} more changes: read the page to see it all]` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The report for the agent (see the file's comment). */
export function formatPlanReport(r: PlanReport): FormattedReport {
  const done = r.steps.filter((s) => s.status === "done");
  const out: string[] = [];
  const closest = r.stopped?.candidates?.length
    ? `Closest on the page: ${r.stopped.candidates.map((c) => `${describeElement(c, 120)} [${c.ref}]`).join("; ")}.`
    : null;
  // The step that stopped the plan ran, and only its check failed: say it was done, so it isn't done twice.
  const stoppedStep = r.stopped ? (r.steps[r.stopped.index] as StepReport) : null;
  const ranButUnconfirmed = stoppedStep?.ran
    ? `${stepLine({ ...stoppedStep, expected: undefined }).replace(/\.$/, "")}, but ${r.stopped?.reason}. It was done: don't do it again; look at what the page shows.`
    : null;
  if (r.steps.length === 1) {
    const only = r.steps[0] as StepReport;
    if (ranButUnconfirmed) out.push(ranButUnconfirmed);
    else if (r.stopped) out.push(`Couldn't ${stepLabel(only.step)}: ${r.stopped.reason}`);
    else out.push(stepLine(only));
    if (closest) out.push(closest);
  } else {
    if (r.stopped) {
      const n = r.stopped.index + 1;
      const at = stepLabel((stoppedStep as StepReport).step);
      out.push(
        ranButUnconfirmed
          ? `Stopped after step ${n} of ${r.steps.length} (${at}): ${ranButUnconfirmed}`
          : `Stopped at step ${n} of ${r.steps.length} (${at}): ${r.stopped.reason}`,
      );
      if (closest) out.push(closest);
      out.push(
        done.length > 0 ? `Done before it: ${done.length} step${done.length > 1 ? "s" : ""}.` : "Nothing was done.",
      );
    } else out.push(`Done: all ${r.steps.length} steps.`);
    done.forEach((s, i) => {
      out.push(`${i + 1}. ${stepLine(s)}`);
    });
  }
  // What `read` steps found goes with the page (it is page text), before what changed on it.
  const found = r.steps
    .filter((s) => s.status === "done" && s.found)
    .map((s) => {
      const f = s.found as NonNullable<StepReport["found"]>;
      if (f.answered === "no" || !f.text) return `Nothing on the page answers "${f.question}".`;
      return `Where the page answers "${f.question}"${f.answered === "partly" ? " (maybe only in part)" : ""}:\n${f.text}`;
    });
  const screen = describeScreen(r.after, r.changes);
  return {
    summary: out.join("\n"),
    screen: found.length > 0 ? [...found, screen].filter(Boolean).join("\n\n") : screen,
    failed: Boolean(r.stopped),
  };
}
