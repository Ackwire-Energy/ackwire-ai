-- ADR 0020 addendum: a skill is the team's or one person's, as the Vault's items are (ADR 0144). Names stay unique
-- among the team's skills and among each person's.
-- deploy-safe: the previous version writes no owner, and the team index below keeps its rows unique by name as before
ALTER TABLE "skills" DROP CONSTRAINT "skills_orgId_slug_unique";--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_team_slug" ON "skills" USING btree ("org_id","slug") WHERE "skills"."owner_user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_personal_slug" ON "skills" USING btree ("org_id","owner_user_id","slug") WHERE "skills"."owner_user_id" is not null;
