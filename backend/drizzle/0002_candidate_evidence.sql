CREATE TABLE "candidate_evidence_source" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "candidate_evidence_source_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"url" varchar(2048),
	"origin" text DEFAULT 'manual' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_evidence_source_type_allowed" CHECK ("candidate_evidence_source"."type" IN ('professional_experience', 'personal_project', 'cv', 'portfolio', 'other')),
	CONSTRAINT "candidate_evidence_source_title_not_blank" CHECK ("candidate_evidence_source"."title" ~ '[^\t\n\v\f\r ]'),
	CONSTRAINT "candidate_evidence_source_url_http" CHECK ("candidate_evidence_source"."url" IS NULL OR "candidate_evidence_source"."url" ~* '^https?://'),
	CONSTRAINT "candidate_evidence_source_origin_allowed" CHECK ("candidate_evidence_source"."origin" = 'manual')
);
--> statement-breakpoint
CREATE TABLE "candidate_skill_evidence" (
	"skill_id" integer NOT NULL,
	"evidence_source_id" integer NOT NULL,
	CONSTRAINT "candidate_skill_evidence_pk" PRIMARY KEY("skill_id","evidence_source_id")
);
--> statement-breakpoint
ALTER TABLE "candidate_skill_evidence" ADD CONSTRAINT "candidate_skill_evidence_skill_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."candidate_skill"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_skill_evidence" ADD CONSTRAINT "candidate_skill_evidence_source_fk" FOREIGN KEY ("evidence_source_id") REFERENCES "public"."candidate_evidence_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_skill_evidence_source_idx" ON "candidate_skill_evidence" USING btree ("evidence_source_id");