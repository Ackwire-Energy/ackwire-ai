/**
 * A streaming answer is drawn in two parts: the blocks that are done (parsed
 * once, they only change when a new block closes) and the last one, still
 * growing, whose words fade in. The split is the last blank line outside a
 * ``` code fence.
 */

const BLANK_LINE = /\n[ \t]*\n/g;

/** How many ``` fences open or close before `end` (odd: `end` is inside a code block). */
function fencesBefore(text: string, end: number) {
  let n = 0;
  for (const line of text.slice(0, end).split("\n")) if (/^\s*```/.test(line)) n++;
  return n;
}

export function splitSettled(text: string): { settled: string; tail: string } {
  const boundaries = [...text.matchAll(BLANK_LINE)].map((m) => m.index ?? 0);
  for (let i = boundaries.length - 1; i >= 0; i--) {
    const at = boundaries[i] ?? 0;
    if (fencesBefore(text, at) % 2 === 1) continue;
    const settled = text.slice(0, at).trimEnd();
    const tail = text.slice(at).replace(/^\s*\n/, "");
    // Nothing after the last blank line yet: the caret stays on a block of its own text.
    if (!tail.trim() || !settled) return { settled: "", tail: text };
    return { settled, tail };
  }
  return { settled: "", tail: text };
}
