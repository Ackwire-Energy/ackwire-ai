# Ackwire AI

Brand reference: `ackwire-website-redesign/DESIGN-SPEC.md` and `src/brand.css`.

Use Ackwire's original A monogram, Solar Green (#90ED42), and Gilroy with the self-hosted Plus Jakarta Sans fallback. The full product name is Ackwire AI in both logo variants. Keep generous spacing and clear sentence-case labels.

Dark mode uses true black for the page and work pane, with neutral charcoal elevated surfaces. Do not use Forest Green or green-tinted backgrounds for the app shell. Solar Green is reserved for branding, primary actions and emphasis. Primary actions use Forest Green text (#031F1B) on Solar Green. Light-theme small green text uses the accessible Solar Deep (#3F7A12), with White and Celadon surfaces.

Canonical color tokens remain in `design-system/tokens.css`, mirrored in `packages/ui/src/styles/tokens.css` and `packages/tokens/src/index.ts` for native clients. Preserve semantic warning and error colors.

Package scopes, storage keys, application identifiers and existing service URLs retain their upstream values for compatibility. These are separate from the visible product name; changing hosted endpoints requires deployment configuration.
