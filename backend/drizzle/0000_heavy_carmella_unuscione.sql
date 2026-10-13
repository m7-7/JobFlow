CREATE TABLE "candidate_profile" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"headline" text,
	"experience_summary" text,
	"location" text,
	"target_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"work_model" text,
	"career_instructions" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_profile_singleton" CHECK ("candidate_profile"."id" = 1),
	CONSTRAINT "candidate_profile_work_model_allowed" CHECK ("candidate_profile"."work_model" IS NULL OR "candidate_profile"."work_model" IN ('remote', 'hybrid', 'onsite', 'flexible'))
);
