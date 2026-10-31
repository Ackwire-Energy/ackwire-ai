import { headingId, INLINE, MENTION, parseMarkdown, parseWikiToken, SAFE_URL } from "@agenteschat/client/lib/markdown";
import { type ReactNode, useMemo } from "react";
import { MermaidOrCode } from "@/components/artifacts/Mermaid";
import { ChartOrCode } from "@/components/ChartBlock";
import { CodeBlock } from "@/components/CodeBlock";

/**
 * A small, safe Markdown renderer for chat messages and artifact documents
 * (the parser is shared: `@agenteschat/client/lib/markdown`). It builds React
 * elements only: raw HTML in the source is shown as text, never interpreted.
 * Links allow http(s) and mailto. In messages, line breaks are kept and
 * @mentions become our mention chips.
 */
export * from "@agenteschat/client/lib/markdown";

export type MentionRenderer = (handle: string, key: string) => ReactNode;
/** `[[Título]]` or `[[Título|texto]]`: how a wiki link shows (a chip, a dashed missing link…). */
export type WikiLinkRenderer = (title: string, label: string, key: string) => ReactNode;
/** `![[foto.png]]`: how an embed shows (`block` alone on its line, else inside a sentence). */
export type EmbedRenderer = (target: string, key: string, block: boolean) => ReactNode;

/**
 * A streaming answer's words, each in its own span (keyed by position, so a
 * word already on screen keeps its node and only new ones fade in); spaces
 * stay plain text.
 */
function wordSpans(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) out.push(part);
    else
      out.push(
        <span key={`${key}-w${i++}`} className="ac-word">
          {part}
        </span>,
      );
  }
  return out;
}

function withMentions(text: string, key: string, mention?: MentionRenderer, words?: boolean): ReactNode[] {
  const plain = (t: string, k: string) => (words ? wordSpans(t, k) : [t]);
  if (!mention) return plain(text, key);
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(MENTION)) {
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    if (start > last) out.push(...plain(text.slice(last, start), `${key}-p${n}`));
    out.push(mention(m[2] ?? "", `${key}-m${n++}`));
    last = start + 1 + (m[2]?.length ?? 0);
  }
  if (last < text.length) out.push(...plain(text.slice(last), `${key}-p${n}`));
  return out;
}

const link = (href: string, key: string, children: ReactNode) => (
  <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="ac-link">
    {children}
  </a>
);

export function renderInline(
  text: string,
  key = "i",
  mention?: MentionRenderer,
  wiki?: WikiLinkRenderer,
  embed?: EmbedRenderer,
  /** Each plain word in its own `.ac-word` span (a streaming answer's words fade in). */
  words?: boolean,
): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  const inner = (t: string, k: string) => renderInline(t, k, mention, wiki, embed, words);
  while (rest) {
    const m = rest.match(INLINE);
    if (!m || m.index === undefined) {
      out.push(...withMentions(rest, `${key}-t${n}`, mention, words));
      break;
    }
    const tok = m[0];
    const k = `${key}-${n++}`;
    // `![[…]]` inside a sentence: the "!" belongs to the embed.
    const isEmbed = Boolean(m[6] && embed && m.index > 0 && rest[m.index - 1] === "!");
    const before = rest.slice(0, isEmbed ? m.index - 1 : m.index);
    if (before) out.push(...withMentions(before, `${key}-t${n}`, mention, words));
    if (isEmbed && embed) {
      out.push(embed(parseWikiToken(tok).title, k, false));
      rest = rest.slice(m.index + tok.length);
      continue;
    }
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inner(tok.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inner(tok.slice(1, -1), k)}</em>);
    else if (m[7]) out.push(<del key={k}>{inner(tok.slice(2, -2), k)}</del>);
    else if (m[4]) {
      const parts = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const href = parts?.[2] ?? "";
      out.push(SAFE_URL.test(href) ? link(href, k, renderInline(parts?.[1] ?? "", k, mention, wiki)) : tok);
    } else if (m[6]) {
      const { title, label } = parseWikiToken(tok);
      out.push(
        wiki ? (
          wiki(title, label, k)
        ) : (
          <span key={k} className="wiki-link">
            {label}
          </span>
        ),
      );
    } else out.push(link(tok, k, tok));
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

export interface MarkdownProps {
  source: string;
  /**
   * `document` (artifacts): real headings, wrapped in `.md`.
   * `message` (chat): line breaks kept, headings as bold lines, no wrapper.
   */
  variant?: "document" | "message";
  mention?: MentionRenderer;
  wikiLink?: WikiLinkRenderer;
  /** Obsidian embeds (`![[file]]`); without it they show as a plain link. */
  embed?: EmbedRenderer;
  /** Skip a leading `# Title` equal to this (the page shows the title itself). */
  title?: string;
  /** Plain words in `.ac-word` spans: a streaming answer's newest block, whose words fade in. */
  words?: boolean;
  /** Added to the wrapper (`md--tail` on a streaming answer's last block). */
  className?: string;
}

