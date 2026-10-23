import type { Judge } from "../judge";
import { checkCondition, findDismiss } from "./checks";
import {
  diffObservations,
  type ScreenChanges,
  type ScreenElement,
  type ScreenImage,
  type ScreenObservation,
  screenDigest,
  screenRef,
} from "./observation";
import { locateOnImage, resolveTarget, type TargetCache, type TargetUse } from "./targets";

/**
 * Plans (ADR 0054): several steps on a screen in one call of the agent's
 * model. Each step's target is resolved on the screen as it is at that
 * moment (so a plan can cross pages whose elements it never saw), acted on,
 * left to settle and, when the step says what it expects, checked. The plan
 * stops at the first step that fails or doesn't show what it expected, and
 * says what the screen looks like then. Surface-agnostic: the browser is one
 * surface; a desktop can be another.
 */

export type ScreenVerb =
  | "open"
  | "click"
  | "fill"
  | "select"
  | "check"
  | "uncheck"
  | "press"
  | "type_secret"
  | "scroll"
  | "hover"
  | "wait"
  | "back";

/** One step as the agent writes it. */
export interface ScreenStep {
  do: ScreenVerb;
  /** What to act on: an element's number (`e12`) or words ("the Sign in button"). */
  target?: string;
  text?: string;
  value?: string;
  url?: string;
  key?: string;
  secret?: string;
  direction?: "up" | "down" | "left" | "right";
  pixels?: number;
  /** `wait`: until this is true on the screen (words), this text shows, or for this long. */
  until?: string;
  seconds?: number;
  /** After the step, this should be true on the screen; the plan stops when it isn't. */
  expect?: string;
}

/** Where an action lands: an element, or a point (CSS pixels) found on an image. */
export type ActTarget = { ref: string } | { x: number; y: number };

/** A step resolved for the surface. */
export type ScreenAction =
  | { kind: "open"; url: string }
  | { kind: "back" }
  | { kind: "click" | "hover" | "check" | "uncheck"; at: ActTarget }
  | { kind: "fill"; at: ActTarget; text: string }
  | { kind: "select"; at: ActTarget; value: string }
  | { kind: "type_secret"; at: { ref: string }; secret: string }
  | { kind: "press"; key: string }
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right"; pixels: number }
  | { kind: "pause"; ms: number };

export type ScreenActOutcome = { ok: true; observation: ScreenObservation | null } | { ok: false; error: string };

/** What a plan drives: looking, acting, and (when it can) taking an image. */
export interface ScreenSurface {
  /** The screen now. */
  observe(): Promise<ScreenObservation>;
  /** One action; with `settle`, waits until the screen stops changing and looks again. */
  perform(action: ScreenAction, options: { settle: boolean }): Promise<ScreenActOutcome>;
  /** An image of the screen with its elements marked, or null when this surface can't. */
  capture?(): Promise<ScreenImage | null>;
}

export interface PlanDeps {
  judge: Judge;
  orgId: string;
  agentId?: string | null;
  runId?: string;
  surface: ScreenSurface;
  cache?: TargetCache;
  /** Whose memory of targets this is (the agent's browser). */
  scope: string;
  signal?: AbortSignal;
  /** Before each step: why to stop now (a person took over the screen), or null. */
  hold?: () => Promise<string | null>;
  /** The screen as last seen, when it is fresh enough to resolve the first target on. */
  last?: ScreenObservation | null;
  /** What the agent last saw of this screen (what the report's changes are counted from). */
  before?: ScreenObservation | null;
  /** The judge may look at images (Jev's vision): the fallback for targets the text lacks. */
  vision?: boolean;
  now?: () => number;
}

export type StepStatus = "done" | "failed" | "skipped";

export interface StepReport {
  step: ScreenStep;
  status: StepStatus;
  /** What happened, in a few words ("button "Sign in" (e7)", "not on the page"). */
  note?: string;
  /** The element acted on. */
  element?: Pick<ScreenElement, "ref" | "role" | "name"> | null;
  /** How the target was found. */
  via?: "ref" | "exact" | "cache" | "judge" | "image";
  /** Another element closed first (a banner in the way). */
  dismissed?: string;
  /** The step's `expect`, as checked. */
  expected?: { met: boolean | null; p: number };
  ms: number;
}

export interface PlanReport {
  steps: StepReport[];
  /** The first step that didn't go through, and why. */
  stopped?: { index: number; reason: string; candidates?: ScreenElement[] };
  /** The screen before the plan and at its end (null when nothing was seen). */
  before: ScreenObservation | null;
  after: ScreenObservation | null;
  changes: ScreenChanges | null;
  ms: number;
}

const USES: Partial<Record<ScreenVerb, TargetUse>> = {
  click: "click",
  hover: "hover",
  fill: "fill",
  select: "select",
  check: "check",
  uncheck: "check",
  type_secret: "type_secret",
};

/** Steps that need a target. */
export const needsTarget = (step: ScreenStep) => step.do in USES;

