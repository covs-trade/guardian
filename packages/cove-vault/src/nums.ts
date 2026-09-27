export const COVE_NUMS_X_ONLY =
  "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
export function numsInternalKey(): Buffer {
  return Buffer.from(COVE_NUMS_X_ONLY, "hex");
}