const TASK = /^\[( |x|X)\]\s+(.*)$/;
const CALLOUT = /^\[!([\w-]+)\][+-]?\s*(.*)$/i;
/** Obsidian's callout kinds, in our three looks. */
const calloutKind = (kind: string) =>
  /^(warning|caution|attention|danger|error|bug|failure|fail|missing|important)$/.test(kind)
    ? "warning"
    : /^(tip|hint|success|check|done)$/.test(kind)
      ? "tip"
      : "note";

export function Markdown({
  source,
  variant = "document",
  mention,
  wikiLink,
  embed,
  title,
  words,
  className,
}: MarkdownProps) {
  const message = variant === "message";
  const inline = (text: string, k: string) => renderInline(text, k, mention, wikiLink, embed, words);
  // Parsed once per source (a streaming row re-renders every reveal frame); never mutated.
  const all = useMemo(() => parseMarkdown(source, { breaks: message }), [source, message]);
  const [first] = all;
  const parsed =
    title && first?.type === "heading" && first.level === 1 && first.text.trim() === title.trim() ? all.slice(1) : all;
  const blocks = parsed.map((b, i) => {
    const k = `b${i}`;
    switch (b.type) {
      case "heading": {
        if (message) {
          // Opens a section (more air above), still a bold line rather than a document heading.
          return (
            <p key={k} className="md__h">
              <strong>{inline(b.text, k)}</strong>
            </p>
          );
        }
        const H = `h${Math.min(6, b.level + 1)}` as "h2";
        return (
          <H key={k} id={`h-${headingId(b.text)}`}>
            {inline(b.text, k)}
          </H>
        );
      }
      case "paragraph":
        return <p key={k}>{inline(b.text, k)}</p>;
      case "code": {
        const lang = b.lang.toLowerCase();
        if (lang === "chart") return <ChartOrCode key={k} text={b.text} writing={Boolean(words)} />;
        // Drawn once its block is done: the tail of an answer still being written (its fence maybe still open)
        // keeps the code, so the diagram isn't drawn again on every word.
        if (lang === "mermaid" && !words) return <MermaidOrCode key={k} text={b.text} />;
        return <CodeBlock key={k} lang={b.lang} text={b.text} />;
      }
      case "list": {
        const L = b.ordered ? "ol" : "ul";
        return (
          <L key={k}>
            {b.items.map((item, j) => {
              // "- [ ] tarefa" / "- [x] feita": a task with our own (read-only) box.
              const task = item.match(TASK);
              if (task) {
                const done = task[1] !== " ";
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list
                  <li key={j} className="md__task" data-done={done || undefined}>
                    <span className="md__task-box" role="img" aria-label={done ? "✓" : "○"} />
                    <span>{inline(task[2] ?? "", `${k}-${j}`)}</span>
                  </li>
                );
              }
              // biome-ignore lint/suspicious/noArrayIndexKey: static list
              return <li key={j}>{inline(item, `${k}-${j}`)}</li>;
            })}
          </L>
        );
      }
      case "quote": {
        // "> [!note] Título" + lines → a callout (neutral card with an icon), as in Obsidian.
        const callout = (b.lines[0] ?? "").match(CALLOUT);
        if (callout && !message) {
          const kind = calloutKind((callout[1] ?? "note").toLowerCase());
          const rest = b.lines.slice(1).join(" ").trim();
          return (
            <aside key={k} className="md__callout" data-kind={kind}>
              {callout[2] ? <b className="md__callout-title">{inline(callout[2], `${k}t`)}</b> : null}
              {rest ? <span className="md__callout-body">{inline(rest, `${k}b`)}</span> : null}
            </aside>
          );
        }
        return <blockquote key={k}>{inline(b.text, k)}</blockquote>;
      }
      case "embed":
        return embed ? embed(b.target, k, true) : <p key={k}>{inline(`[[${b.target}]]`, k)}</p>;
      case "rule":
        return <hr key={k} />;
      case "table":
        return (
          <div key={k} className="md__table">
            <table>
              <thead>
                <tr>
                  {b.header.map((h, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static table
                    <th key={j} style={{ textAlign: b.align[j] }}>
                      {inline(h, `${k}-h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static table
                  <tr key={j}>
                    {r.map((c, x) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: static table
                      <td key={x} style={{ textAlign: b.align[x] }}>
                        {inline(c, `${k}-${j}-${x}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
    return null;
  });
  const extra = className ? ` ${className}` : "";
  return message ? (
    <div className={`md md--message${extra}`}>{blocks}</div>
  ) : (
    <div className={`md${extra}`}>{blocks}</div>
  );
}
