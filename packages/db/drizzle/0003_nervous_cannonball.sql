CREATE TABLE "telegram_bot_state" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"next_update_id" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_link_codes" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"linked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "telegram_links" (
	"wallet" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"username" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_links_chat_id_unique" UNIQUE("chat_id")
);
