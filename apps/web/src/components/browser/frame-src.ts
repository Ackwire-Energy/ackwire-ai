import { type BrowserFrame, browserFrameDataUrl } from "@agenteschat/client";
import { useEffect, useMemo } from "react";

/** How long a replaced frame's address stays valid: the image showing it has the next one by then. */
const REVOKE_AFTER_MS = 2000;

/**
 * A frame's picture as an image address (ADR 0040 §7.1): its bytes (the frame socket) as a `blob:` URL, decoded by
 * the browser off the main thread with no base64 string in the page; its base64 (the realtime socket) as a `data:`
 * URL. A `blob:` address is freed a moment after the next frame replaced it.
 */
export function useFrameSrc(frame: BrowserFrame | null | undefined): string | null {
  const src = useMemo(() => (frame ? frameUrl(frame) : null), [frame]);
  useEffect(() => {
    if (!src?.startsWith("blob:")) return;
    return () => {
      setTimeout(() => URL.revokeObjectURL(src), REVOKE_AFTER_MS);
    };
  }, [src]);
  return src;
}

/** A frame's picture as an address that stays valid (never freed: for a picture kept across views). */
export function frameUrl(frame: Pick<BrowserFrame, "data" | "jpeg">): string | null {
  if (frame.jpeg) return URL.createObjectURL(new Blob([frame.jpeg], { type: "image/jpeg" }));
  return browserFrameDataUrl(frame);
}
