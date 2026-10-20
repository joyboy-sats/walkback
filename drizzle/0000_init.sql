CREATE TYPE "public"."claim_status" AS ENUM('pending', 'resolved', 'void');--> statement-breakpoint
CREATE TYPE "public"."claim_type" AS ENUM('balance_threshold', 'balance_change_since_ingest', 'tx_replay', 'price_threshold', 'manual');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('ingest', 'rebuild', 'resolve', 'restore');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('source', 'claim', 'resolution', 'score', 'digest', 'tombstone');--> statement-breakpoint
CREATE TYPE "public"."outcome" AS ENUM('true', 'false', 'void');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('x', 'substack', 'rss', 'onchain', 'other');--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"quote" text NOT NULL,
	"claim_type" "claim_type" NOT NULL,
	"params" jsonb NOT NULL,
	"snapshot" jsonb,
	"deadline" timestamp with time zone NOT NULL,
	"status" "claim_status" DEFAULT 'pending' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"synthetic" boolean DEFAULT false NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"walrus_blob_id" text
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "job_kind" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"ref_id" uuid,
	"namespace" text NOT NULL,
	"blob_id" text NOT NULL,
	"server_id" text,
	"text_preview" text NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"outcome" "outcome" NOT NULL,
	"evidence" jsonb NOT NULL,
	"reason" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"walrus_blob_id" text
);
--> statement-breakpoint
CREATE TABLE "score_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"hits" integer NOT NULL,
	"misses" integer NOT NULL,
	"score" real NOT NULL,
	"hit_rate" real NOT NULL,
	"triggered_by_claim_id" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"walrus_blob_id" text
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"platform" "platform" DEFAULT 'other' NOT NULL,
	"sui_address" text,
	"rss_url" text,
	"hits" integer DEFAULT 0 NOT NULL,
	"misses" integer DEFAULT 0 NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"walrus_blob_id" text
);
--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_versions" ADD CONSTRAINT "score_versions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claims_status_deadline_idx" ON "claims" USING btree ("status","deadline");--> statement-breakpoint
CREATE INDEX "claims_source_idx" ON "claims" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_external_id_uidx" ON "claims" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "jobs_status_created_idx" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "memory_log_kind_idx" ON "memory_log" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "memory_log_blob_idx" ON "memory_log" USING btree ("blob_id");--> statement-breakpoint
CREATE INDEX "resolutions_claim_idx" ON "resolutions" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "score_versions_source_idx" ON "score_versions" USING btree ("source_id","version");--> statement-breakpoint
CREATE INDEX "sources_score_idx" ON "sources" USING btree ("score");--> statement-breakpoint
CREATE INDEX "sources_handle_idx" ON "sources" USING btree ("handle");