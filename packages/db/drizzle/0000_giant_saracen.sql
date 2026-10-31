CREATE TABLE "indexer_cursor" (
	"name" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"nonce" bigint NOT NULL,
	"trader" text NOT NULL,
	"market_id" text NOT NULL,
	"kind" smallint NOT NULL,
	"trigger_e18" numeric(78, 0) NOT NULL,
	"trigger_above" boolean NOT NULL,
	"valid_after" timestamp with time zone NOT NULL,
	"expiry" timestamp with time zone NOT NULL,
	"body" jsonb NOT NULL,
	"sig" text NOT NULL,
	"status" text NOT NULL,
	"fill_tx" text,
	"fail_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_trader_nonce_pk" PRIMARY KEY("trader","nonce")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"trader" text NOT NULL,
	"market_id" text NOT NULL,
	"size_e18" numeric(78, 0) NOT NULL,
	"entry_e18" numeric(78, 0) NOT NULL,
	"margin_usdg" numeric(78, 0) NOT NULL,
	"opened_at" timestamp with time zone,
	"updated_block" bigint NOT NULL,
	CONSTRAINT "positions_trader_market_id_pk" PRIMARY KEY("trader","market_id")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"trader" text NOT NULL,
	"market_id" text NOT NULL,
	"size_delta_e18" numeric(78, 0) NOT NULL,
	"price_e18" numeric(78, 0) NOT NULL,
	"fee_usdg" numeric(78, 0) NOT NULL,
	"realized_pnl_usdg" numeric(78, 0) NOT NULL,
	"path" smallint NOT NULL,
	CONSTRAINT "trades_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE INDEX "orders_open" ON "orders" USING btree ("status","market_id");--> statement-breakpoint
CREATE INDEX "trades_trader_time" ON "trades" USING btree ("trader","at");