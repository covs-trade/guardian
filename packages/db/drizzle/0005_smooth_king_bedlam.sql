ALTER TABLE "cove_v3_events" ADD COLUMN "amount_atoms" bigint;--> statement-breakpoint
ALTER TABLE "cove_v3_events" ADD COLUMN "gross_sats" bigint;--> statement-breakpoint
ALTER TABLE "cove_v3_events" ADD COLUMN "fee_sats" bigint;--> statement-breakpoint
ALTER TABLE "cove_v3_events" ADD COLUMN "supply_after_atoms" bigint;--> statement-breakpoint
ALTER TABLE "cove_v3_events" ADD COLUMN "backing_after_sats" bigint;