CREATE TABLE "voice_lab_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"best" text NOT NULL,
	"worst" text NOT NULL,
	"details" jsonb NOT NULL,
	"recording" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_lab_results" ADD CONSTRAINT "voice_lab_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_lab_results_created_idx" ON "voice_lab_results" USING btree ("created_at");