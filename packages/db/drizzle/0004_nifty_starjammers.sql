CREATE TABLE "telegram_challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
