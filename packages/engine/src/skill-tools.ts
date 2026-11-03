import type { PubSub } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import { sniffModelImage } from "./avatars";
import { learnTrust } from "./context/learn";
import { changeSkillAsAgent } from "./context/learned-skills";
import { cutText, formatBytes } from "./format";
import type { Judge } from "./judge";
import { type SandboxDeps, withSandbox } from "./sandbox";
import { agentSkillByName, notKeptReason, SKILL_LIMITS, type SkillDeps, skillFile, skillFilesOf } from "./skills";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/**
 * Skills through the Tool Gateway (`skills:read`, on by default):
 * `load_skill` returns a skill's instructions and its files, and
 * `read_skill_file` one of them: text as text, an image as an image on a model brain, and on a computer brain (or
 * any file that isn't text) the file saved to `.skills/{name}/` on the agent's computer, where its own tools open it.
 * Only skills enabled for the agent; scripts are never shown: `run_skill_script` (sandbox tools, ADR 0021) runs them.
 * `computer`: reaching the agent's computer (none: files that aren't text are described only).
 */
export function createSkillToolSource(
  deps: SkillDeps & { pubsub?: PubSub; judge?: Judge; computer?: SandboxDeps },
): ToolSource {
  /** Saves a skill's file on the agent's computer: its path there, or why it couldn't be. */
  const saveOnComputer = async (ctx: ToolContext, path: string, data: Uint8Array) => {
    const computer = deps.computer;
    if (!computer) return { why: "There is no computer here to save it on." };
    return withSandbox(computer, ctx, (c) => c.provider.writeFile(c.id, path, data)).then(
      () => ({ saved: path }),
      (error: unknown) => ({ why: error instanceof Error ? error.message : String(error) }),
    );
  };
  const tools: ToolDefinition[] = [
    {
      name: "load_skill",
      description:
        "Load one of your skills (from 'Available skills') before doing a task it covers: returns its instructions and the files you can read.",
      scope: "skills:read",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", minLength: 1, maxLength: 64 } },
        required: ["name"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const skill = await agentSkillByName(ctx.db, ctx.orgId, ctx.agentId, str(input.name));
          if (!skill) return { content: `No skill named ${str(input.name)} is enabled for you.`, isError: true };
          // Use keeps an agent-made skill from being archived for disuse (ADR 0120).
          await ctx.db
            .update(schema.skills)
            .set({ useCount: sql`${schema.skills.useCount} + 1`, lastUsedAt: new Date() })
            .where(eq(schema.skills.id, skill.id));
          const files = await skillFilesOf(ctx.db, skill);
          const list = files.length
            ? files
                .map((f) => {
                  if (f.status === "stored") return `- ${f.path} (${f.mime}, ${formatBytes(f.size)})`;
                  if (f.status === "script") {
                    return `- ${f.path} (script: runs with run_skill_script if you have the code environment; its content is not shown)`;
                  }
                  return `- ${notKeptReason(f, files)}`;
                })
                .join("\n")
            : "(no files)";
          return {
            content: `Skill "${skill.name}" (v${skill.version}) loaded.\n\n${skill.body}\n\nFiles (read with read_skill_file):\n${list}`,
            data: { skill: { id: skill.id, name: skill.name, version: skill.version } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "read_skill_file",
      description:
        "Read a file of one of your skills (references, templates, examples, images): text comes as text, an image as an image you see; other files are saved to .skills/{name}/ on your computer, when you have one.",
      scope: "skills:read",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 64 },
          path: { type: "string", minLength: 1, maxLength: 300 },
        },
        required: ["name", "path"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const skill = await agentSkillByName(ctx.db, ctx.orgId, ctx.agentId, str(input.name));
          if (!skill) return { content: `No skill named ${str(input.name)} is enabled for you.`, isError: true };
          const path = str(input.path);
          const file = await skillFile(deps, skill, path);
          if (file.text) {
            const text = new TextDecoder().decode(file.data);
            const shown =
              text.length > SKILL_LIMITS.fileReadChars
                ? `${cutText(text, SKILL_LIMITS.fileReadChars)}\n[truncated]`
                : text;
            return { content: `${skill.name}/${path}:\n${shown}` };
          }
          const about = `${skill.name}/${path} (${file.mime}, ${formatBytes(file.size)})`;
          // By its bytes: a model's API refuses an image sent under another type (a .png that is a JPEG).
          const image = sniffModelImage(file.data);
          const fits = file.data.byteLength <= SKILL_LIMITS.imageBytes;
          // A computer brain (Claude Code, Codex, OpenCode) sees pictures with its own tools, not through ours.
          if (image && fits && !ctx.bridge) {
            return {
              content: `${about}: the image is attached.`,
              images: [{ mediaType: image, data: Buffer.from(file.data).toString("base64") }],
            };
          }
          const tooLarge =
            image && !ctx.bridge
              ? ` It is too large to show you here (max ${formatBytes(SKILL_LIMITS.imageBytes)}).`
              : "";
          const result = await saveOnComputer(ctx, `.skills/${skill.name}/${path}`, file.data);
          if ("saved" in result) {
            return {
              content: `${about}:${tooLarge} saved to ${result.saved} in your folder on your computer: open it there with your own tools${image && ctx.bridge ? ", which show images" : ""}.`,
              data: { path: result.saved },
            };
          }
          return {
            content: `${about}: not text, so its content isn't shown here.${tooLarge} Not saved on your computer: ${result.why}`,
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "update_skill",
      description:
        "Fix one of your skills you loaded in this turn when it was wrong or missing a step: the full new body (Markdown, steps first, then pitfalls). Your own skills change at once (with Undo); a skill a person made becomes a proposal they accept. Never credentials.",
      scope: "skills:read",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 64 },
          body: { type: "string", minLength: 10, maxLength: 50_000 },
        },
        required: ["name", "body"],
        additionalProperties: false,
      },
      describe: (input) => ({ title: `Fix the skill ${str(input.name)}` }),
      async execute(input, ctx) {
        try {
          const change = await changeSkillAsAgent(
            { db: ctx.db, pubsub: deps.pubsub, judge: deps.judge },
            ctx,
            str(input.name),
            str(input.body),
            (await learnTrust(ctx)).trust,
          );
          if (change.action === "updated")
            return { content: `Updated ${change.skill.name} (v${change.skill.version}).` };
          if (change.action === "proposed" && change.outside)
            return {
              content: `This turn read outside content (the web, mail or a connected app), so the fix is proposal ${change.proposalId}: someone who manages agents accepts it. Use your fix in this turn.`,
            };
          if (change.action === "proposed")
            return {
              content: `A person made this skill, so the fix is proposal ${change.proposalId}: someone who manages agents accepts it. Use your fix in this turn.`,
            };
          return { content: "Nothing changed: the body is the same." };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
  return { name: "skills", tools: async () => tools };
}
