import { useSyncExternalStore } from "react";

const active = () => document.visibilityState === "visible" && document.hasFocus();

function subscribe(changed: () => void) {
  window.addEventListener("focus", changed);
  window.addEventListener("blur", changed);
  document.addEventListener("visibilitychange", changed);
  return () => {
    window.removeEventListener("focus", changed);
    window.removeEventListener("blur", changed);
    document.removeEventListener("visibilitychange", changed);
  };
}

/** The person is on this tab now: it shows, and its window has the focus. */
export const useWindowActive = () => useSyncExternalStore(subscribe, active);
