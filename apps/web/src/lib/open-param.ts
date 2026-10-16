import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";

/**
 * The item a list page has open in its details dialog, kept in the URL
 * (`?open=…`) so a reload, a shared link or Back reopens it. Replaces the
 * history entry: opening and closing details isn't a page of its own.
 * Numbers (an issue's) go as numbers, so the URL reads `?open=6`.
 */
export function useOpenParam(name = "open"): [string | null, (value: string | number | null) => void] {
  const value = useRouterState({
    select: (s) => {
      const v = (s.location.search as Record<string, unknown>)[name];
      return v === undefined || v === null || v === "" ? null : String(v);
    },
  });
  const navigate = useNavigate();
  const set = useCallback(
    (next: string | number | null) =>
      void navigate({
        to: ".",
        replace: true,
        search: ((prev: Record<string, unknown>) => {
          const out = { ...prev };
          if (next === null) delete out[name];
          else out[name] = next;
          return out;
        }) as never,
      }),
    [navigate, name],
  );
  return [value, set];
}

/** `validateSearch` for a page with an open item: keeps `open` (a string or a number such as an issue's). */
export function openSearch(search: Record<string, unknown>): { open?: string } {
  const v = search.open;
  return typeof v === "string" && v ? { open: v } : typeof v === "number" ? { open: String(v) } : {};
}
