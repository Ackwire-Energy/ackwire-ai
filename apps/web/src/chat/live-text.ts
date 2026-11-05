/**
 * A streaming answer is drawn in two parts: the blocks that are done (parsed
 * once, they only change when a new block closes) and the last one, still
 * growing, whose words fade in. The split is the last blank line outside a
 * ``` code fence or a `<details>` block with text after it.
 */

import { DETAILS_CLOSE, DETAILS_OPEN } from "@agenteschat/client/lib/markdown";

const BLANK_LINE = /\n[ \t]*\n/g;

/**
 * Whether `end` is inside a ``` code block or a `<details>` block (one block however many paragraphs it holds, ADR
 * 0147), reading them as the parser does (`parseMarkdown`, `detailsAt`).
 */
function inBlock(text: string, end: number) {
  let fence = false;
  let details = 0;
  for (const line of text.slice(0, end).split("\n")) {
    if (fence ? /^\s*```\s*$/.test(line) : /^\s*```\s*[\w+-]*\s*$/.test(line)) fence = !fence;
    else if (!fence && DETAILS_OPEN.test(line) !== DETAILS_CLOSE.test(line)) {
      if (DETAILS_OPEN.test(line)) details++;
      else if (details > 0) details--;
    }
  }
  return fence || details > 0;
}

export function splitSettled(text: string): { settled: string; tail: string } {
  const boundaries = [...text.matchAll(BLANK_LINE)].map((m) => m.index ?? 0);
  for (let i = boundaries.length - 1; i >= 0; i--) {
    const at = boundaries[i] ?? 0;
    if (inBlock(text, at)) continue;
    const settled = text.slice(0, at).trimEnd();
    const tail = text.slice(at).replace(/^\s*\n/, "");
    if (!settled) break;
    // Nothing after this blank line yet (a paragraph just ended): the split is the one before, so the blocks already
    // settled stay as they are (folding them into the tail would fade their words in again) and the caret keeps text.
    if (!tail.trim()) continue;
    return { settled, tail };
  }
  return { settled: "", tail: text };
}
