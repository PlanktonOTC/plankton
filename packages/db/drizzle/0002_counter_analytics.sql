CREATE TABLE "counter_activity" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"market_id" text,
	"amount_usdg" numeric(78, 0) NOT NULL,
	"details" jsonb NOT NULL,
	CONSTRAINT "counter_activity_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "counter_nav_snapshots" (
	"hour" bigint PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"nav_usdg" numeric(78, 0) NOT NULL,
	"nav_per_share_e18" numeric(78, 0) NOT NULL,
	"total_shares" numeric(78, 0) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "counter_activity_kind_time" ON "counter_activity" USING btree ("kind","at");