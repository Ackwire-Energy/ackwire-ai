import type { HelpSlug } from "./index";
import type { HelpDocument } from "./types";

/** The help pages in it: a page not here shows in English. */
export const helpIt: Partial<Record<HelpSlug, HelpDocument>> = {};
