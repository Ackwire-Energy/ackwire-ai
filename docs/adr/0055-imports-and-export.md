# 0055. Imports from other apps, and our own export, through one bundle

- Status: Accepted (2026-10-21)
- Date: 2026-10-21
- Extends: ADR 0020 (skills), ADR 0016 (connectors), ADR 0017 (context items), ADR 0019 (SSRF guard)
- Out of scope for now: chat history, a CLI, a scan of `~/.openclaw` / `~/.hermes` on a connected computer, the Manus API, rollback
- Amended 2026-10-31: §8, the agents' own files into the Drive

## Context

The first import brought only the agent persona from OpenMausBot and OpenBot, in onboarding: the browser parsed the files and the page called `POST …/agents` once per agent. Everything else the files carry (skills, rooms, routines, memory) was listed as "left out", and re-running after a reload hit "@x is already taken".

The people we want to bring in keep their agents in files: OpenClaw and Hermes workspaces (`SOUL.md`, `AGENTS.md`, `MEMORY.md`, `memory/*.md`, `skills/*/SKILL.md`, `cron/jobs.json`), Claw packages (`CLAW.md`), Hermes distributions (`distribution.yaml`), Paperclip companies (`COMPANY.md`, `agents/*/AGENTS.md`), OpenMausBot packages and OpenBot tenant packages. A move between our own editions (self-host ↔ Cloud) needs the same thing in the other direction.

## Decision

### 1. One bundle for every source

Every source is parsed into a `MigrationBundle` (`packages/client/src/api/types.ts`, mirrored in `packages/engine/src/imports.ts` and validated by zod at the route):

```
{ format: "agenteschat.bundle", version: 1,
  source: { app, ref, name, files },
  agents[{ key, name, handle, role, instructions, model, appearance, skills[] }],
  skills[{ key, markdown }],            // the whole SKILL.md
  channels[{ key, name, topic, agents[{ key, autoReply }] }],
  routines[{ key, name, agent, prompt, channel, trigger: {cron, timezone} | {rule} | {at} }],
  notes[{ key, agent, kind, title?, content }],
  todo[{ kind, label, url?, agents[] }], leftOut[{ kind, label }] }
```

