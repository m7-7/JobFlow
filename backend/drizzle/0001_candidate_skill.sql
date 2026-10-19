CREATE TABLE "candidate_skill" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "candidate_skill_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(100) NOT NULL,
	"experience_contexts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"practical_confidence" smallint,
	"interview_confidence" smallint,
	"experience_months" smallint,
	"last_used_year" smallint,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_skill_name_not_blank" CHECK ("candidate_skill"."name" ~ '[^\t\n\v\f\r ]'),
	CONSTRAINT "candidate_skill_experience_contexts_array" CHECK (jsonb_typeof("candidate_skill"."experience_contexts") = 'array'),
	CONSTRAINT "candidate_skill_experience_contexts_allowed" CHECK ("candidate_skill"."experience_contexts" <@ '["professional", "personal_project", "academic", "learning"]'::jsonb),
	CONSTRAINT "candidate_skill_experience_contexts_unique" CHECK (CASE WHEN jsonb_typeof("candidate_skill"."experience_contexts") = 'array' THEN
        jsonb_array_length("candidate_skill"."experience_contexts") =
          ("candidate_skill"."experience_contexts" @> '["professional"]')::int +
          ("candidate_skill"."experience_contexts" @> '["personal_project"]')::int +
          ("candidate_skill"."experience_contexts" @> '["academic"]')::int +
          ("candidate_skill"."experience_contexts" @> '["learning"]')::int
      ELSE true END),
	CONSTRAINT "candidate_skill_practical_confidence_range" CHECK ("candidate_skill"."practical_confidence" IS NULL OR "candidate_skill"."practical_confidence" BETWEEN 1 AND 5),
	CONSTRAINT "candidate_skill_interview_confidence_range" CHECK ("candidate_skill"."interview_confidence" IS NULL OR "candidate_skill"."interview_confidence" BETWEEN 1 AND 5),
	CONSTRAINT "candidate_skill_experience_months_range" CHECK ("candidate_skill"."experience_months" IS NULL OR "candidate_skill"."experience_months" BETWEEN 0 AND 1200),
	CONSTRAINT "candidate_skill_last_used_year_range" CHECK ("candidate_skill"."last_used_year" IS NULL OR "candidate_skill"."last_used_year" BETWEEN 1950 AND 2100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_skill_name_normalized_unique" ON "candidate_skill" USING btree (lower(btrim(regexp_replace("name", '[\t\n\v\f\r ]+', ' ', 'g'))));