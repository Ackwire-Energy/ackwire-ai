-- No transaction holds this migration (`migrateInSteps`): Postgres refuses CONCURRENTLY inside one, and agent_runs is
-- large and busy. A statement that fails leaves the migration unrecorded, and the next start runs it again: hence the
-- DROP before the concurrent build, which leaves an invalid index under its name when it fails.
-- deploy-safe: only this migration builds the index, so the drop removes what a cut-short run of it left and nothing a running version has
DROP INDEX CONCURRENTLY IF EXISTS "agent_runs_done_finished_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "agent_runs_done_finished_idx" ON "agent_runs" USING btree ("org_id","finished_at") WHERE "agent_runs"."status" = 'done';
