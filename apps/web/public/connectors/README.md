# Connector icons

One-color brand icons for the connector catalog: the app draws them as a mask in the brand color (or the ink, for near-black or very light brands). Brand colors live with the catalog in code (`CONNECTOR_BRANDS` in `packages/engine/src/connectors/listing.ts`).

They come from [Simple Icons](https://simpleicons.org) 16.32.0 (CC0 1.0, public domain), except `square.svg`: Square's own mark, the first three subpaths (the mark without the wordmark) of `Black/Square_Logo_2025_Black.svg` in the logo set at https://squareup.com/us/en/press/logo (https://assets.ctfassets.net/2d5q1td6cyxq/3xNJXOyxBSmmJ1lUafqHGJ/0d3bcea3bf9426dbf9a54f424e3d1fab/Square_Logo.zip), unchanged and scaled to the 24×24 view box. Square shows it only in black or white, which the ink gives in each theme. Terms: that page gives its logos, assets and media resources for editorial purposes only, and other uses by permission from press@squareup.com. Square's developer brand page (https://developer.squareup.com/docs/brand-guidelines) offers only 1125×320 "Built with Square" badges, no mark at a tile's size.

A mark in its maker's colors, which a mask would flatten (PayPal's, Canva's, Outlook's), is in `../brands/`. The email cards' marks (Gmail, Outlook, iCloud) and colors live in `apps/web/src/components/MailConnect.tsx`.

Each icon is a trademark of its owner, used only to name the service.
