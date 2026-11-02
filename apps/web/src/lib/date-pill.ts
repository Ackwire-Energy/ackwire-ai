/** How long the floating date stays once scrolling stops. */
export const DATE_PILL_IDLE_MS = 1200;

/**
 * The day of what is at the top of a scrolled list: the last day divider (`[data-day]`) at or above the list's top
 * edge, else the first one below it (the top is still above the first day's divider), null with none.
 */
export function dayAtTop(list: HTMLElement): string | null {
  const edge = list.getBoundingClientRect().top;
  let day: string | null = null;
  for (const divider of list.querySelectorAll<HTMLElement>("[data-day]")) {
    if (divider.getBoundingClientRect().top > edge + 1) return day ?? divider.dataset.day ?? null;
    day = divider.dataset.day ?? day;
  }
  return day;
}
