-- The setup checklist at the top of a new agent's chat (ADR 0152 §2). Null for the agents made before: they show none.
ALTER TABLE "agents" ADD COLUMN "setup" jsonb;