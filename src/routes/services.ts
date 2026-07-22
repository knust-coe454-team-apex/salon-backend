import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { services } from "../db/schema";
import { authPlugin, requireAuth } from "../lib/auth";
import { toNum } from "../lib/validate";

const shape = (s: any) => ({ ...s, price: toNum(s.price) });

export const serviceRoutes = new Elysia({ prefix: "/services" })
  .use(authPlugin)

  // List services (optional ?includeArchived=)
  .get(
    "/",
    async ({ user, query }) => {
      const filters = [eq(services.businessId, user!.businessId)];
      if (!query.includeArchived) filters.push(eq(services.archived, false));
      const rows = await db.select().from(services).where(and(...filters));
      return rows.map(shape);
    },
    { beforeHandle: requireAuth }
  )

  // Create a service
  .post(
    "/",
    async ({ body, user, set }) => {
      const [row] = await db
        .insert(services)
        .values({
          businessId: user!.businessId,
          name: body.name,
          price: String(body.price),
        })
        .returning();
      set.status = 201;
      return shape(row);
    },
    {
      beforeHandle: requireAuth,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        price: t.Number({ minimum: 0 }),
      }),
    }
  )

  // Update a service (edit price/name, or archive)
  .patch(
    "/:id",
    async ({ params, body, user, set }) => {
      const [existing] = await db
        .select()
        .from(services)
        .where(and(eq(services.id, params.id), eq(services.businessId, user!.businessId)))
        .limit(1);
      if (!existing) {
        set.status = 404;
        return { error: "Service not found." };
      }

      const [row] = await db
        .update(services)
        .set({
          name: body.name ?? existing.name,
          price: body.price !== undefined ? String(body.price) : existing.price,
          archived: body.archived ?? existing.archived,
          updatedAt: new Date(),
        })
        .where(eq(services.id, params.id))
        .returning();
      return shape(row);
    },
    {
      beforeHandle: requireAuth,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        price: t.Optional(t.Number({ minimum: 0 })),
        archived: t.Optional(t.Boolean()),
      }),
    }
  );
  