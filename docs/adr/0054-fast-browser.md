# 0054. A fast browser: plans in one call, targets in words, a judge that checks, one layer for computer use

- Status: Proposed
- Date: 2026-10-23
- Planning: D84
- Builds on: ADR 0040 (the agent browser on `agent-browser`), ADR 0031 (computer use), ADR 0032 (one engine, the runner as a bridge), ADR 0053 (who is behind a run, the policy table)
- Changes in ADR 0040: §5 (tools answer with what changed; targets in words) and the "later" row "Intent tools with Jev", done here in another shape
- Code: `packages/engine/src/screen/*` (the layer), `browser/surface.ts`, `browser/tools.ts`, `judge.ts` (images, Box), runner `browser.ts` (`browser.batch`, `browser.capture`), protocol 17

## Context

### Where the time goes today

Every page action of an agent costs two turns of its own model. The agent reads the page (`browser_read`, up to 40,000 characters), picks an element number, calls `browser_click`, and the tool answers "Clicked. Read the page to see the result". The agent reads again before it decides anything. A sign-in (open, read, fill, type the password, click, read) is six model turns and two full pages in the context.

- A turn of a frontier model on a browser task takes 3–9 s: Navi-Bench measures 6.2–9.0 s per step for computer-use models, and Browser Use's own model about 3 s ([Yutori n1](https://yutori.com/blog/introducing-n1), [browser-use](https://browser-use.com/posts/speed-matters)).
- In desktop agents, planning and reflection by the big model take 75–94% of the task time. Grounding takes 3–6%, screenshots 1–4% and executing actions 1–2% ([arXiv 2506.16042](https://arxiv.org/html/2506.16042v1)).
- Every command is also a round trip from our server to the runner on the person's computer (one `browser.act`, one `agent-browser` process). The look after an action, a wait and a settle check would be three more round trips.

The lever is fewer turns of the big model and a smaller context, not faster clicks.

### What others do (October 2026)

- **State with each action.** Playwright MCP returns a snapshot after every action, and the Anthropic and OpenAI computer-use loops attach the screen to the action's result ([Playwright MCP](https://github.com/microsoft/playwright-mcp), [Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)). Full state every time bloats the context: Skyvern 3.0 got 2.3× faster by sending less, not more ([Skyvern](https://www.skyvern.com/blog/deleting-rag-from-our-web-agent-made-it-2-3x-faster/)).
- **Several actions per turn.** browser-use runs up to 5 actions per step "until the page changes" ([docs](https://docs.browser-use.com/open-source/customize/agent/all-parameters.md)). UFO2 plans several actions in one call and halved its steps on OSWorld-W ([arXiv 2504.14603](https://arxiv.org/html/2504.14603v2)). OpenAI's `computer_call` returns an ordered list of actions.
- **A small model for grounding.** Magnitude pairs a big planner with Moondream as the executor, and Surfer-H pairs one with Holo1 as localizer and validator (92.2% on WebVoyager at a quarter of the cost) ([Holo1](https://huggingface.co/Hcompany/Holo1-7B)).
- **Verification.** Skyvern's validator, which catches false "added to cart" successes, added 17 points ([Skyvern 2.0](https://www.skyvern.com/blog/skyvern-2-0-webvoyager-benchmark-results/)). Pass/fail judges are noisy; graded answers and escalation help ([browser-use](https://browser-use.com/posts/benchmark-behind-the-benchmark)).
- **Caching known flows.** Stagehand caches actions behind a DOM hash and self-heals once ([caching](https://browserbase.com/changelog/stagehand-caching)). Blind replay misfires; only verified programs should replay ([arXiv 2606.17929](https://arxiv.org/html/2606.17929)).
- **Set-of-marks** doesn't help a web agent plan ([SeeAct](https://arxiv.org/abs/2401.01614)). It is useful to map a vision model's answer onto an element.
- **OpenMausBot and OpenBot** (our two references) use Jev for one decision only, who answers in a room. OpenMausBot lists "browser clicks, tool selection and where work runs" as "coming soon". Neither has targets in words, checks, or plans. Skyvern looked at "system one models like Jev" and found that version limited (64K context, no images).

Vendor numbers come from different harnesses and judges. They show a direction, not a measurement of ours.

### What `agent-browser` 0.39.1 and Jev give us

- **`agent-browser` 0.39.1:**
  - `snapshot --json` returns the page text plus a `refs` map (role and name per ref). Refs survive same-document changes.
  - `batch` runs several commands in one process.
  - `screenshot --annotate` numbers the interactive elements and returns each one's box (CSS pixels).
  - `mouse move/down/up` clicks a point.
  - `eval` awaits a promise.
  - A covered click fails before dispatch and names the element in the way.
- **TypeSafe Jev:**
  - **Choice:** over up to 255 options.
  - **Noul:** a calibrated probability.
  - **Many questions on one state, in one request:** 13 questions over a 54,000-character article took 0.27 s and cost $0.0005 ([cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md)). The price is $0.042 per million input tokens, and output is free.
  - **Images and Box:** take still images and **Box**, the box of a target on an image (`jev-1.14.0`/`jev-preview`, with the `TypeSafe-Danger-Zone-Images` header). These are "Dreamer-ready": not called production-ready yet.

## Decision

### 1. A screen layer, not a browser feature (`packages/engine/src/screen/`)

One layer does observe → find → act → check, over a `ScreenSurface`:

- `observe()`: the screen as text, one node per line, with refs.
- `perform(action, { settle })`: one action, then waiting for the screen to settle and looking again.
- `capture()`: an image with marked elements, when the surface can take one.

The browser is the first surface (`browser/surface.ts`). A desktop surface fills the same interface later, from the OS accessibility tree and screenshots, with mouse and keyboard. Targets, checks, plans and reports are reused as they are; that is the way into computer use (ADR 0031).

### 2. Targets in words, cheapest first (`targets.ts`)

The agent names what it acts on, as a number (`e12`) or in words ("the Sign in button", "Edit in the row for invoice 42"):

1. **A ref**, as given. The browser checks it; a stale one fails and says so.
2. **Exactly one element with that name** and a fitting role, preferring a control over text with the same name (the heading "Sign in" next to the button). No judge.
3. **The target memory:** what the same words found on the same page of the same site before, kept per agent (an LRU in the process, by host and generalized path, `/orders/:id`). It is found again by role and name.
4. **The judge** picks among the page's fitting elements: only fields for a fill, boxes for a tick. Each element is described with where it sits (`button "Delete" — in row "Invoice 42"`). One request carries a Choice over refs (plus "none") and a Noul for whether it's there at all. Rules:
   - The pick is taken at p ≥ 0.55, at least 0.2 ahead of the next.
   - An element whose wrong pick costs (pay, delete, send, confirm…) needs 0.85.
   - Below that, the three closest go back to the agent, which picks by number.
5. **An image of the page** (`browser.capture`, protocol 17), when the text has nothing that fits: an icon without a name, a canvas. The judge boxes the target and confirms it's there (≥ 0.6). A box over most of the image is refused. The point lands on a marked element's ref when there is one, so the action stays as exact as a ref; otherwise it is a click at the point. Passwords are only typed into elements found on the page, never at a point.

### 3. Every action answers with what changed

After an action the runner waits until the page has settled:

- the DOM has been quiet for 150 ms (at most 2 s, `eval` of a `MutationObserver`);
- the document has loaded (`wait --load domcontentloaded`, at most 8 s, tolerated);
- the DOM is quiet again, for a navigation that started late.

Then it looks once (`snapshot -c`). The tool answers with:

- **on the same page:** the lines added and removed, counted from what the agent last saw (up to 3,500 characters);
- **on a new page:** what can be acted on, meaning lines with a ref plus headings, dialogs and alerts (up to 6,000 characters);
- **in both cases:** the address.

Page text stays inside the untrusted `page_content` block. `browser_open` answers with the new page's controls, so the agent acts at once. `browser_read` is for reading text. With `find` it returns only the lines that answer a question ("the order total"), with three lines of context: a Choice per window of 200 lines and a Noul over the whole page, in one request.

### 4. Plans: `browser_do`

`browser_do({ steps })` takes up to 15 steps: open, click, fill, select, check, uncheck, press, type_secret, scroll, hover, wait, back. Each step's target is found on the page as it is at that moment, so a plan crosses pages whose elements the agent never saw. A step may carry `expect` ("signed in", "the cart has 2 items"); the judge checks it on the settled page (≥ 0.6 true, < 0.35 false, unsure counts as not shown).

The plan stops at the first step that fails, can't find its target, or doesn't show what it expected. It answers with:

- what ran;
- where it stopped and why, with the closest elements when a target wasn't clear;
- the page at the end.

A person taking over the browser stops the plan before its next step, and the run waits on them as before. The single tools (`browser_click`, `browser_fill`…) are one-step plans: the same finding, settling and answer.

`wait` takes `until` in words ("the export finished"). It is polled about every 0.7 s, and the judge looks again only when the page changed (a fingerprint of the snapshot).

### 5. A banner in the way

When a click fails because something covers its target, the plan looks once. The judge picks the control that only closes it: Close, ×, Not now, Reject optional cookies. Never one that buys, subscribes, accepts terms or grants anything. The pick is taken at ≥ 0.7; then the step runs again. This happens once per plan, and the report says what was closed.

### 6. One round trip per action (protocol 17)

- **`browser.batch`:** several `browser.act` commands back to back in the agent's session, with nothing else in between. Each command goes through the same checks: known command, no flag the runner sets, paths in the agent's folder, URLs on the allowed sites, the allowlist checked after each action. A command that wouldn't pass refuses the whole batch before anything runs. A failure stops it unless the command tolerates failing (the settle and load waits).
- **`browser.capture`:** `screenshot --annotate` as a JPEG (quality 70), read and deleted at once. It returns the image's size, the page's size in CSS pixels and the numbered elements with their boxes.

Older runners get the same commands one `browser.act` at a time, and no images. Everything else works.

### 7. The judge sees images (`judge.ts`)

`JudgeRequest.images` (placeholder → JPEG or PNG) and Box questions go to Jev's vision model, with the images header:

- **Model:** `JEV_VISION_MODEL`, default `jev-preview`. The release can change without code; 1.14 takes images.
- **Timeout:** 6 s.
- **Size limits:** the runner's 1280×800 window fits Jev's limits (each side 280–1568 px). An image outside them isn't sent.
- **Fallback:** the org's cheap model refuses images and boxes. A target the text lacks is then reported as not found.

Text questions keep `jev-latest`, with the cheap model as fallback.

### 8. Safety

- **The judge only points:** at something already on the page, or says whether something is true there. It never grants anything, and an approval is still the agent's to ask for (`ask_user`). Element names it reads are page text; the costly-pick threshold and the dismiss rule keep a hostile name from turning into a payment or a consent.
- **Secrets:** `type_secret` is typed by the runner from what `request_secret` delivered, only on the site the person answered for, and only into a password or one-time-code field found on the page.
- **Routines:** the policy table (ADR 0053) applies to `browser_do` as to every browser tool: `browser:use` is an internal area, refused to "only look" routines.

### 9. Cost and what is recorded

- **Usage and cost:** every judge call is recorded with `org_id` and `agent_id` like the other judgments (kind `router`, provider `typesafe`). A target costs about one tenth of a cent. A plan's report carries each step's time (`data.timing`).
- **The chat's trail:** each step goes on the trail as the tool it stands for (`meta.browser.steps`), so the card of where the agent browsed is unchanged.

### Expected effect (an estimate, not a measurement)

| | Today | With this |
|---|---|---|
| Sign-in (open, email, password, click) | 6 model turns, 2 full reads in context | 1 turn (`browser_do` with `expect`) |
| Time, at 3–8 s per turn | 18–48 s | 1 turn + 4 steps × (0.2–0.6 s runner + 0–0.35 s judge) ≈ 5–12 s |
| Each action on protocol 17 | 1 round trip, then a read turn | 1 round trip, the change in the answer |

## Order

| Stage | What | Difficulty |
|---|---|---|
| 1. Done in this PR | Screen layer, judge with images, targets in words, settle and changes, `browser_do`, `find`, `until`, banner dismiss, protocol 17 runner ops, tests | Medium |
| 2. Eval gate | ADR 0040's 20 pages × 5 targets with real Jev: accuracy of each threshold, vision on icons, cost and time per target. Thresholds move only on that. | Easy |
| 3. Desktop app release | Runner 17 in the Mac app (batch and images); until then, one round trip per command | Easy |
| 4. Verified replay | A plan that worked is kept per site with each step's role and name and its `expect`; a routine replays it with no judge and stops at the first difference. Payments and sends never replay. | Medium |
| 5. Prompt cache | A stable prefix (ADR 0050), so the turns that remain start fast | Medium |
| 6. Desktop surface | The same layer on the OS accessibility tree and screenshots (ADR 0031) | Hard |

Also worth trying, each when measured:

- warming the agent's Chrome when the judge loads the browser tools for a run;
- `snapshot --delta` on the runner instead of our diff;
- zooming into a region before a Box on small targets.

## Consequences

- An agent signs in, fills a form or checks a dashboard in one or two turns of its model instead of six or more, on any model.
- Targets in words work across pages the agent never read. Numbers still work and are the way for anything costly.
- A judge call sits between the agent and many actions. When it is unsure, the agent gets the closest elements instead of a guess, and a wrong pick is caught by the step's `expect` or the next look.
- Vision depends on a preview feature of Jev. It is off when the runner is older or Jev isn't configured, and everything else works without it.
- Runner protocol 17: the Mac app needs a release for the one-round-trip path and images.
- The same layer is the base for desktop computer use.
