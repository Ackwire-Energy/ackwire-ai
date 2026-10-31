/** `2.3 MB`, `12 KB`, `512 bytes`, `50.0 GB`: sizes in the English agents read. */
export function formatBytes(n: number) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Levenshtein distance: the fewest one-character insertions, deletions or substitutions from `a` to `b`. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, sub));
    }
    prev = row;
  }
  return prev[b.length] as number;
}
