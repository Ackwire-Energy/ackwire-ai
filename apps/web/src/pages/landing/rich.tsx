import { Mention } from "@agenteschat/ui";
import { Fragment, useMemo } from "react";

/**
 * Translated sample text with a few tags: <b>, <code> and <m> (a mention).
 * Split into tokens (a word with its space, or a whole tag) so agents can
 * "type" it token by token.
 */
export interface RichToken {
  id: number;
  tag: "b" | "code" | "m" | null;
  text: string;
}

const TAG = /<(b|code|m)>([\s\S]*?)<\/\1>/g;
const WORD = /\S+\s*|\s+/g;

export function tokenize(source: string): RichToken[] {
  const out: RichToken[] = [];
  const pushText = (text: string) => {
    for (const w of text.match(WORD) ?? []) out.push({ id: out.length, tag: null, text: w });
  };
  let last = 0;
  for (const m of source.matchAll(TAG)) {
    const at = m.index ?? 0;
    pushText(source.slice(last, at));
    out.push({ id: out.length, tag: m[1] as RichToken["tag"], text: m[2] ?? "" });
    last = at + m[0].length;
  }
  pushText(source.slice(last));
  return out;
}

export const tokenCount = (source: string) => tokenize(source).length;

/** Renders rich sample text; `upto` shows only the first tokens (typing). */
export function RichText({ text, upto }: { text: string; upto?: number }) {
  const tokens = useMemo(() => tokenize(text), [text]);
  const shown = upto === undefined ? tokens : tokens.slice(0, upto);
  return (
    <>
      {shown.map((tk) =>
        tk.tag === "b" ? (
          <b key={tk.id}>{tk.text}</b>
        ) : tk.tag === "code" ? (
          <code key={tk.id}>{tk.text}</code>
        ) : tk.tag === "m" ? (
          <Mention key={tk.id}>{tk.text}</Mention>
        ) : (
          <Fragment key={tk.id}>{tk.text}</Fragment>
        ),
      )}
    </>
  );
}
