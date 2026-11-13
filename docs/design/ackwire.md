# Ackwire AI

Brand reference: `ackwire-website-redesign/DESIGN-SPEC.md` and `src/brand.css`.

Use Ackwire's original A monogram, Solar Green (#90ED42), and Gilroy with the self-hosted Plus Jakarta Sans fallback. The full product name is Ackwire AI in both logo variants. Keep generous spacing and clear sentence-case labels.

The app draws the monogram in its pixel style: the mark itself (`public/assets/logo.svg` in the website's repository) set on a 28×20 grid, its three arched bands with the two slits between them, joined in the rounded feet, in one color (Solar Green on dark, Solar Deep on light). `PIXEL_MARK` in `packages/ui/src/brand/ackwire.ts` is the only drawing: the logo, the favicon (`bun packages/ui/scripts/favicon.ts`), the desktop app's icons (`apps/desktop/scripts/icons.ts`), the phone's icons and the emails' logos all come from it. The agents keep their own pixel faces, in Ackwire green by default.

Dark mode uses true black for the page and work pane, with neutral charcoal elevated surfaces. Do not use Forest Green or green-tinted backgrounds for the app shell. Solar Green is reserved for branding, primary actions and emphasis. Primary actions use Forest Green text (#031F1B) on Solar Green. Light-theme small green text uses the accessible Solar Deep (#3F7A12), with White and Celadon surfaces.

Canonical color tokens remain in `design-system/tokens.css`, mirrored in `packages/ui/src/styles/tokens.css` and `packages/tokens/src/index.ts` for native clients. Preserve semantic warning and error colors.

Package scopes, storage keys and application identifiers retain their upstream values for compatibility. These are separate from the visible product name. The apps' hosted server, the desktop app's update channel and the releases are Ackwire's own (`https://hub.ackwire.app`, ADR 0172).
