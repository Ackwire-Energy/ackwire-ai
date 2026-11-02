# 0121. Fourteen languages, English as the source

- Status: Accepted (foundation built; translations follow, one language at a time)
- Date: 2026-11-02
- Amends: 0035 (pt-BR was the source and the default; pushes in the device's language)
- Code: `packages/i18n/src/locale.ts` (registry), `load.ts`, `plurals.ts`, `format.ts`, `tree.ts`, `locales/*.json`,
  `glossary.json`, `test/check-locale.ts` (`@agenteschat/i18n/testing`), `test/identical.json`;
  `packages/client/src/lib/grammar.ts`, `locale-sync.ts`; `apps/web/src/i18n/index.ts`,
  `components/LanguageSelect.tsx`; `apps/mobile/src/providers/i18n.ts`, `src/i18n/merge.ts`,
  `src/features/i18n/locales.ts`; `apps/desktop/src/i18n/index.ts`; `packages/engine/src/email/words/*`,
  `push/messages/*`, `organizations.ts` (`setMyLocale`, `myLocale`); `apps/server/src/routes/app/account.ts`;
  `scripts/i18n.ts`; migration `0174_locales.sql`

## Context

The app spoke pt-BR (the source and the default) and English. The product is global: the owner decided on 14
languages everywhere people read us (web, phone, desktop, emails, pushes, server-made text, the landing): en, pt-BR,
es, fr, de, it, nl, ja, ko, zh-Hans, id, tr, pl, ru. No right-to-left language yet.

Every surface already used i18next 26 with react-i18next 17 (the phone adds expo-localization). i18next picks plural
forms with `Intl.PluralRules` (`_zero` … `_other`), supports context (`key_female`) and falls back per key; `Intl`
formats dates, numbers, money, lists and relative times. No new library is needed. A translation service (Weblate is
AGPL and self-hostable) waits for human translators.

## Decision

1. **Registry.** `LOCALES` holds each language's code, native name, English name, Intl tag, week start (CLDR; Firefox
   has no `getWeekInfo`), script and `ready`. Only ready languages are offered and detected; the server accepts every
   code. `appLocale` maps tags (pt-PT → pt-BR, es-MX → es, `in` → id, every Chinese tag → zh-Hans: Traditional Chinese
   has no translation, and Simplified reads closer than English). `intlLocale` keeps the browser's own regional tag
   (en-GB keeps 24 h and day-first dates).
2. **English is the source.** `Strings = Widen<typeof en>` types `t()`. pt-BR keeps its TypeScript file (its comments
   are notes for translators) and every other language is a JSON file; none is typed against English, so a language
   may have `_few`/`_many` or no `_one`. `checkLocale` checks each at test time: keys (missing only fails a ready
   language), plural categories per `Intl.PluralRules`, the same `{{placeholders}}` and tags, nothing empty, nothing
   left in English unless listed in `identical.json`, the glossary's keep-as-is names, no semicolons, the no-break
   spaces of menu paths and closing words (not for ja and zh-Hans). `fillPluralGaps` copies `_other` into `_many`
   (es, fr, it, pt-BR: round millions) and pt-BR's `_zero`.
3. **Loading.** The web and the desktop's site load one language and English (`loadStrings`, one chunk each). The
   phone requires the shared strings lazily (Metro runs a module on first `require`); its own and the desktop's small
   files are in the bundle. i18next: `fallbackLng: "en"`, `supportedLngs: LOCALE_CODES`, `load: "currentOnly"`.
4. **Agent gender is context.** `agentGrammar(name)` returns `{ name, context }` (`female` for names ending in "a");
   every string that agreed with the agent through fragments (`{{The}}`, `{{article}}`, `{{she}}`…) was rewritten
   once into `key` and `key_female`. Sentences about two agents and about providers ("chave do Claude") were rewritten
   without articles; `providerGrammar` is gone.
5. **One language per person.** `users.locale` (emails, pushes) plus `users.locale_auto` (default true). A device
   shows: its own pick not yet sent (signed out), else a language picked anywhere (`locale_auto` false), else its own
   language ("Automático"), telling the server when that differs (`PATCH /api/app/me { locale, auto }`). Before
   sign-in: this device's pick, the landing's `agentes_locale` cookie, the browser's languages, English. Pickers:
   "Automático (detected)" then each language by its own name, in Settings, on the sign-in pages, on the phone's
   Language page and in the desktop's Preferences (a per-computer choice for the desktop shell).
6. **Server text.** Email words per language (`email/words/<code>.ts`, deep-merged over English, counts through
   `plural()`), push words per language over English, pushes in `users.locale` before the device's, the workspace
   computer's default name from the shared strings, dates and money through Intl and the registry, the CJK system
   fonts in the email stack. Jobs queued without a language render in English. A refusal code the app has no words
   for shows the server's English message in every language.
7. **Formatting.** `@agenteschat/i18n/format`: `plural`, `formatList`, `formatMoneyUsd`, `formatDate`, `formatTime`,
   `relativeTime`, `dayMonthOrder`. No case change on translated text (a lowercase form is its own key) and no two
   `t()` glued with a space (`common.joinSentences`); guards in the web's and the phone's tests.
8. **Fonts.** No web font download: Japanese, Korean and Chinese use each system's face after the Latin one, no
   `font-size-adjust`, strict line breaks, no italics; the desktop's Russian titles use Onest (Funnel Display has no
   Cyrillic). Linux packages recommend `fonts-noto-cjk`. PDFs with CJK need embedded fonts (a follow-up).
9. **Translating.** `bun run i18n:missing <code>` lists what a language lacks with its notes, placeholders, plural
   forms and feminine variant; `i18n:apply` merges a translated file after `checkLocale`; `i18n:status` shows each
   language's share per surface. A reviewer sets `ready: true`. Machine translation only with that review.

## Consequences

- Every new string is written in English first; a pt-BR string is a translation like the others.
- A language not ready is still accepted everywhere and shows English for what it lacks.
- pt-BR's defaults changed to English for people with no language (old email jobs, the waiting list's default).
- Open: Traditional Chinese readers get Simplified; Spanish register; whether Terms and Privacy translations ship
  before a lawyer reads them (each carries "English prevails"); help pages on the landing; the app host's
  `robots.txt` and 404s for files (research findings awaiting approval); PDF fonts.
