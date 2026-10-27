# Brand logos

The logos of the three apps the onboarding's "Bring your agents" step names, the same official files the web app ships in `apps/web/public/brands/` (its README has each file's source and license). The phone draws images, not SVG files, so each SVG is rendered at 96 px (on a Mac: `sips -s format png -z 96 96 <name>.svg --out <name>.png`):

- `grok-bot.png`, `grok-bot-dark.png`: `grok-bot.svg` and `grok-bot-dark.svg` (the dark one where the app's theme is dark)
- `chatgpt-dots.png`: `chatgpt-dots.svg`
- `openbotrun.png`: `openbotrun.svg`

Each logo is a trademark of its owner, used only to name the project.
