import { featureKeysEn } from "../i18n/keys.en";

export type EmptyPlace = keyof typeof featureKeysEn.empty;

/**
 * The words of a place with nothing in it yet: what it gives and, when a person can't take the first step and the
 * place has words for them, a title they can use and who does it. The button is the screen's, shown only when `acts`.
 */
export function firstUseCopy(place: EmptyPlace, acts: boolean) {
  const viewer = !acts && "viewerTitle" in featureKeysEn.empty[place];
  return {
    title: `mobile.empty.${place}.${viewer ? "viewerTitle" : "title"}`,
    text: `mobile.empty.${place}.${viewer ? "viewerText" : "text"}`,
  } as const;
}
