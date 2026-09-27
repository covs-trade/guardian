import { defineConfig } from "drizzle-kit";
export default defineConfig({
    schema: "./src/schema.ts",
    out: "./drizzle",
    dialect: "postgresql",
    dbCredentials: {
        url: process.env.DATABASE_URL ?? "postgres://cove:cove@localhost:5432/cove",
    },
    verbose: true,
    strict: true,
});
