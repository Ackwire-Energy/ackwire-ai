/**
 * A streaming answer is drawn in two parts: the blocks that are done (parsed
 * once, they only change when a new block closes) and the last one, still
 * growing, whose words fade in. The split is the last blank line outside a
 * ``` code fence with text after it.
 */

const BLANK_LINE = /\n[ \t]*\n/g;

/** Whether `end` is inside a ``` code block, reading fences as the parser does (`parseMarkdown`). */
function inFence(text: string, end: number) {
  let open = false;
  for (const line of text.slice(0, end).split("\n"))
    if (open ? /^\s*```\s*$/.test(line) : /^\s*```\s*[\w+-]*\s*$/.test(line)) open = !open;
  return open;
}

export function splitSettled(text: string): { settled: string; tail: string } {
  const boundaries = [...text.matchAll(BLANK_LINE)].map((m) => m.index ?? 0);
  for (let i = boundaries.length - 1; i >= 0; i--) {
    const at = boundaries[i] ?? 0;
    if (inFence(text, at)) continue;
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
