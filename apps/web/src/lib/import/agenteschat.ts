import type { ApiRule, BundleNote, BundleTodo } from "@agenteschat/client";
import { normalizeAppearance } from "@agenteschat/ui";
import {
  cleanUrl,
  cronTrigger,
  type Draft,
  ImportError,
  type ImportFile,
  jsonOf,
  type LeftOutKind,
  list,
  obj,
  str,
  type Trigger,
} from "./shared";

/**
 * Our own bundle (`MigrationBundle` in packages/client/src/api/types.ts):
 * what our export writes, and what another product's agent writes when given
 * `EXPORT_PROMPT`. Read like any other source: nothing in it is trusted.
 */

const FORMAT = "agenteschat.bundle";
const NOTE_KINDS: BundleNote["kind"][] = ["fact", "preference", "decision", "note", "lesson"];
const TODO_KINDS: BundleTodo["kind"][] = ["connection", "app", "secret", "model", "file"];
const LEFT_OUT_KINDS = new Set<string>([
  "skill",
  "routine",
  "notes",
  "picture",
  "preset",
  "remote",
  "model",
  "connection",
  "plugin",
  "messaging",
  "task",
  "team",
  "secret",
  "redacted",
  "file",
  "other",
]);

/**
 * For any agent product (Grok Bot, ChatGPT dots, Claude, Manus, Rakazo,
 * Viktor…): paste it there and bring back the file it writes, or the JSON it
 * replies with.
 */
export const EXPORT_PROMPT = `Please export everything I set up with you, so I can move it to agentes.chat (a workspace where people and AI agents work together).

Write one JSON file named agentes-chat-export.json and give it to me to download. If you can't make files, reply with the JSON in a single \`\`\`json code block and nothing else.

Use exactly this shape:

{
  "format": "${FORMAT}",
  "version": 1,
  "source": { "app": "<your product, such as grok-bot, chatgpt-dots, claude, manus, rakazo or viktor>", "ref": "<a short id that stays the same if I export again>", "name": "<a name for this export>", "files": [] },
  "agents": [
    {
      "key": "<a short id: lowercase letters, digits and hyphens>",
      "name": "<the agent's name>",
      "handle": "<the same as key>",
      "role": "<its role or title, in one line>",
      "instructions": "<its full standing instructions or system prompt, word for word>",
      "model": "<the model it runs on, or null>",
      "appearance": {},
      "skills": ["<the key of each skill it uses>"]
    }
  ],
  "skills": [
    { "key": "<skill-name>", "markdown": "---\\nname: <skill-name>\\ndescription: <when to use it>\\n---\\n\\n<the whole skill, word for word>" }
  ],
  "channels": [
    { "key": "<id>", "name": "<group chat name>", "topic": "<its purpose or shared instructions>", "agents": [{ "key": "<agent key>", "autoReply": true }] }
  ],
  "routines": [
    { "key": "<id>", "name": "<name>", "agent": "<agent key>", "prompt": "<what it does, word for word>", "channel": null, "trigger": { "cron": "<minute hour day-of-month month day-of-week>", "timezone": "<IANA time zone, such as America/Sao_Paulo>" } }
  ],
  "notes": [
    { "key": "<id>", "agent": "<agent key, or null when it is about everyone>", "kind": "fact", "content": "<one thing you remember, as a short statement>" }
  ],
  "todo": [
    { "kind": "app", "label": "<an app or connector you use, such as Gmail, Slack or GitHub>", "agents": ["<agent key>"] }
  ],
  "leftOut": [
    { "kind": "routine", "label": "<anything that doesn't fit above, by its name>" }
  ]
}

Rules:
- Include every agent, skill, scheduled task and group chat you have. If you are a single assistant, you are one agent.
- Copy instructions, skills and routine prompts exactly. Do not summarize or shorten them.
- A skill's "markdown" is its whole SKILL.md: the frontmatter with a lowercase, hyphenated name and a description, then the body.
- A task that runs once uses "trigger": { "at": "<ISO 8601 date and time with its offset>" }. A task that starts on an event (an email, a message, a webhook) goes in "leftOut" with kind "routine".
- A note's "kind" is one of fact, preference, decision, note or lesson. Write at most 50 notes per agent, about me, my work and my preferences, each one short.
- Never include API keys, tokens, passwords, cookies, private keys or any other secret, in any field. Write [removed] in their place.
- Use [] for anything you don't have. Write valid JSON only: no comments, no trailing commas.`;

const bundleOf = (files: ImportFile[]) => files.find((f) => jsonOf(f)?.format === FORMAT);

export const detect = (files: ImportFile[]) => bundleOf(files) !== undefined;

export function parse(files: ImportFile[], d: Draft) {
  const file = bundleOf(files);
  const b = file ? jsonOf(file) : null;
  if (!file || !b) throw new ImportError("unknown");
  if (b.version !== 1) throw new ImportError("newerVersion");
  d.used.add(file.name);
  const source = obj(b.source);
  d.name = str(source.name) || str(source.app);
  d.ref = [str(source.app), str(source.ref)].filter(Boolean).join(":");

  const skills = new Map<string, string>();
  for (const s of list(b.skills).map(obj)) {
    const key = d.skill(str(s.markdown), str(s.key));
    if (key) skills.set(str(s.key), key);
  }
  for (const a of list(b.agents).map(obj)) {
    d.agent({
      key: str(a.key),
      name: str(a.name),
      handle: str(a.handle),
      role: str(a.role),
      instructions: str(a.instructions),
      model: str(a.model) || undefined,
      appearance: normalizeAppearance(a.appearance),
      skills: list(a.skills).flatMap((k) => {
        const key = skills.get(str(k));
        return key ? [key] : [];
      }),
    });
  }
  for (const c of list(b.channels).map(obj)) {
    d.channel({
      key: str(c.key),
      name: str(c.name),
      topic: str(c.topic),
      agents: list(c.agents)
        .map(obj)
        .map((m) => ({ key: str(m.key), autoReply: m.autoReply !== false })),
    });
  }
  for (const r of list(b.routines).map(obj)) {
    d.routine({
      key: str(r.key),
      name: str(r.name),
      agent: str(r.agent),
      prompt: str(r.prompt),
      channel: str(r.channel) || null,
      trigger: trigger(obj(r.trigger)),
    });
  }
  for (const n of list(b.notes).map(obj)) {
    const kind = NOTE_KINDS.find((k) => k === n.kind) ?? "note";
    const title = str(n.title).trim();
    d.note({
      key: str(n.key),
      agent: str(n.agent) || null,
      kind,
      ...(title ? { title } : {}),
      content: str(n.content),
    });
  }
  for (const t of list(b.todo).map(obj)) {
    const kind = TODO_KINDS.find((k) => k === t.kind) ?? "app";
    d.need(kind, str(t.label), list(t.agents).map(str), cleanUrl(str(t.url)) || undefined);
  }
  for (const l of list(b.leftOut).map(obj)) {
    d.left(LEFT_OUT_KINDS.has(str(l.kind)) ? (str(l.kind) as LeftOutKind) : "other", str(l.label));
  }
}

/** Only the three shapes we take; the server checks the rest (a rule is our `ApiRule`). */
function trigger(t: Record<string, unknown>): Trigger | null {
  if (typeof t.cron === "string") return cronTrigger(t.cron, str(t.timezone) || null);
  if (t.rule && typeof obj(t.rule).freq === "string") return { rule: obj(t.rule) as unknown as ApiRule };
  const at = Date.parse(str(t.at));
  return Number.isNaN(at) ? null : { at: new Date(at).toISOString() };
}
