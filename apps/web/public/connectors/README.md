# Connector icons

Brand icons for the connector catalog. One single-color SVG per service; the app draws them as a mask in the brand color (or the ink, for near-black, very light or many-colored brands). Brand colors live with the catalog in code (`CONNECTOR_BRANDS`, `packages/engine/src/connectors/listing.ts`), and every connector in the catalog has one (a test checks it).

Most come from [Simple Icons](https://simpleicons.org) 16.32.0 (CC0 1.0, public domain). The ones Simple Icons doesn't have are the brand's own mark, from its site or press kit, reduced to one color: Ahrefs, Amplitude, Attio, Canva, Close, Fireflies, Gamma, Granola, Himetrica, Jam, Jotform, Klaviyo, MillionSend, monday.com and Tally.

Microsoft Outlook is not in Simple Icons (removed at the brand's request), so it keeps the monogram tile. The email cards' colors (Gmail, iCloud) live in `apps/web/src/components/MailConnect.tsx`.

Each icon is a trademark of its owner, used only to name the service.
