/** A docked side pane sits beside the conversation; a narrow window lays it over it (`.thread-panel--docked`). */
export function coversConversation(inPane: Element | null) {
  const pane = inPane?.closest(".thread-panel");
  return Boolean(pane) && ["absolute", "fixed"].includes(getComputedStyle(pane as Element).position);
}
