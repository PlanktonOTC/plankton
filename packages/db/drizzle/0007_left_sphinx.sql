ALTER TABLE "push_subscriptions" DROP CONSTRAINT "push_subscriptions_pkey";--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_wallet_endpoint_pk" PRIMARY KEY("wallet","endpoint");