const COVERED = /covered by|intercept|obscured|another element would receive/i;
const STALE = /stale|unknown ref|ref\b.*\b(not found|no longer|invalid)|no element (for|matches) ref/i;
/** Longest a `wait` step waits. */
export const MAX_WAIT_MS = 120_000;
const POLL_MS = 700;

/** The plan stops here, for this reason (said to the agent). */
class Stop extends Error {
  constructor(
    readonly reason: string,
    readonly candidates?: ScreenElement[],
  ) {
    super(reason);
  }
}

/** The surface refused or failed an action: its own words. */
class ActFailed extends Error {}

const elementOf = (e: ScreenElement | null | undefined) => (e ? { ref: e.ref, role: e.role, name: e.name } : null);
const quoted = (e: Pick<ScreenElement, "role" | "name" | "ref">) =>
  `${e.role}${e.name ? ` "${e.name.slice(0, 80)}"` : ""} (${e.ref})`;

/** Runs `steps` in order on `deps.surface` (see the file's comment). */
export async function runPlan(deps: PlanDeps, steps: ScreenStep[]): Promise<PlanReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  const reports: StepReport[] = steps.map((step) => ({ step, status: "skipped", ms: 0 }));
  let screen: ScreenObservation | null = deps.last ?? null;
  const before = deps.before ?? screen;
  let stopped: PlanReport["stopped"];
  let dismissedOnce = false;

  const look = async () => {
    screen = await deps.surface.observe();
    return screen;
  };
  /** After an action that went through: a look that fails doesn't undo the action (the next step looks again). */
  const lookAfter = async (seen: ScreenObservation | null) => {
    if (seen) {
      screen = seen;
      return;
    }
    screen = await deps.surface.observe().catch(() => null);
  };

  const settleOn = async (action: ScreenAction) => {
    const out = await deps.surface.perform(action, { settle: true });
    if (!out.ok) throw new ActFailed(out.error);
    await lookAfter(out.observation);
  };

  async function runStep(step: ScreenStep, report: StepReport) {
    switch (step.do) {
      case "open": {
        const url = (step.url ?? step.target ?? "").trim();
        if (!/^https?:\/\//i.test(url)) throw new Stop("give a full address starting with https://");
        await settleOn({ kind: "open", url });
        report.note = url;
        return;
      }
      case "back":
        await settleOn({ kind: "back" });
        return;
      case "press":
        if (!step.key?.trim()) throw new Stop("say which key");
        await settleOn({ kind: "press", key: step.key.trim() });
        return;
      case "scroll":
        await settleOn({
          kind: "scroll",
          direction: step.direction ?? "down",
          pixels: Math.min(10_000, Math.max(50, Math.round(step.pixels ?? 800))),
        });
        return;
      case "wait":
        await waitStep(step, report);
        return;
      default:
        await targeted(step, report);
    }
  }

  async function waitStep(step: ScreenStep, report: StepReport) {
    const ms = Math.min(MAX_WAIT_MS, Math.max(0, Math.round((step.seconds ?? 30) * 1000)));
    const until = step.until?.trim();
    const text = step.text?.trim();
    if (!until && !text) {
      await deps.surface.perform({ kind: "pause", ms: Math.min(ms, 30_000) }, { settle: false });
      await lookAfter(null);
      return;
    }
    const deadline = now() + ms;
    let checked: string | null = null;
    for (;;) {
      if (deps.signal?.aborted) throw new Stop("stopped");
      const current = await look();
      if (text && current.lines.some((l) => l.includes(text))) {
        report.note = `"${text}" showed`;
        return;
      }
      // The judge only looks again when the screen changed.
      const digest = screenDigest(current);
      if (until && digest !== checked) {
        checked = digest;
        const r = await checkCondition({
          judge: deps.judge,
          orgId: deps.orgId,
          agentId: deps.agentId,
          runId: deps.runId,
          condition: until,
          observation: current,
        });
        if (r.met === true) {
          report.note = `"${until}" is true`;
          return;
        }
      }
      if (now() + POLL_MS > deadline) throw new Stop(`waited ${Math.round(ms / 1000)} s and it didn't happen`);
      await deps.surface.perform({ kind: "pause", ms: POLL_MS }, { settle: false });
    }
  }

  async function targeted(step: ScreenStep, report: StepReport) {
    const use = USES[step.do] as TargetUse;
    const words = step.target?.trim();
    if (!words) throw new Stop("say what to act on (`target`)");
    if (step.do === "fill" && step.text === undefined) throw new Stop("say what to write (`text`)");
    if (step.do === "select" && !step.value?.trim()) throw new Stop("say which option (`value`)");
    if (step.do === "type_secret" && !step.secret?.trim()) throw new Stop("say which secret (`secret`)");

    const find = async (fresh: boolean): Promise<{ at: ActTarget; element: ScreenElement | null }> => {
      // A number from the page needs no look: the browser checks it (a stale one fails and says so).
      const given = screenRef(words);
      if (given) {
        report.via = "ref";
        return { at: { ref: given }, element: screen?.elements.find((e) => e.ref === given) ?? null };
      }
      const current = fresh || !screen ? await look() : screen;
      const r = await resolveTarget({
        judge: deps.judge,
        orgId: deps.orgId,
        agentId: deps.agentId,
        runId: deps.runId,
        target: words,
        use,
        observation: current,
        cache: deps.cache,
        scope: deps.scope,
      });
      if (r.found) {
        report.via = r.via;
        return { at: { ref: r.ref }, element: r.element };
      }
      // Not in the text (an icon without a name, a canvas): look at the screen itself.
      if (deps.vision && deps.surface.capture && step.do !== "type_secret") {
        const image = await deps.surface.capture().catch(() => null);
        if (image) {
          const spot = await locateOnImage({
            judge: deps.judge,
            orgId: deps.orgId,
            agentId: deps.agentId,
            runId: deps.runId,
            target: words,
            image,
            url: current.url,
          });
          if (spot.found) {
            report.via = "image";
            const element = spot.ref ? (current.elements.find((e) => e.ref === spot.ref) ?? null) : null;
            return { at: spot.ref ? { ref: spot.ref } : { x: spot.x, y: spot.y }, element };
          }
        }
      }
      throw new Stop(
        r.reason === "unsure"
          ? `"${words}" could be more than one thing on the page`
          : `couldn't find "${words}" on the page`,
        r.candidates,
      );
    };

    const act = (at: ActTarget): ScreenAction => {
      switch (step.do) {
        case "fill":
          return { kind: "fill", at, text: step.text ?? "" };
        case "select":
          return { kind: "select", at, value: (step.value ?? "").trim() };
        case "type_secret":
          if (!("ref" in at)) throw new Stop("a password goes only into a field found on the page");
          return { kind: "type_secret", at, secret: (step.secret ?? "").trim() };
        case "click":
        case "hover":
        case "check":
        case "uncheck":
          return { kind: step.do, at };
        default:
          throw new Stop(`can't ${step.do} a target`);
      }
    };

    const noteOf = (f: { at: ActTarget; element: ScreenElement | null }) =>
      f.element ? quoted(f.element) : "ref" in f.at ? `element ${f.at.ref}` : "a spot on the page";
    let found = await find(false);
    report.element = elementOf(found.element);
    report.note = noteOf(found);
    let out = await deps.surface.perform(act(found.at), { settle: true });
    // Something covers it (a cookie banner, a dialog): close it once, then the step again.
    if (!out.ok && COVERED.test(out.error) && !dismissedOnce) {
      dismissedOnce = true;
      const current = await look();
      const close = await findDismiss({
        judge: deps.judge,
        orgId: deps.orgId,
        agentId: deps.agentId,
        runId: deps.runId,
        observation: current,
        covering: out.error,
      });
      if (close) {
        const closed = await deps.surface.perform({ kind: "click", at: { ref: close.ref } }, { settle: true });
        if (closed.ok) {
          report.dismissed = quoted(close);
          await lookAfter(closed.observation);
          found = await find(false);
          out = await deps.surface.perform(act(found.at), { settle: true });
        }
      }
    }
    // The page changed since the target was found (its number went stale): find it again once.
    if (!out.ok && STALE.test(out.error) && report.via !== "ref") {
      found = await find(true);
      out = await deps.surface.perform(act(found.at), { settle: true });
    }
    if (!out.ok) throw new ActFailed(out.error);
    report.element = elementOf(found.element);
    report.note = noteOf(found);
    await lookAfter(out.observation);
  }

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] as ScreenStep;
    const report = reports[index] as StepReport;
    const t0 = now();
    try {
      if (deps.signal?.aborted) throw new Stop("stopped");
      const held = await deps.hold?.();
      if (held) throw new Stop(held);
      const prior: ScreenObservation | null = screen;
      await runStep(step, report);
      if (step.expect?.trim()) {
        const after = screen ?? (await look());
        const check = await checkCondition({
          judge: deps.judge,
          orgId: deps.orgId,
          agentId: deps.agentId,
          runId: deps.runId,
          condition: step.expect,
          observation: after,
          changes: diffObservations(prior, after),
        });
        report.expected = check;
        if (check.met !== true) {
          throw new Stop(
            check.met === false
              ? `expected "${step.expect.trim()}", but the page doesn't show it`
              : `couldn't confirm "${step.expect.trim()}" on the page`,
          );
        }
      }
      report.status = "done";
    } catch (error) {
      report.status = "failed";
      const reason = error instanceof Error ? error.message : String(error);
      report.note = report.note ? `${report.note}: ${reason}` : reason;
      stopped = {
        index,
        reason,
        ...(error instanceof Stop && error.candidates ? { candidates: error.candidates } : {}),
      };
    } finally {
      report.ms = now() - t0;
    }
    if (stopped) break;
  }
  const after: ScreenObservation | null = screen;
  return {
    steps: reports,
    ...(stopped ? { stopped } : {}),
    before,
    after,
    changes: after ? diffObservations(before, after) : null,
    ms: now() - started,
  };
}
