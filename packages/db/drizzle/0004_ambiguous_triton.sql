CREATE TABLE IF NOT EXISTS "cove_v3_app_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"operation" text NOT NULL,
	"token_id" text,
	"wallet_script" text NOT NULL,
	"wallet_address" text,
	"state_hash" text,
	"backing_txid" text,
	"backing_vout" integer,
	"unsigned_tx_digest" text,
	"psbt_base64" text,
	"txid" text,
	"status" text DEFAULT 'BUILT' NOT NULL,
	"expires_at_height" bigint,
	"error_code" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_backing_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"token_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"state_version" integer NOT NULL,
	"policy_version" integer NOT NULL,
	"issued_supply_atoms" bigint NOT NULL,
	"backing_sats" bigint NOT NULL,
	"curve_stage" integer NOT NULL,
	"txid" text NOT NULL,
	"vout" integer NOT NULL,
	"script_pub_key" text NOT NULL,
	"btc_value" bigint NOT NULL,
	"block_height" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"height" bigint NOT NULL,
	"hash" text NOT NULL,
	"parent_hash" text NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_cursor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"height" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"state_root" text NOT NULL,
	"rebuilding" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"txid" text NOT NULL,
	"block_height" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_index" integer NOT NULL,
	"operation" text,
	"valid" boolean NOT NULL,
	"reason" text,
	"token_id" text,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_guardian_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"request_id" text NOT NULL,
	"operation" text NOT NULL,
	"token_id" text NOT NULL,
	"backing_txid" text NOT NULL,
	"backing_vout" integer NOT NULL,
	"prev_state_hash" text NOT NULL,
	"next_state_hash" text NOT NULL,
	"amount_atoms" bigint NOT NULL,
	"gross_sats" bigint NOT NULL,
	"protocol_fee_sats" bigint NOT NULL,
	"miner_fee_sats" bigint NOT NULL,
	"policy_version" integer NOT NULL,
	"vault_profile_version" text NOT NULL,
	"expected_cmr" text NOT NULL,
	"actual_cmr" text NOT NULL,
	"simplicity_result" text NOT NULL,
	"reference_policy_result" text NOT NULL,
	"unsigned_tx_digest" text NOT NULL,
	"decision" text NOT NULL,
	"rejection_reason" text,
	"before_sign_persisted_at" timestamp with time zone NOT NULL,
	"signed_at" timestamp with time zone,
	"previous_audit_hash" text NOT NULL,
	"audit_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_market_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" text NOT NULL,
	"cancel_hash" text NOT NULL,
	"cancel_nonce" text NOT NULL,
	"signature_b64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_market_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"listing_id" text,
	"fill_id" text,
	"event_type" text NOT NULL,
	"payload_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_market_fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" text NOT NULL,
	"network" text NOT NULL,
	"token_id" text NOT NULL,
	"buyer_token_script" text NOT NULL,
	"buyer_change_script" text NOT NULL,
	"buyer_fund_inputs" jsonb NOT NULL,
	"amount_atoms" bigint NOT NULL,
	"total_price_sats" bigint NOT NULL,
	"market_fee_sats" bigint NOT NULL,
	"extra_carrier_sats" bigint NOT NULL,
	"miner_fee_sats" bigint NOT NULL,
	"unsigned_tx_digest" text,
	"psbt_base64" text,
	"status" text DEFAULT 'RESERVED' NOT NULL,
	"txid" text,
	"block_height" bigint,
	"block_hash" text,
	"canonical" boolean DEFAULT true NOT NULL,
	"failure_reason" text,
	"reservation_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_market_listing_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" text NOT NULL,
	"source_txid" text NOT NULL,
	"source_vout" integer NOT NULL,
	"amount_atoms" bigint NOT NULL,
	"script_pub_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_market_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" text NOT NULL,
	"network" text NOT NULL,
	"chain_identity" text NOT NULL,
	"token_id" text NOT NULL,
	"order_version" integer NOT NULL,
	"seller_token_script" text NOT NULL,
	"seller_payout_script" text NOT NULL,
	"seller_token_change_script" text NOT NULL,
	"source_txid" text NOT NULL,
	"source_vout" integer NOT NULL,
	"source_amount_atoms" bigint NOT NULL,
	"amount_atoms" bigint NOT NULL,
	"total_price_sats" bigint NOT NULL,
	"creation_height" bigint NOT NULL,
	"expiry_height" bigint NOT NULL,
	"nonce" text NOT NULL,
	"signature_b64" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_market_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"token_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"fill_id" text NOT NULL,
	"seller_token_script" text NOT NULL,
	"buyer_token_script" text NOT NULL,
	"amount_atoms" bigint NOT NULL,
	"total_price_sats" bigint NOT NULL,
	"market_fee_sats" bigint NOT NULL,
	"miner_fee_sats" bigint NOT NULL,
	"txid" text NOT NULL,
	"block_height" bigint NOT NULL,
	"block_hash" text,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_signing_journal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"backing_txid" text NOT NULL,
	"backing_vout" integer NOT NULL,
	"unsigned_tx_digest" text NOT NULL,
	"signature_hash" text,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_token_metadata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"token_id" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"website_url" text,
	"x_url" text,
	"image_url" text,
	"submitted_by_script" text NOT NULL,
	"deploy_txid" text,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_token_utxos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"txid" text NOT NULL,
	"vout" integer NOT NULL,
	"token_id" text NOT NULL,
	"amount_atoms" bigint NOT NULL,
	"script_pub_key" text NOT NULL,
	"created_height" bigint NOT NULL,
	"created_block_hash" text NOT NULL,
	"spent_by_txid" text,
	"spent_height" bigint,
	"spent_block_hash" text,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"token_id" text NOT NULL,
	"ticker" text NOT NULL,
	"policy_version" integer NOT NULL,
	"nonce" text NOT NULL,
	"deploy_txid" text NOT NULL,
	"deploy_height" bigint NOT NULL,
	"deploy_block_hash" text NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_v3_undo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"height" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"undo_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_app_tx_idempotency_uq" ON "cove_v3_app_transactions" USING btree ("network","wallet_script","operation","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_app_tx_txid_uq" ON "cove_v3_app_transactions" USING btree ("network","txid") WHERE "cove_v3_app_transactions"."txid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_app_tx_status_idx" ON "cove_v3_app_transactions" USING btree ("network","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_app_tx_wallet_idx" ON "cove_v3_app_transactions" USING btree ("network","wallet_script","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_backing_token_uq" ON "cove_v3_backing_states" USING btree ("network","token_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_backing_outpoint_idx" ON "cove_v3_backing_states" USING btree ("network","txid","vout");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_blocks_height_uq" ON "cove_v3_blocks" USING btree ("network","height");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_blocks_hash_idx" ON "cove_v3_blocks" USING btree ("network","hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_cursor_network_uq" ON "cove_v3_cursor" USING btree ("network");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_events_txid_uq" ON "cove_v3_events" USING btree ("network","txid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_events_block_idx" ON "cove_v3_events" USING btree ("network","block_height");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_events_token_idx" ON "cove_v3_events" USING btree ("network","token_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_guardian_audit_hash_uq" ON "cove_v3_guardian_audit" USING btree ("network","audit_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_guardian_audit_outpoint_idx" ON "cove_v3_guardian_audit" USING btree ("network","backing_txid","backing_vout");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_market_cancellations_hash_uq" ON "cove_v3_market_cancellations" USING btree ("listing_id","cancel_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_market_events_listing_idx" ON "cove_v3_market_events" USING btree ("listing_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_market_fills_listing_idx" ON "cove_v3_market_fills" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_market_fills_status_idx" ON "cove_v3_market_fills" USING btree ("network","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_market_fills_txid_uq" ON "cove_v3_market_fills" USING btree ("network","txid") WHERE "cove_v3_market_fills"."txid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_market_listing_inputs_listing_idx" ON "cove_v3_market_listing_inputs" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_market_listing_inputs_outpoint_uq" ON "cove_v3_market_listing_inputs" USING btree ("listing_id","source_txid","source_vout");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_market_listings_id_uq" ON "cove_v3_market_listings" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_market_listings_token_status_idx" ON "cove_v3_market_listings" USING btree ("network","token_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_market_listings_status_created_idx" ON "cove_v3_market_listings" USING btree ("network","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_market_listings_source_active_uq" ON "cove_v3_market_listings" USING btree ("network","source_txid","source_vout") WHERE "cove_v3_market_listings"."status" in ('ACTIVE', 'RESERVED', 'BROADCAST');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_market_trades_txid_uq" ON "cove_v3_market_trades" USING btree ("network","txid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_market_trades_token_idx" ON "cove_v3_market_trades" USING btree ("network","token_id","block_height");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_signing_journal_outpoint_uq" ON "cove_v3_signing_journal" USING btree ("network","backing_txid","backing_vout");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_token_metadata_token_uq" ON "cove_v3_token_metadata" USING btree ("network","token_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_utxo_outpoint_uq" ON "cove_v3_token_utxos" USING btree ("network","txid","vout");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_utxo_token_idx" ON "cove_v3_token_utxos" USING btree ("network","token_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_utxo_script_idx" ON "cove_v3_token_utxos" USING btree ("network","script_pub_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_tokens_id_uq" ON "cove_v3_tokens" USING btree ("network","token_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_undo_height_uq" ON "cove_v3_undo" USING btree ("network","height");