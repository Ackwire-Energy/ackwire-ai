import { useMemo } from "react";
import { API_URL } from "@/config";
import { appHeaders, lastCookie } from "@/lib/auth";
import { type PhotoSource, photoSource } from "@/lib/photo";

/** A person's photo (`avatarUrl` or `image`) as the avatar loads it, with the session when it is ours. */
export function usePersonPhoto(url: string | null | undefined): PhotoSource | null {
  // Stable per URL, so the image isn't fetched again on every render.
  return useMemo(() => photoSource(url, API_URL, appHeaders(lastCookie())), [url]);
}
