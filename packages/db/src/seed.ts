import { createDb } from "./client.js";
import { featureFlags } from "./schema.js";
async function main() {
  const url =
    process.env.DATABASE_URL ?? "postgres://cove:cove@localhost:5432/cove";
  const db = createDb(url);
  const flags = [
    {
      id: "pause_new_launches",
      enabled: false,
      description: "Pause new launches",
    },
    {
      id: "pause_primary_mint",
      enabled: false,
      description: "Pause primary mint UI",
    },
    {
      id: "pause_marketplace",
      enabled: false,
      description: "Pause marketplace UI",
    },
  ];
  for (const f of flags) {
    await db
      .insert(featureFlags)
      .values({ ...f, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: featureFlags.id,
        set: { enabled: f.enabled, updatedAt: new Date() },
      });
  }
  console.log("Seeded feature flags:", flags.map((f) => f.id).join(", "));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
