ALTER TABLE "cove_v3_market_fills" ADD COLUMN "buyer_fund_public_key" text;--> statement-breakpoint
ALTER TABLE "cove_v3_market_listings" ADD COLUMN "seller_token_public_key" text;