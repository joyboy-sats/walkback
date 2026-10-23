CREATE TABLE IF NOT EXISTS "memwal_write_budget" (
  "id" text PRIMARY KEY,
  "window_started_at" timestamptz NOT NULL,
  "used" integer NOT NULL
);
--> statement-breakpoint
INSERT INTO "memwal_write_budget" ("id", "window_started_at", "used")
VALUES ('write', now(), 0)
ON CONFLICT ("id") DO NOTHING;
