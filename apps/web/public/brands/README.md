# Brand logos

The marks on the agent import's cards (`CARD_MARK` in `apps/web/src/lib/import-flow.ts`). Each is the project's own logo, taken from its repository at the commit named or from its maker's own page. The SVGs keep only the drawing (no scripts, styles or links), scaled to a 24×24 view box. A `-dark` file is the project's own coloring for a dark background, shown when the app's theme is dark.

| File | Project | Source | License |
|---|---|---|---|
| `grok-bot.svg`, `grok-bot-dark.svg` | Grok Bot | The `grok-bot-mark` SVG beside the name in the heading of https://x.ai/bot, as of https://web.archive.org/web/20261026135608/https://x.ai/bot. The page fills the head with its `--primary` color and the eyes with its `--background`: `hsl(0 0% 4%)` and white in its light theme, the other way around in its dark theme (the dark file) | No license: the mark belongs to SpaceXAI LLC and is shown only to name the product |
| `chatgpt-dots.svg` | ChatGPT dots (OpenAI writes "dots" in lowercase) | `dots-o.svg`, the "O" that heads https://openai.com/index/introducing-dots/ (the page's static poster and interactive logo), at https://images.ctfassets.net/kftzwdyauwt9/KKSjto3MtJguvsLQsM1Bp/1704a6937d22b1bb3cac38dc5f43f9df/dots-o.svg, as of https://web.archive.org/web/20261026042422/https://openai.com/index/introducing-dots/. https://chatgpt.com/features/dots draws the same O in the same `#BAC1D3`, on its light surfaces too, so one file serves both themes | No license: the mark belongs to OpenAI and is shown only to name the product |
| `openbotrun.svg` | OpenBot.run | The logo as https://openbot.run draws it, from its shape and colors in https://github.com/nightly-labs/openbot at `1d92ac4` (`packages/brand/src/app-logo-shape.ts`, `tokens.css`, `logo.css`) | The project's code is under the PolyForm Noncommercial License 1.0.0, so none of it is copied here; the mark is shown only to name the project |
| `openmausbot.svg` | OpenMausBot | `public/app-icon.svg` in https://github.com/milind-soni/OpenMausBot at `0d8eacc` | Apache License 2.0; OpenMausBot, Copyright 2026 Milind Soni and OpenMausBot contributors (`LICENSE-OpenMausBot`) |
| `hermes.svg`, `hermes-dark.svg` | Hermes Agent | `assets/nous-girl-black.svg` and `assets/nous-girl-white.svg` in https://github.com/NousResearch/hermes-agent at `ff29484` | MIT License, Copyright (c) 2025 Nous Research (`LICENSE-Hermes`) |
| `openclaw.svg` | OpenClaw | `apps/linux/src-tauri/icons/icon.svg` in https://github.com/openclaw/openclaw at `fdf1127`, the same drawing as https://openclaw.ai/favicon.svg | MIT License, Copyright (c) 2026 OpenClaw Foundation (`LICENSE-OpenClaw`) |
| `paperclip.svg`, `paperclip-dark.svg` | Paperclip | `ui/public/favicon.svg` in https://github.com/paperclipai/paperclip at `5a28f7a`; the dark file has the stroke that file's own dark-mode rule gives it | MIT License, Copyright (c) 2025 Paperclip AI (`LICENSE-Paperclip`). The drawing is Lucide's `paperclip` icon, ISC License (`LICENSE-Lucide`) |

The full license texts are next to the import fixtures, in `apps/web/test/fixtures/agent-import/`.

Two more marks name products elsewhere in the app, each from its maker's own file:

| File | Product | Source | Terms |
|---|---|---|---|
| `postgresql.svg` | PostgreSQL, for the database connector | `PostgreSQL_logo.3colors.svg` from https://wiki.postgresql.org/wiki/Logo (the vector of https://www.postgresql.org/media/img/about/press/elephant.png), in the 24×24 view box. The color mark reads on light and dark, so there is no dark file | The PostgreSQL Trademark Policy (https://www.postgresql.org/about/policies/trademarks/), used only to name the product |
| `gemini.png` | Gemini, where an AI provider is named (`ProviderLogo`) | The icon https://gemini.google.com serves, https://www.gstatic.com/lamda/images/gemini_sparkle_4g_512_lt_f94943af3be039176192d.png, scaled from 512 to 128 px and otherwise unchanged. Google publishes no vector file of the sparkle: its own SVG fills the outline with a raster. The phone ships the same file in `apps/mobile/assets/images/brands/` | Google's brand terms (Google APIs Terms of Service, section 6), used only to name the product |

Each logo is a trademark of its owner, used only to name the project; none of these licenses grants trademark rights.
