CREATE TABLE "liquidation_challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "liquidation_warning_states" (
	"wallet" text NOT NULL,
	"market_id" text NOT NULL,
	"level" smallint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "liquidation_warning_states_wallet_market_id_pk" PRIMARY KEY("wallet","market_id")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "push_subscriptions_wallet" ON "push_subscriptions" USING btree ("wallet");