ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "reporting_hits" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "reporting_misses" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "forecast_hits" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "forecast_misses" integer DEFAULT 0 NOT NULL;
