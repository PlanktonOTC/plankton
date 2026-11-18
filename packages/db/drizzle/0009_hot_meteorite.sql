CREATE TABLE "telegram_event_subscriptions" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"symbols" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_events_announced" (
	"event_id" text PRIMARY KEY NOT NULL,
	"announced_at" timestamp with time zone DEFAULT now() NOT NULL
);
