import type { LiveCode, LiveOutput, LiveWork } from "@agenteschat/client";
import { activityVerb, toolActivity } from "@agenteschat/client/lib/activity";
import { nearBottom } from "@agenteschat/client/lib/chat";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { foldLiveWork } from "@agenteschat/client/lib/work";
import { Button, Icon, PixelDone, PixelStop } from "@agenteschat/ui";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentSpinner } from "@/components/AgentAvatar";
import { useToast } from "@/lib/toast";

const KEYWORDS = new Set([
  // Python
  "def",
  "return",
  "import",
  "from",
  "as",
  "for",
  "in",
  "if",
  "elif",
  "else",
  "while",
  "class",
  "with",
  "try",
  "except",
  "finally",
  "raise",
  "lambda",
  "pass",
  "None",
  "True",
  "False",
  "and",
  "or",
  "not",
  // JS / TS / shell
  "const",
  "let",
  "var",
  "function",
  "async",
  "await",
  "new",
  "export",
  "null",
  "undefined",
  "true",
  "false",
  "then",
  "fi",
  "do",
  "done",
  "echo",
]);

export type CodeToken = { kind: "comment" | "string" | "keyword" | "number" | "text"; text: string };

/** A light tokenizer (no highlighter library): comments, strings, numbers and keywords; the rest is text. */
export function tokenizeCode(source: string): CodeToken[] {
  const out: CodeToken[] = [];
  const re =
    /(#[^\n]*|\/\/[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let last = 0;
  for (const m of source.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: source.slice(last, at) });
    const [all, comment, string, number, word] = m;
    if (comment) out.push({ kind: "comment", text: all });
    else if (string) out.push({ kind: "string", text: all });
    else if (number) out.push({ kind: "number", text: all });
    else if (word && KEYWORDS.has(word)) out.push({ kind: "keyword", text: all });
    else out.push({ kind: "text", text: all });
    last = at + all.length;
  }
  if (last < source.length) out.push({ kind: "text", text: source.slice(last) });
  // Merge adjacent text tokens.
  return out.reduce<CodeToken[]>((acc, tok) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.kind === "text" && tok.kind === "text") prev.text += tok.text;
    else acc.push({ ...tok });
    return acc;
  }, []);
}

