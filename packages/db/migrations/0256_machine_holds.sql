CREATE TABLE "machine_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"run_id" uuid,
	"what" text NOT NULL,
	"why" text NOT NULL,
	"pid" integer,
	"browser" boolean DEFAULT false NOT NULL,
	"until" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"ended_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_holds" ADD CONSTRAINT "machine_holds_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_holds" ADD CONSTRAINT "machine_holds_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_holds" ADD CONSTRAINT "machine_holds_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_holds_org_id_agent_id_created_at_index" ON "machine_holds" USING btree ("org_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "machine_holds_machine_id_index" ON "machine_holds" USING btree ("machine_id") WHERE "machine_holds"."ended_at" is null;