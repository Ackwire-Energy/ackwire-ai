import type { HelpSlug } from "./index";
import type { HelpDocument } from "./types";

/** The help pages in id: a page not here shows in English. */
export const helpId: Partial<Record<HelpSlug, HelpDocument>> = {};
