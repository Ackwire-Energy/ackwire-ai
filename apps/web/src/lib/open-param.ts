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

/**
 * `validateSearch` for a page with an open item. A number (an issue's) stays a
 * number: the router JSON-quotes a string that reads as one (`?open=%22131%22`),
 * so a digits-only string becomes a number too. Anything else stays a string.
 */
export function openSearch(search: Record<string, unknown>): { open?: string | number } {
  const v = search.open;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? { open: v } : {};
  if (typeof v !== "string" || !v) return {};
  return /^\d{1,15}$/.test(v) ? { open: Number(v) } : { open: v };
}
