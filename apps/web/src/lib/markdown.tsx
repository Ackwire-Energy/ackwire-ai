import type { ReactNode } from "react";

/**
 * A small, safe Markdown renderer for artifact documents: headings,
 * paragraphs, lists, quotes, rules, GFM tables, fenced code (mono), inline
 * code, bold, italic and links. It builds React elements only: raw HTML in the
 * source is shown as text, never interpreted. Links allow http(s) and mailto.
 */
export type MdBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "rule" }
  | { type: "table"; header: string[]; rows: string[][] };

const LIST = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function parseMarkdown(source: string): MdBlock[] {
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
      out.push({ type: "quote", text: body.join(" ") });
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
          items[items.length - 1] += ` ${(lines[i++] as string).trim()}`;
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
    out.push({ type: "paragraph", text: para.join(" ") });
  }
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+?\*\*|__[^_]+?__)|(\*[^*\s][^*]*?\*|_[^_\s][^_]*?_)|(\[[^\]]+\]\([^)\s]+\))/;
const SAFE_URL = /^(https?:|mailto:)/i;

export function renderInline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = rest.match(INLINE);
    if (!m || m.index === undefined) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{renderInline(tok.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{renderInline(tok.slice(1, -1), k)}</em>);
    else {
      const link = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const href = link?.[2] ?? "";
      out.push(
        SAFE_URL.test(href) ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer" className="ac-link">
            {renderInline(link?.[1] ?? "", k)}
          </a>
        ) : (
          tok
        ),
      );
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="md">
      {parseMarkdown(source).map((b, i) => {
        const k = `b${i}`;
        switch (b.type) {
          case "heading": {
            const H = `h${Math.min(6, b.level + 1)}` as "h2";
            return <H key={k}>{renderInline(b.text, k)}</H>;
          }
          case "paragraph":
            return <p key={k}>{renderInline(b.text, k)}</p>;
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
                {b.items.map((item, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list
                  <li key={j}>{renderInline(item, `${k}-${j}`)}</li>
                ))}
              </L>
            );
          }
          case "quote":
            return <blockquote key={k}>{renderInline(b.text, k)}</blockquote>;
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
                        <th key={j}>{renderInline(h, `${k}-h${j}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: static table
                      <tr key={j}>
                        {r.map((c, x) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: static table
                          <td key={x}>{renderInline(c, `${k}-${j}-${x}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
        return null;
      })}
    </div>
  );
}
