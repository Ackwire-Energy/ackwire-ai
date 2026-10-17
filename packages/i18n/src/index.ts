/**
 * @agenteschat/i18n: the UI strings of the web and phone apps (ADR 0035).
 * pt-BR is the source locale; every other locale is typed against it.
 */
import { en } from "./en";
import { ptBR } from "./pt-BR";

export { en } from "./en";
export { ptBR, type Translations } from "./pt-BR";

/** i18next resources, one namespace (`translation`). */
export const resources = {
  "pt-BR": { translation: ptBR },
  en: { translation: en },
};