/** The code, mono, with the light tokens. */
export function CodeView({ code }: { code: LiveCode }) {
  const { t } = useTranslation();
  return (
    <section aria-label={t("code.source", { language: code.language })}>
      <pre className="live-code__src">
        <code>
          {tokenizeCode(code.source).map((tok, i) =>
            tok.kind === "text" ? (
              tok.text
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: static tokens of one source
              <span key={i} className={`live-code__${tok.kind}`}>
                {tok.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </section>
  );
}

/** The terminal-style output: stdout neutral, stderr in the danger tone; follows new output while at the bottom. */
export function OutputView({ output, live }: { output: LiveOutput[]; live?: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const size = output.reduce((n, o) => n + o.text.length, 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow whenever output grows
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [size]);
  return (
    <section aria-label={t("code.output")} aria-live={live ? "polite" : undefined}>
      <pre
        ref={ref}
        className="live-code__out"
        onScroll={(e) => {
          pinned.current = nearBottom(e.currentTarget);
        }}
      >
        {output.length === 0 ? (
          <span className="live-code__empty">{live ? t("code.waiting") : t("code.noOutput")}</span>
        ) : (
          output.map((o, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: output chunks in order
            <span key={i} className={o.stream === "stderr" ? "live-code__stderr" : "live-code__stdout"}>
              {o.text}
            </span>
          ))
        )}
      </pre>
    </section>
  );
}

/** Code + output with "copiar" (the code). Used live in the activity bar and in the work summary. */
export function CodePanel({
  code,
  output,
  live,
  header,
}: {
  code: LiveCode;
  output: LiveOutput[];
  live?: boolean;
  header?: ReactNode;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  return (
    <div className="live-code">
      <div className="live-code__bar">
        <span className="small muted">{header ?? code.language}</span>
        <span style={{ flex: 1 }} />
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await navigator.clipboard?.writeText(code.source);
            toast.show(t("code.copied"));
          }}
        >
          {t("code.copy")}
        </Button>
      </div>
      <CodeView code={code} />
      <OutputView output={output} live={live} />
    </div>
  );
}

/** "Ver código" under the activity bar: opens the live code and output of the agents running code. */
export function LiveCodeToggle({ name, code, output }: { name: string; code: LiveCode; output: LiveOutput[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="live-code-toggle">
      <button type="button" className="live-code-toggle__btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="code" size={14} />
        {open ? t("code.hide") : t("code.show", agentGrammar(t, name))}
      </button>
      {open && <CodePanel code={code} output={output} live header={t("code.running", { name })} />}
    </div>
  );
}

/** "3,4 KB" / "820 B". */
export function formatBytes(locale: string, bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(kb)} KB`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(kb / 1024)} MB`;
}

const outputBytes = (output: LiveOutput[]) => output.reduce((n, o) => n + new TextEncoder().encode(o.text).length, 0);

/** One tool call in a live reply: the status line (a button) and, open, its code and output. */
function LiveCallBlock({
  call,
  agentId,
  stopped,
}: {
  call: Extract<LiveWork, { kind: "call" }>;
  /** The spinner of a running step takes the agent's color. */
  agentId?: string;
  /** The run was stopped during this call. */
  stopped?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const activity = toolActivity(call.tool, call.connector, call.detail);
  const hasDetail = Boolean(call.code) || call.output.length > 0;
  // Open while it runs; it folds into a one-line summary when the call ends (the person can reopen it).
  const [open, setOpen] = useState(call.running);
  const wasRunning = useRef(call.running);
  useEffect(() => {
    if (wasRunning.current && !call.running) setOpen(false);
    wasRunning.current = call.running;
  }, [call.running]);
  const lines = call.code ? call.code.source.split("\n").length : 0;
  const label =
    call.running || stopped
      ? `${capitalizeFirst(activityVerb(t, activity))}${stopped ? "" : "…"}`
      : call.code
        ? t("code.ranSummary", {
            count: lines,
            language: call.code.language,
            size: formatBytes(i18n.language, outputBytes(call.output)),
          })
        : t(`chat.work.step.${activity.kind}`, { app: activity.app ?? "", tool: call.tool });
  // Pixel marks (telas/Mensagens.html): the orbit while it runs, one green pixel when done, a dim square if stopped.
  const mark = call.running ? (
    <AgentSpinner agentId={agentId} size={14} />
  ) : stopped ? (
    <PixelStop size={12} dim />
  ) : (
    <PixelDone size={14} />
  );
  const state = call.running ? "run" : stopped ? "stop" : "done";
  return (
    <div className="live-call" data-running={call.running || undefined} data-s={state}>
      {hasDetail ? (
        <button type="button" className="live-call__head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="live-call__mark">{mark}</span>
          <span>{label}</span>
        </button>
      ) : (
        <p className="live-call__head live-call__head--static">
          <span className="live-call__mark">{mark}</span>
          <span>{label}</span>
        </p>
      )}
      {open &&
        hasDetail &&
        (call.code ? (
          <CodePanel code={call.code} output={call.output} live={call.running} />
        ) : (
          <OutputView output={call.output} live={call.running} />
        ))}
    </div>
  );
}

const capitalizeFirst = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/** A message that went into the running task, as the agent took it in. */
export interface SteerNote {
  /** Its author's name. */
  author: string;
  /** I wrote it ("seu recado"). */
  mine: boolean;
  text: string;
}

/**
 * "Leu seu recado · separa por iPhone e Android" in a well inside the work; "Parou para ler seu
 * recado" when the person asked it to stop and read now.
 */
function SteerWell({ now, note }: { now: boolean; note: SteerNote | undefined }) {
  const { t } = useTranslation();
  const title = note
    ? now
      ? note.mine
        ? t("run.well.nowYours")
        : t("run.well.nowOf", { name: note.author })
      : note.mine
        ? t("run.well.readYours")
        : t("run.well.readOf", { name: note.author })
    : now
      ? t("run.well.nowYours")
      : t("run.well.readYours");
  return (
    <p className="live-work__steer">
      <Icon name={now ? "bolt" : "checks"} size={14} />
      <b>{title}</b>
      {note?.text && <q>{note.text}</q>}
    </p>
  );
}

/**
 * The live work of a reply, stacked like a mini timeline: what it said, the messages it read and each
 * tool call. When the answer is done the steps fold into "3 passos" (the same element, so it closes
 * smoothly); a click opens them again.
 */
export function LiveWorkList({
  work,
  steerNote,
  agentId,
  done,
  stopped,
}: {
  work: LiveWork[];
  /** What went into the task: who wrote it and its text (by message id). */
  steerNote?: (messageId: string) => SteerNote | undefined;
  agentId?: string;
  /** Finished: fold into the steps' count. */
  done?: boolean;
  /** Stopped by someone: the running call shows as stopped. */
  stopped?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const shown = foldLiveWork(work);
  if (shown.length === 0) return null;
  const calls = shown.filter((w) => w.kind === "call");
  const lastCall = calls.at(-1);
  const folded = Boolean(done) && !open;
  return (
    <div className="live-work-wrap">
      {done && calls.length > 0 && (
        <button type="button" className="live-work__sum" aria-expanded={!folded} onClick={() => setOpen(!open)}>
          <Icon name="chevronRight" size={14} className="live-work__chev" />
          {t("chat.work.steps", { count: calls.length })}
        </button>
      )}
      <div className="live-work-fold" data-folded={(folded && calls.length > 0) || undefined}>
        <div className="live-work">
          {shown.map((w, i) =>
            w.kind === "say" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: narration lines in order
              <p key={`say-${i}`} className="live-work__say">
                {w.text}
              </p>
            ) : w.kind === "steer" ? (
              <SteerWell key={`steer-${w.messageId}`} now={w.now === true} note={steerNote?.(w.messageId)} />
            ) : (
              <LiveCallBlock key={w.id} call={w} agentId={agentId} stopped={stopped && w === lastCall} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
