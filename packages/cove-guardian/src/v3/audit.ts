import type { AuditRecord } from "./types.js";
export interface AuditSink {
  write(record: AuditRecord): void;
}
function bigintSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigintSafe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = bigintSafe(v);
    return out;
  }
  return value;
}
export const consoleAuditSink: AuditSink = {
  write(record) {
    try {
      console.log(
        `[cove-guardian-audit] ${JSON.stringify(bigintSafe(record))}`,
      );
    } catch {
      return;
    }
  },
};
export function noopAuditSink(): AuditSink {
  return { write: () => {} };
}