- Parsers stay pure and run where the person is (their browser), which also unpacks a dropped folder or a `.zip`, `.tar`, `.tar.gz` or `.tgz` archive (`apps/web/src/lib/import/archive.ts`: paths that leave the archive are refused, links never followed, sizes capped, key and sign-in files listed but never read). The server receives the normalized bundle, which is what will be created, never the raw files (the agents' own files, when the person keeps them, go to the Drive one by one: §8).
- `source.app` + `source.ref` name the package (`openmausbot` + the package id; `agenteschat` + the org id). A source with no id of its own uses the dropped folder's or link's name, else its agents' keys, never the files' content, so an edited package or a fresh export of the same one updates what the earlier import made. Keys are the source's own ids: they link items to each other and tell a later import what it made.
- A GitHub link is still read by the backend (§5); the browser parses what comes back.

### 2. Plan, then apply

`POST /api/app/organizations/{orgId}/imports` with `{ bundle, dryRun, pick?, enableSkills? }` returns `{ items }`, one per picked item, in dependency order (skills, agents, channels, routines, notes):

- `create`;
- `unchanged`: an earlier import of this package made it, it is still there and the item's hash is the same;
- `update`: made by an earlier import, still there, hash changed (a channel also when an agent it lists arrives now: only that agent joins);
- `skip` with a reason: `exists`, `model_not_in_catalog`, `invalid_skill`, `schedule_unsupported`, `schedule_in_past`, `secret_like`, `agent_not_picked`, `channel_not_picked`, `invalid`, `failed`.

On a create or update, `reason` is a note: `model_not_in_catalog` (the workspace's default model instead), `exists` (an existing public channel the agents join). `trimmed` names fields cut to our limits; `renamedTo` the handle an agent gets when it isn't the bundle's (taken, or an id).

`planImport` is pure: it compares the bundle with `loadImportState` (the provenance rows of this package, every handle including archived agents and people, skill names including deleted ones, channel names). A dry run writes nothing.

Applying goes through the same functions as the app, in that order, one `try/catch` per item: `saveSkill`; `createAgent` (or `updateAgent`) and `setAgentAppearance`; `createChannel`, `addChannelMember` with the auto-reply; `createRoutine` and `setRoutineActive(false)` in one transaction (or `updateRoutine`); `addContextItemByPerson` (or `editContextItem`). A provenance row is written as soon as each item exists. One audit entry, `import.applied`, has the counts. Messages are never written (`insertMessageWithRuns` would start runs).

One apply creates or updates at most 200 items (`import.too_many_items`). A big import is applied in chunks of `pick`, in the plan's order; each call is short (the server cuts a request with no answer after 120 s, `idleTimeout` in `start.ts`) and safe to repeat, because what an earlier chunk made counts as there.

### 3. Provenance

`import_items (org_id, source_app, source_ref, kind, key, target_id, hash, adopted, created_by_user_id, …)`, unique on `(org_id, created_by_user_id, source_app, source_ref, kind, key)`, cascade on the organization.

- Rows belong to the person who imported. Many packages have generic ids (OpenClaw's default agent `main`, a folder named `.openclaw` or `.hermes`), so someone else's package lands as new items with the next free handles, never as updates to what another person brought. The cost: when two admins import the same team package, the second gets copies, which the preview shows as new.

- Matching by name alone breaks once a handle got a suffix (`scout` → `scout-2`); the table finds it.
- It is what tells an update which rows it may touch: only what the import made. Something with the same name that it didn't make is never changed.
- `adopted`: a channel that already existed, which the import only joined its agents to. A future rollback must never delete it.
- Known limit: if the process dies between creating an item and writing its row, a re-run sees a name it didn't make (`exists`, or a suffixed handle).
- `GET /api/app/organizations/{orgId}/imports` reads it back as what the workspace brought, one entry per source package with how many of each kind came (adopted channels left out), admins only (`importedSources`). The onboarding's import step, passed already with no file in hand (the page opened again), opens on it instead of an empty picker.

### 4. Rules

- **Permission:** `manage_agents` for the whole import, dry runs included (admins).
- **Handles:** the bundle's, unless it is an id another app gave its agent (`agent-e9665a97-c8d5-…`, OpenBot.run's): then one from the name, as an agent made here gets it (`Otávio Ofertas` → `otavioofertas`); an agent still named "New agent" (or by its id) takes it from its role, else from the first sentence of its instructions, else `newagent`. The bundle keeps the id, so the hash of an earlier import of the same file still matches. Taken by an agent or a person the import didn't make → the next free one (`scout-2`). Either way `renamedTo` says the handle it gets. The handles someone chose come before the ones made from names, so a name never takes a chosen handle, and they are given over every agent of the bundle, picked or not: unticking an agent never moves another's handle, and a chunk carries every agent.
- **Channels:** a public channel with the name → the imported agents join it; its topic is never changed. A private channel, a forum or an archived one with the name → `exists` (agents never join a private channel through an import, also not one an earlier import made and someone made private since). After creation the topic belongs to the people in it: the hash leaves it out.
- **Skills:** land off for every agent unless their `skill:key` is in `enableSkills`, and never become defaults for new agents; a skill the import made and someone deleted comes back the same way (its old assignments off). A name held by a skill the import didn't make → `exists` (saving would write a new version over it).
- **Routines:** always land paused; an update keeps them on or off as the person left them. A one-off (`at`, or the picker's `once`) becomes a one-time rule, so it still fires once when turned on. A zone the source leaves out is the importer's, then the workspace's. A routine posts where its agent is: it joins its channel with auto-reply off if it isn't there yet. A channel target that isn't coming → `channel_not_picked`; `null` posts in the importer's DM with the agent.
- **Secrets:** `looksLikeSecret` on every text field (name, role, instructions, SKILL.md, topic, prompt, note) → `secret_like`, never stored. The browser scrubs too, but a hand-made bundle doesn't, so the server's patterns are the ones that count.
- **Models:** outside our catalog → the default model of the agents route, reported. The model is chosen when the agent is created here (onboarding picks one the workspace's key runs): an update never changes it, and the hash leaves it out.
- **Limits:** our create limits (name 80, role 200, instructions 50,000, channel 80, topic 500, routine name 120, prompt 10,000, note title 300 and content 8,000); longer text is cut and reported. The route caps the request at 32 MB and 200 agents, 300 skills, 300 channels, 1,000 routines and 5,000 notes.
- **Dependencies:** an item whose agent (or channel) isn't coming → `agent_not_picked` (or `channel_not_picked`). A repeated key → `invalid`.
- **Notes** are stored as the importer's (high trust, human evidence), agent-scoped or workspace-wide. A note later merged or archived by memory upkeep still counts as there. The judge that keeps "you may skip approvals" text out of memory isn't asked per imported note (a model call each); such text can't grant anything, permissions only come from scopes and approvals.

### 5. GitHub links

`POST …/agent-imports/github` reads one file, or a folder with one recursive trees request (`git/trees/{ref}?recursive=1`) and then the allowlisted files only, relative to the linked folder, in this order when the caps cut: its own Markdown/JSON/YAML, `agents/` (one level of folders), `skills/` and `.agents/skills/` (Markdown up to four folders deep), `cron/jobs.json`, then `memory/` and `memories/` (newest first). Files where other apps keep keys and sign-ins (`.env*`, `auth.json`, `auth-profiles.json`, `credentials.*`, `secrets.*`, `mcp-oauth*`, `mcp-tokens*`, `cursor-session.json`) and symbolic links are never read. Caps: 200 files, 8 MB in all, 4 MB a file (the parser's limit); what doesn't fit comes back in `skipped`, not read. A truncated tree is refused. Every request keeps the SSRF guard, no redirects and 15 s.

### 6. Our own export

`GET …/export` (admins) downloads this workspace as a bundle (`source.app: "agenteschat"`, `ref`: the org id):

- agents (look, the skills they have on), skills as SKILL.md (frontmatter written back with `Bun.YAML`), public channels with their agents and auto-reply, scheduled routines with their target channel or DM, and memory: active, high trust, verified, undisputed facts, preferences, decisions, notes and lessons, workspace-wide or of an exported agent, learned only where everyone can read (public channels), most relevant first, up to the import limit;
- left out, listed: routines with event or mail triggers or another target, and skill files other than SKILL.md;
- never: credentials, connections and their tokens, OAuth clients, computers, sandboxes, secrets, budgets, runs, usage, audit, messages, private channels and what was learned in them.

Imported into another workspace it comes back the same (the round trip is tested); `#general` is joined, not made. Importing a newer export of the same workspace updates what the previous one made, when the same person imports it (§3).

### 7. SKILL.md frontmatter

The frontmatter is read with Bun's own YAML parser (`Bun.YAML`, in the pinned Bun 1.3.1: no new dependency), so nested maps (`metadata.openclaw`, `metadata.hermes`), block scalars and lists survive into the skill's metadata. Many published skills aren't valid YAML (`description: Use when: …`): they keep the old line reading. When YAML reads `name` or `description` as something other than text (`Yes`, `1.0`), the text as written wins. Aliases that expand past 10,000 values are refused as YAML.

### 8. The agents' own files, into the Drive

Some exports carry what the agents made, not only how they are set up: OpenBot.run's `agents/<key>/files/` (both formats; `INSTRUCTIONS.md` there is still the agent's instructions), an OpenClaw workspace (whatever it has besides the files the parser reads, its `skills/` and `.agents/`), and a Claw package's `workspace.files`. Hermes, Paperclip, OpenMausBot, OpenBot (CopilotKit) and our own export carry none: chat logs and package files are not the agents' work.

- The parser names an agent's folder (`Draft.filesIn`, the deepest folder wins when one is inside another) or single files (`Draft.fileAt`); `parsePackage` returns those files beside the bundle, never in it, and they leave "Outros arquivos". Each keeps its size and a way to read its bytes later: the picked `File`, the zip entry, or a slice of the tar (a `.tar.gz` is unpacked whole the first time one of its files is read; the parse already held it to the size limits).
- Set aside, with the reason the person sees: credential stores (`isSecretPath`, now in `@agenteschat/ui/names`, the same rule the server applies, which also knows `.netrc`, `.pgpass`, `.htpasswd` and `.ppk` keys) and text files with a key or a password in them (`scrubSecrets` here, `looksLikeSecret` on the server, as for memory), system files the reader dropped (`.DS_Store`, `__MACOSX`, `Thumbs.db`, `desktop.ini`, `.git`, `node_modules`, `__pycache__`: `readImportFiles` returns their paths as `junk`), files over the Drive's 50 MB, and files with no bytes to read (a link).
- The preview shows each agent's folder (`Drive › <name>`), how many files and how big, with **Copiar os arquivos para o Drive** on. After the first apply, the browser sends them one per request, four at a time, to `POST …/imports/files` (`copyImportedFile`): the apply never waits for them, the report shows the progress and what stayed behind, a toast says when it's done, and **Tentar de novo** sends the ones that failed. No outbox job: the bytes are in the browser, so a server job would first need one big upload of the archive; a request per file stays under the Drive's own limit and the 120 s idle cut.
- On the server each file lands as `<agent's name>/<path>` (a long path keeps its end, in the 200-character title), in the Drive (no channel: the whole workspace sees it), made by the agent, so its page lists it, with the importer in the audit and the first version's note ("Trazido do OpenBot.run"). The Drive has no folders: the title is the folder, and the author is how the Drive already groups an agent's files. A title the Drive already has (outside the trash) stays as it was and comes back `exists`: importing again never overwrites, and picks up what an interrupted copy left. Refused: a credential store, by its name or by what a text file says (`import.secret_file`), and a path with `..` (`import.file_path`). The Drive's limits apply as to any upload: 50 MB a file (413), the workspace's storage and daily uploads (409 `storage.full`, `storage.daily_full`: the files not sent yet stay behind with that reason). Who may import (`create_agents`).
- Each agent whose files are in the Drive keeps one note in its memory, in the importer's language ("Seus arquivos do OpenBot.run estão em Drive › Scout."), applied as one more import item of the same package (`<agent>/drive-files`), so a second import finds it unchanged.
- Known limits: two imports copying the same name at the same moment can both land (the title is no unique key); renaming the agent later doesn't move its folder.

## Consequences

- One apply path for every source: a new source is a parser that fills the bundle, plus fixtures.
- Re-running is safe and picks up where it stopped; the plan says what would change before anything does.
- An update overwrites what the import made with the source's version (instructions, routine prompts, notes). The plan shows it as `update`, and the person can leave it unchecked.
- Importing into the same workspace makes copies (suffixed handles); restoring by id is not covered.

## Later

- **Chat history** (Slack-like sources): a bulk insert that skips `message.posted`, past-month partitions created first (ADR 0009), UUIDv7 at the historic time, authors in `meta`, no reflection during the import.
- **A CLI** (`agentes migrate --from … --out bundle.json`, MIT, no dependencies) once scripting or agents kept in git asks for it; writing from it needs a sign-in the app API doesn't have.
- **A runner scan** of `~/.openclaw*` and `~/.hermes` on a connected computer, read-only and confirmed by its owner, preferring their own redacted `--json` CLIs.
- **The Manus API**.
- **Rollback** of what an import made (the table already says what that is, and never adopted channels).
