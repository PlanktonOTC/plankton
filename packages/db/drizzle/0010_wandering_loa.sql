DROP INDEX "trades_trader_time";--> statement-breakpoint
CREATE INDEX "orders_open_trader" ON "orders" USING btree ("trader") WHERE "orders"."status" = 'open';--> statement-breakpoint
CREATE INDEX "trades_trader_time" ON "trades" USING btree ("trader","at","tx_hash","log_index");