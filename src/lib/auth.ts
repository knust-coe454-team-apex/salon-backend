import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";

export const authPlugin = new Elysia({ name: "auth" })
  .use(
    jwt({
      name: "jwt",
      secret: process.env.JWT_SECRET || "dev-secret-change-me",
      exp: "7d",
    })
  )
  .derive({ as: "scoped" }, async ({ jwt, headers }) => {
    const header = headers.authorization;
    if (!header?.startsWith("Bearer ")) return { user: null };

    const payload = await jwt.verify(header.slice(7));
    if (!payload || typeof payload.sub !== "string") return { user: null };

    const [found] = await db
      .select()
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);

    if (!found || !found.active) return { user: null };

    return {
      user: {
        id: found.id,
        businessId: found.businessId,
        name: found.name,
        email: found.email,
        role: found.role,
      },
    };
  });

export const requireAuth = ({ user, set }: any) => {
  if (!user) {
    set.status = 401;
    return { error: "Unauthorized. A valid token is required." };
  }
};

export const requireOwner = ({ user, set }: any) => {
  if (!user) {
    set.status = 401;
    return { error: "Unauthorized. A valid token is required." };
  }
  if (user.role !== "owner") {
    set.status = 403;
    return { error: "Forbidden. This action is restricted to the business owner." };
  }
};
