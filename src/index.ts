import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { db } from "./db";
import { sql } from "drizzle-orm";

const app = new Elysia()
  .use(cors())
  .get("/", () => ({
    name: "Salon Backend API",
    status: "running",
    version: "0.2.0",
  }))
  .get("/health", async () => {
    try {
      const result = await db.execute(
        sql`select count(*)::int as tables from information_schema.tables where table_schema = 'public'`
      );
      return {
        status: "ok",
        database: "connected",
        tables: result[0]?.tables ?? 0,
        timestamp: new Date().toISOString(),
      };
    } catch (e) {
      return { status: "degraded", database: "unreachable", error: String(e) };
    }
  })
  .listen({ port: Number(process.env.PORT) || 3000, hostname: "0.0.0.0" });

console.log(`Salon backend running at http://localhost:${app.server?.port}`);

export type App = typeof app;
