import type { FundingInputChecker } from "./funding.js";
export const CONFIRMED_FUNDING_FOR_TESTS: FundingInputChecker = {
  async check() {
    return { ok: true };
  },
};
