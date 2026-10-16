import type { ReactNode } from "react";

/**
 * A small, safe Markdown renderer for chat messages and artifact documents:
 * headings, paragraphs, lists, quotes, rules, GFM tables, fenced code (mono),
 * inline code, bold, italic, ~~strikethrough~~, links and bare URLs. It builds React elements
 * only: raw HTML in the source is shown as text, never interpreted. Links
 * allow http(s) and mailto. In messages, line breaks are kept and @mentions
 * become our mention chips.
 */
export type MdBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string; lines: string[] }
  | { type: "embed"; target: string }
  | { type: "rule" }
  | { type: "table"; header: string[]; rows: string[][] };

const LIST = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function parseMarkdown(source: string, options: { breaks?: boolean } = {}): MdBlock[] {
  const join = options.breaks ? "\n" : " ";
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] as string)) body.push(lines[i++] as string);
      i++;
      out.push({ type: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      out.push({ type: "heading", level: (heading[1] as string).length, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ type: "rule" });
      i++;
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(next)) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).includes("|") && (lines[i] as string).trim()) {
        rows.push(splitRow(lines[i++] as string));
      }
      out.push({ type: "table", header, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] as string))
        body.push((lines[i++] as string).replace(/^\s*>\s?/, ""));
      out.push({ type: "quote", text: body.join(join), lines: body });
      continue;
    }
    // `![[foto.png]]` alone on its line: an Obsidian embed (an attachment or another note).
    const embed = line.match(/^\s*!\[\[([^[\]\n|]+)(?:\|[^\]\n]*)?\]\]\s*$/);
    if (embed) {
      out.push({ type: "embed", target: (embed[1] ?? "").trim() });
      i++;
      continue;
    }
    const item = line.match(LIST);
    if (item) {
      const ordered = /\d/.test(item[1] as string);
      const items: string[] = [];
      while (i < lines.length) {
        const m = (lines[i] as string).match(LIST);
        if (m && /\d/.test(m[1] as string) === ordered) {
          items.push(m[2] ?? "");
          i++;
        } else if (items.length && /^\s{2,}\S/.test(lines[i] as string)) {
          items[items.length - 1] += `${join}${(lines[i++] as string).trim()}`;
        } else break;
      }
      out.push({ type: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] as string;
      if (!l.trim() || /^(#{1,6})\s|^\s*```|^\s*>/.test(l) || LIST.test(l)) break;
      para.push(l.trim());
      i++;
    }
    out.push({ type: "paragraph", text: para.join(join) });
  }
  return out;
}

// Code, bold, italic (not inside words, so `snake_case` and URLs stay as typed), links, bare URLs,
// wiki links, ~~strikethrough~~.
const INLINE =
  /(`[^`]+`)|(\*\*[^*]+?\*\*|__[^_]+?__)|((?<![\w*])\*[^*\s][^*]*?\*(?![\w*])|(?<![\w_])_[^_\s][^_]*?_(?![\w_]))|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|(\[\[[^[\]\n]+\]\])|(~~[^~\s](?:[^~]*?[^~\s])?~~)/;
const SAFE_URL = /^(https?:|mailto:)/i;
/** Same rule as the backend (`parseMentionHandles`): emails are not mentions. */
const MENTION = /(^|[^\w@.])@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?![\w@-])/g;

export type MentionRenderer = (handle: string, key: string) => ReactNode;
/** `[[Título]]` or `[[Título|texto]]`: how a wiki link shows (a chip, a dashed missing link…). */
export type WikiLinkRenderer = (title: string, label: string, key: string) => ReactNode;
/** `![[foto.png]]`: how an embed shows (`block` alone on its line, else inside a sentence). */
export type EmbedRenderer = (target: string, key: string, block: boolean) => ReactNode;

/** `[[Processos/Onboarding|o onboarding]]` → { title: "Processos/Onboarding", label: "o onboarding" }. */
export function parseWikiToken(token: string) {
  const inner = token.slice(2, -2);
  const bar = inner.indexOf("|");
  const title = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim() || title;
  return { title, label };
}

/** Every `[[link]]` title in a text, in order, without repeats. */
export function wikiLinksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<!!)\[\[([^[\]\n]+)\]\]/g)) {
    const { title } = parseWikiToken(m[0]);
    if (title && !out.includes(title)) out.push(title);
  }
  return out;
}

/** Heading anchor ids for the outline: "Como pedimos acesso" → "como-pedimos-acesso". */
export const headingId = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function withMentions(text: string, key: string, mention?: MentionRenderer): ReactNode[] {
  if (!mention) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(MENTION)) {
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    if (start > last) out.push(text.slice(last, start));
    out.push(mention(m[2] ?? "", `${key}-m${n++}`));
    last = start + 1 + (m[2]?.length ?? 0);
  }
  if (last < text.length) out.push(text.slice(last));
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
): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = rest.match(INLINE);
    if (!m || m.index === undefined) {
      out.push(...withMentions(rest, `${key}-t${n}`, mention));
      break;
    }
    const tok = m[0];
    const k = `${key}-${n++}`;
    // `![[…]]` inside a sentence: the "!" belongs to the embed.
    const isEmbed = Boolean(m[6] && embed && m.index > 0 && rest[m.index - 1] === "!");
    const before = rest.slice(0, isEmbed ? m.index - 1 : m.index);
    if (before) out.push(...withMentions(before, `${key}-t${n}`, mention));
    if (isEmbed && embed) {
      out.push(embed(parseWikiToken(tok).title, k, false));
      rest = rest.slice(m.index + tok.length);
      continue;
    }
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{renderInline(tok.slice(2, -2), k, mention, wiki, embed)}</strong>);
    else if (m[3]) out.push(<em key={k}>{renderInline(tok.slice(1, -1), k, mention, wiki, embed)}</em>);
    else if (m[7]) out.push(<del key={k}>{renderInline(tok.slice(2, -2), k, mention, wiki, embed)}</del>);
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

export function Markdown({ source, variant = "document", mention, wikiLink, embed, title }: MarkdownProps) {
  const message = variant === "message";
  const inline = (text: string, k: string) => renderInline(text, k, mention, wikiLink, embed);
  const parsed = parseMarkdown(source, { breaks: message });
  const [first] = parsed;
  if (title && first?.type === "heading" && first.level === 1 && first.text.trim() === title.trim()) parsed.shift();
  const blocks = parsed.map((b, i) => {
    const k = `b${i}`;
    switch (b.type) {
      case "heading": {
        if (message) {
          return (
            <p key={k}>
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
      case "code":
        return (
          <pre key={k} className="md__code">
            <code>{b.text}</code>
          </pre>
        );
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
                    <th key={j}>{inline(h, `${k}-h${j}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static table
                  <tr key={j}>
                    {r.map((c, x) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: static table
                      <td key={x}>{inline(c, `${k}-${j}-${x}`)}</td>
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
  return message ? <div className="md md--message">{blocks}</div> : <div className="md">{blocks}</div>;
}
