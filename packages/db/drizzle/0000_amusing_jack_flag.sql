CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"height" bigint NOT NULL,
	"hash" text NOT NULL,
	"parent_hash" text NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"block_height" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"txid" text NOT NULL,
	"event_index" integer NOT NULL,
	"event_type" text NOT NULL,
	"deployment_id" text,
	"wallet_from" text,
	"wallet_to" text,
	"token_amount_atoms" bigint,
	"btc_amount_sats" bigint,
	"payload_json" jsonb,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chain_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"txid" text,
	"operation" text NOT NULL,
	"wallet_address" text NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"idempotency_key" text,
	"deployment_id" text,
	"error_code" text,
	"payload_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid,
	"txid" text,
	"creator_address" text NOT NULL,
	"network" text NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"launch_fee_sats" bigint NOT NULL,
	"miner_fee_sats" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feature_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fee_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"txid" text NOT NULL,
	"event_index" integer NOT NULL,
	"operation" text NOT NULL,
	"expected_sats" bigint NOT NULL,
	"observed_sats" bigint NOT NULL,
	"confirmation_status" text DEFAULT 'PENDING' NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "indexer_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"network" text NOT NULL,
	"last_height" bigint NOT NULL,
	"last_block_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" text NOT NULL,
	"network" text NOT NULL,
	"deployment_id" text NOT NULL,
	"seller_address" text NOT NULL,
	"token_amount_atoms" bigint NOT NULL,
	"asking_price_sats" bigint NOT NULL,
	"creation_height" bigint NOT NULL,
	"expiry_height" bigint NOT NULL,
	"status" text DEFAULT 'BUILDING' NOT NULL,
	"txid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_hash" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"variant" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"deployment_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"token_amount_atoms" bigint NOT NULL,
	"curve_contribution_sats" bigint NOT NULL,
	"platform_fee_sats" bigint NOT NULL,
	"miner_fee_sats" bigint NOT NULL,
	"txid" text,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"block_height" bigint,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "protocol_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"state_hash" text NOT NULL,
	"height" bigint NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"deployment_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"mode" text NOT NULL,
	"tokens_atoms" bigint NOT NULL,
	"curve_contribution_sats" bigint NOT NULL,
	"platform_fee_sats" bigint NOT NULL,
	"estimated_miner_fee_sats" bigint NOT NULL,
	"total_estimated_spend_sats" bigint NOT NULL,
	"starting_stage" integer NOT NULL,
	"ending_stage" integer NOT NULL,
	"supply_before_atoms" bigint NOT NULL,
	"supply_after_atoms" bigint NOT NULL,
	"state_hash" text NOT NULL,
	"expires_at_height" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reorg_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"from_height" bigint NOT NULL,
	"to_height" bigint NOT NULL,
	"orphaned_block_hash" text,
	"details" jsonb,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_address" text,
	"target_type" text NOT NULL,
	"deployment_id" text,
	"reason" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "terms_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"terms_version" text NOT NULL,
	"network" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_metadata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_txid" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"website_url" text,
	"x_url" text,
	"image_hash" text,
	"image_url" text,
	"thumb_url" text,
	"terms_version" text,
	"terms_accepted_at" timestamp with time zone,
	"terms_wallet_address" text,
	"is_verified" boolean DEFAULT false NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_txid" text NOT NULL,
	"ticker" text NOT NULL,
	"ticker_normalized" text NOT NULL,
	"name" text NOT NULL,
	"creator_address" text NOT NULL,
	"network" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"total_supply_atoms" bigint NOT NULL,
	"public_supply_atoms" bigint NOT NULL,
	"reserve_supply_atoms" bigint NOT NULL,
	"confirmed_minted_atoms" bigint NOT NULL,
	"pending_minted_atoms" bigint NOT NULL,
	"reserve_sats" bigint NOT NULL,
	"last_trade_price_per_million" bigint,
	"current_stage" integer DEFAULT 1 NOT NULL,
	"deploy_height" bigint,
	"deploy_block_hash" text,
	"protocol_state_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"deployment_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"buyer_address" text NOT NULL,
	"seller_address" text NOT NULL,
	"token_amount_atoms" bigint NOT NULL,
	"price_sats" bigint NOT NULL,
	"price_per_million_sats" bigint NOT NULL,
	"protocol_fee_sats" bigint NOT NULL,
	"platform_fee_sats" bigint NOT NULL,
	"txid" text NOT NULL,
	"block_height" bigint NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_token_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"wallet_address" text NOT NULL,
	"deployment_id" text NOT NULL,
	"balance_atoms" bigint NOT NULL,
	"pending_atoms" bigint NOT NULL,
	"locked_atoms" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "blocks_network_height_uq" ON "blocks" USING btree ("network","height");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chain_events_network_txid_idx_uq" ON "chain_events" USING btree ("network","txid","event_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chain_events_block_idx" ON "chain_events" USING btree ("network","block_height");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chain_events_deployment_idx" ON "chain_events" USING btree ("deployment_id","block_height");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chain_events_wallet_idx" ON "chain_events" USING btree ("wallet_from","block_height");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chain_tx_network_txid_uq" ON "chain_transactions" USING btree ("network","txid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chain_tx_idempotency_uq" ON "chain_transactions" USING btree ("wallet_address","operation","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chain_tx_wallet_idx" ON "chain_transactions" USING btree ("wallet_address","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deployments_txid_uq" ON "deployments" USING btree ("network","txid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fee_ledger_txid_idx_uq" ON "fee_ledger" USING btree ("network","txid","event_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "listings_listing_id_uq" ON "listings" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listings_deployment_status_idx" ON "listings" USING btree ("deployment_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listings_status_created_idx" ON "listings" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "media_hash_variant_uq" ON "media" USING btree ("content_hash","variant");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mints_txid_uq" ON "mints" USING btree ("network","txid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mints_deployment_idx" ON "mints" USING btree ("deployment_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotes_deployment_idx" ON "quotes" USING btree ("deployment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "terms_wallet_version_uq" ON "terms_acceptances" USING btree ("wallet_address","terms_version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "token_metadata_deployment_uq" ON "token_metadata" USING btree ("deployment_txid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tokens_deployment_network_uq" ON "tokens" USING btree ("network","deployment_txid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tokens_ticker_idx" ON "tokens" USING btree ("network","ticker_normalized");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tokens_status_created_idx" ON "tokens" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tokens_status_minted_idx" ON "tokens" USING btree ("status","confirmed_minted_atoms");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trades_txid_uq" ON "trades" USING btree ("network","txid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trades_deployment_idx" ON "trades" USING btree ("deployment_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trades_block_idx" ON "trades" USING btree ("block_height");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "balances_wallet_deployment_uq" ON "wallet_token_balances" USING btree ("network","wallet_address","deployment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "balances_wallet_idx" ON "wallet_token_balances" USING btree ("wallet_address");