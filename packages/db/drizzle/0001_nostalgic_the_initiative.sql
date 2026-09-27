CREATE TABLE IF NOT EXISTS "cove_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"owner_script" text NOT NULL,
	"deployment_id" text NOT NULL,
	"available_atoms" bigint NOT NULL,
	"locked_atoms" bigint NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"height" bigint NOT NULL,
	"hash" text NOT NULL,
	"parent_hash" text NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"height" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"state_root" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_cursor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"height" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"txid" text NOT NULL,
	"block_height" bigint NOT NULL,
	"tx_index" integer NOT NULL,
	"operation" text,
	"classification" text NOT NULL,
	"valid" boolean NOT NULL,
	"reason" text,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cove_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"deployment_id" text NOT NULL,
	"ticker" text NOT NULL,
	"creator" text NOT NULL,
	"confirmed_supply_atoms" bigint NOT NULL,
	"current_stage" integer NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_balances_owner_uq" ON "cove_balances" USING btree ("network","owner_script","deployment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_blocks_height_uq" ON "cove_blocks" USING btree ("network","height");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_checkpoints_height_uq" ON "cove_checkpoints" USING btree ("network","height");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_cursor_network_uq" ON "cove_cursor" USING btree ("network");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_ops_txid_uq" ON "cove_operations" USING btree ("network","txid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_tokens_deployment_uq" ON "cove_tokens" USING btree ("network","deployment_id");