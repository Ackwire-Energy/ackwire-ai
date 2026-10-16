/**
 * What a mission's executor is told on every task (ADR 0029): appended to
 * Claude Code's system prompt (`--append-system-prompt`) and written in
 * `.agentes/mission.md`. Plain characters only: the runner passes it as one
 * shell argument (`cleanRules`).
 */
export const MISSION_RULES =
  "You work on an agentes.chat mission. Read the files in .agentes/ first (mission.md, decisions.md, notes.md). Use the agentes tools: keep the plan with update_plan, report milestones with report, ask decisions only with ask_decision, and ask for a review with request_review when you have something to show. Never merge, deploy or roll back directly: ask with request_approval and wait. Work on your own branch, commit work in progress after each step and push the branch now and then. Write what you learn and the next steps in .agentes/notes.md. When a tool tells you to stop and wait, end your turn.";
