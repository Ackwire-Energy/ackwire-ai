# Brand logos

The marks of the projects the agent import reads (`SOURCE_MARK` in `apps/web/src/lib/import/index.ts`). Each is the project's own logo file, taken from its repository at the commit named. The SVGs keep only the drawing (no scripts, styles or links), scaled to a 24×24 view box. A `-dark` file is the project's own coloring for a dark background, shown when the app's theme is dark.

| File | Project | Source | License |
|---|---|---|---|
| `openclaw.svg` | OpenClaw | `apps/linux/src-tauri/icons/icon.svg` in https://github.com/openclaw/openclaw at `fdf1127`, the same drawing as https://openclaw.ai/favicon.svg | MIT License, Copyright (c) 2026 OpenClaw Foundation (`LICENSE-OpenClaw`) |
| `hermes.svg`, `hermes-dark.svg` | Hermes Agent | `assets/nous-girl-black.svg` and `assets/nous-girl-white.svg` in https://github.com/NousResearch/hermes-agent at `ff29484` | MIT License, Copyright (c) 2025 Nous Research (`LICENSE-Hermes`) |
| `openbotrun.svg` | OpenBot.Run | The logo as https://openbot.run draws it, from its shape and colors in https://github.com/nightly-labs/openbot at `1d92ac4` (`packages/brand/src/app-logo-shape.ts`, `tokens.css`, `logo.css`) | The project's code is under the PolyForm Noncommercial License 1.0.0, so none of it is copied here; the mark is shown only to name the project |
| `paperclip.svg`, `paperclip-dark.svg` | Paperclip | `ui/public/favicon.svg` in https://github.com/paperclipai/paperclip at `5a28f7a`; the dark file has the stroke that file's own dark-mode rule gives it | MIT License, Copyright (c) 2025 Paperclip AI (`LICENSE-Paperclip`). The drawing is Lucide's `paperclip` icon, ISC License (`LICENSE-Lucide`) |
| `openmausbot.svg` | OpenMausBot | `public/app-icon.svg` in https://github.com/milind-soni/OpenMausBot at `0d8eacc` | Apache License 2.0; OpenMausBot, Copyright 2026 Milind Soni and OpenMausBot contributors (`LICENSE-OpenMausBot`) |
| `openbot.png` | OpenBot | `desktop/src-tauri/icons/128x128@2x.png` in https://github.com/CopilotKit/OpenBot, copied unchanged. The project has no vector logo: it draws the mark with CSS gradients | MIT License, Copyright (c) 2026 CopilotKit (`LICENSE-OpenBot`) |

The full license texts are next to the import fixtures, in `apps/web/test/fixtures/agent-import/`.

Two more marks name products elsewhere in the app, each from its maker's own file:

| File | Product | Source | Terms |
|---|---|---|---|
| `postgresql.svg` | PostgreSQL, for the database connector | `PostgreSQL_logo.3colors.svg` from https://wiki.postgresql.org/wiki/Logo (the vector of https://www.postgresql.org/media/img/about/press/elephant.png), in the 24×24 view box. The color mark reads on light and dark, so there is no dark file | The PostgreSQL Trademark Policy (https://www.postgresql.org/about/policies/trademarks/), used only to name the product |
| `gemini.png` | Gemini, where an AI provider is named (`ProviderLogo`) | The icon https://gemini.google.com serves, https://www.gstatic.com/lamda/images/gemini_sparkle_4g_512_lt_f94943af3be039176192d.png, scaled from 512 to 128 px and otherwise unchanged. Google publishes no vector file of the sparkle: its own SVG fills the outline with a raster. The phone ships the same file in `apps/mobile/assets/images/brands/` | Google's brand terms (Google APIs Terms of Service, section 6), used only to name the product |

Each logo is a trademark of its owner, used only to name the project; none of these licenses grants trademark rights.
