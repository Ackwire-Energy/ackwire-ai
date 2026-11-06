/** `text` with each pill's words, in order, replaced by its address; one only half selected stays as it reads. */
export function withPillAddresses(text: string, pills: readonly { text: string; href: string }[]): string {
  let out = "";
  let at = 0;
  for (const pill of pills) {
    const found = text.indexOf(pill.text, at);
    if (found < 0) continue;
    out += text.slice(at, found) + pill.href;
    at = found + pill.text.length;
  }
  return out + text.slice(at);
}

/** Selected text copied with a link pill in it says the full address, as the message was written. */
export function copyPillAddresses(e: ClipboardEvent) {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !e.clipboardData) return;
  const pills = Array.from(document.querySelectorAll<HTMLAnchorElement>("a.link-pill")).filter((a) =>
    selection.containsNode(a, true),
  );
  if (pills.length === 0) return;
  e.clipboardData.setData(
    "text/plain",
    withPillAddresses(
      selection.toString(),
      pills.map((a) => ({ text: a.textContent ?? "", href: a.getAttribute("href") ?? "" })),
    ),
  );
  e.preventDefault();
}
