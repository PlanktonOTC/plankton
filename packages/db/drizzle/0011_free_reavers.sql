CREATE TABLE "telegram_lp_daily" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"last_sent_ymd" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
