CREATE TABLE "seed_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" uuid,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memory_log" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "seed_posts" ADD CONSTRAINT "seed_posts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_log_idempotency_key_uidx" ON "memory_log" USING btree ("idempotency_key");