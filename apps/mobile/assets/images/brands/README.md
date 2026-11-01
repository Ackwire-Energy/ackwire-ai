# Brand logos

The logos of the apps agents are imported from (the onboarding's "Bring your agents" step and Create agent's import step), the same official files the web app ships in `apps/web/public/brands/` (its README has each file's source and license). The phone draws images, not SVG files, so each SVG is rendered at 96 px (on a Mac: `sips -s format png -z 96 96 <name>.svg --out <name>.png`):

- `grok-bot.png`, `grok-bot-dark.png`: `grok-bot.svg` and `grok-bot-dark.svg` (the dark one where the app's theme is dark)
- `chatgpt-dots.png`: `chatgpt-dots.svg`
- `openbotrun.png`: `openbotrun.svg`
- `openmausbot.png`: `openmausbot.svg`
- `hermes.png`, `hermes-dark.png`: `hermes.svg` and `hermes-dark.svg`
- `openclaw.png`: `openclaw.svg`
- `paperclip.png`, `paperclip-dark.png`: `paperclip.svg` and `paperclip-dark.svg`

`gemini.png` is Gemini's mark for `ProviderLogo`, the web's `gemini.png` byte for byte (its source and terms are in that README).

Each logo is a trademark of its owner, used only to name the project.
