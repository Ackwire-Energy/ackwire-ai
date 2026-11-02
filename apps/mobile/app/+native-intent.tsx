import { openOwnPage } from "@/features/ai/parts";
import { appLinkFromUrl } from "@/features/links/app-links";
import { rememberLink } from "@/features/links/pending";

/**
 * Every URL the system opens the app with (a universal link / App Link to the website, or `agenteschat://`), before
 * expo-router reads it: the website's address becomes the app's screen (`appLinkFromUrl`), and a page the app has no
 * screen for opens in the browser, the app staying where it was (on its start at launch).
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  try {
    const link = appLinkFromUrl(path);
    if (!link) return path;
    if ("web" in link) {
      openOwnPage(path);
      return initial ? "/" : "";
    }
    // Signed out, the sign-in comes first; the link is opened right after it.
    if (link.href.startsWith("/link?")) rememberLink(link.href);
    return link.href;
  } catch {
    return initial ? "/" : path;
  }
}
