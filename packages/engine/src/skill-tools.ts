import type { PubSub } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import { learnTrust } from "./context/learn";
import { changeSkillAsAgent } from "./context/learned-skills";
import { cutText } from "./format";
import type { Judge } from "./judge";
import { agentSkillByName, SKILL_LIMITS, type SkillDeps, skillFilesOf, skillFileText } from "./skills";
import type { ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/**
 * Skills through the Tool Gateway (`skills:read`, on by default):
 * `load_skill` returns a skill's instructions and its files, and
 * `read_skill_file` one of its text files. Only skills enabled for the agent;
 * scripts are never shown: `run_skill_script` (sandbox tools, ADR 0021) runs them.
 */
export function createSkillToolSource(deps: SkillDeps & { pubsub?: PubSub; judge?: Judge }): ToolSource {
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
                  if (f.status === "stored") return `- ${f.path} (${f.mime}, ${f.size} bytes)`;
                  if (f.status === "script") {
                    return `- ${f.path} (script: runs with run_skill_script if you have the code environment; its content is not shown)`;
                  }
                  return `- ${f.path} (skipped: binary file)`;
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
      description: "Read a text file of one of your skills (references, templates, examples).",
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
          const text = await skillFileText(deps, skill, str(input.path));
          const shown =
            text.length > SKILL_LIMITS.fileReadChars
              ? `${cutText(text, SKILL_LIMITS.fileReadChars)}\n[truncated]`
              : text;
          return { content: `${skill.name}/${str(input.path)}:\n${shown}` };
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
