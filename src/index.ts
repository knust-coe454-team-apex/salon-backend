import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";

const app = new Elysia()
  .use(cors())
  .get("/", () => ({
    name: "Salon Backend API",
    status: "running",
    version: "0.1.0",
  }))
  .get("/health", () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }))
  .listen({ port: Number(process.env.PORT) || 3000, hostname: "0.0.0.0" });

console.log(`Salon backend running at http://localhost:${app.server?.port}`);

export type App = typeof app;
