import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { businesses, users } from "../db/schema";
import { authPlugin, requireAuth, requireOwner } from "../lib/auth";

export const authRoutes = new Elysia({ prefix: "/auth" })
  .use(authPlugin)

  // Register a business + its owner account
  .post(
    "/register",
    async ({ body, jwt, set }) => {
      const email = body.email.toLowerCase().trim();

      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing) {
        set.status = 409;
        return { error: "An account with this email already exists." };
      }

      const [business] = await db
        .insert(businesses)
        .values({ name: body.businessName })
        .returning();

      const [user] = await db
        .insert(users)
        .values({
          businessId: business.id,
          name: body.name,
          email,
          passwordHash: await Bun.password.hash(body.password),
          role: "owner",
        })
        .returning();

      const token = await jwt.sign({ sub: user.id });

      set.status = 201;
      return {
        token,
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
        business: { id: business.id, name: business.name },
      };
    },
    {
      body: t.Object({
        businessName: t.String({ minLength: 2 }),
        name: t.String({ minLength: 2 }),
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 8 }),
      }),
    }
  )

  .post(
    "/login",
    async ({ body, jwt, set }) => {
      const email = body.email.toLowerCase().trim();

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (!user || !user.active) {
        set.status = 401;
        return { error: "Invalid email or password." };
      }

      const ok = await Bun.password.verify(body.password, user.passwordHash);
      if (!ok) {
        set.status = 401;
        return { error: "Invalid email or password." };
      }

      const token = await jwt.sign({ sub: user.id });

      return {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          businessId: user.businessId,
        },
      };
    },
    {
      body: t.Object({
        email: t.String(),
        password: t.String(),
      }),
    }
  )

  .get("/me", ({ user }) => ({ user }), { beforeHandle: requireAuth })

  // Owner creates a staff account
  .post(
    "/staff",
    async ({ body, user, set }) => {
      const email = body.email.toLowerCase().trim();

      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing) {
        set.status = 409;
        return { error: "An account with this email already exists." };
      }

      const [staff] = await db
        .insert(users)
        .values({
          businessId: user!.businessId,
          name: body.name,
          email,
          passwordHash: await Bun.password.hash(body.password),
          role: "staff",
        })
        .returning();

      set.status = 201;
      return {
        user: { id: staff.id, name: staff.name, email: staff.email, role: staff.role },
      };
    },
    {
      beforeHandle: requireOwner,
      body: t.Object({
        name: t.String({ minLength: 2 }),
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 8 }),
      }),
    }
  )

  // Owner deactivates a staff account (past sales are preserved)
  .patch(
    "/staff/:id/deactivate",
    async ({ params, user, set }) => {
      const [target] = await db
        .select()
        .from(users)
        .where(eq(users.id, params.id))
        .limit(1);

      if (!target || target.businessId !== user!.businessId) {
        set.status = 404;
        return { error: "Staff member not found." };
      }
      if (target.role === "owner") {
        set.status = 400;
        return { error: "The owner account cannot be deactivated." };
      }

      const [updated] = await db
        .update(users)
        .set({ active: false })
        .where(eq(users.id, params.id))
        .returning();

      return { user: { id: updated.id, name: updated.name, active: updated.active } };
    },
    { beforeHandle: requireOwner }
  );
