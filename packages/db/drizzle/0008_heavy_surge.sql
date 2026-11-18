CREATE TABLE "telegram_price_alerts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "telegram_price_alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"chat_id" text NOT NULL,
	"symbol" text NOT NULL,
	"above" boolean NOT NULL,
	"price_e18" numeric(78, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "telegram_price_alerts_chat" ON "telegram_price_alerts" USING btree ("chat_id");