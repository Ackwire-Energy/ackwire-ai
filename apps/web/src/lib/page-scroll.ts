/**
 * The page column starts at the top on a new path. Without this the router hands the column's scroll on to the
 * next page: it carries over every scrolled element it isn't told to reset, keyed by the element's place in the DOM,
 * and every page's `main` sits in the same place. A change of search alone (`?open=`, a dialog over a list) keeps
 * the scroll, and Back and Forward still put a page back where it was.
 * `selectors` goes to the router's `scrollToTopSelectors`, `track` to its `onBeforeLoad` event.
 */
export function pageScrollReset() {
  let pathChanged = true;
  return {
    selectors: [() => (pathChanged ? document.querySelector("main.shell__main") : null)],
    track: (e: { pathChanged: boolean }) => {
      pathChanged = e.pathChanged;
    },
  };
}
