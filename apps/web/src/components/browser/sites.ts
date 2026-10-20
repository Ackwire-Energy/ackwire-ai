/** `example.com` or `*.example.com` (the server checks again). */
export const SITE = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,63}$/;

/** "https://www.Example.com/x" → "www.example.com"; "*.example.com" stays. */
export function cleanSite(input: string): string {
  const s = input.trim().toLowerCase();
  const m = /^(?:[a-z]+:\/\/)?([^/?#\s]+)/.exec(s);
  return (m?.[1] ?? s).replace(/:\d+$/, "");
}
