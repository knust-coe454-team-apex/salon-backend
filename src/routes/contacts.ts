import { Elysia, t } from "elysia";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../db";
import { customers, suppliers, sales, saleItems, products } from "../db/schema";
import { authPlugin, requireAuth } from "../lib/auth";
import { toNum } from "../lib/validate";

export const customerRoutes = new Elysia({ prefix: "/customers" })
  .use(authPlugin)

  .get(
    "/",
    async ({ user }) => {
      return db.select().from(customers).where(eq(customers.businessId, user!.businessId));
    },
    { beforeHandle: requireAuth }
  )

  .post(
    "/",
    async ({ body, user, set }) => {
      const [row] = await db
        .insert(customers)
        .values({
          businessId: user!.businessId,
          name: body.name,
          phone: body.phone ?? null,
          notes: body.notes ?? null,
        })
        .returning();
      set.status = 201;
      return row;
    },
    {
      beforeHandle: requireAuth,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        phone: t.Optional(t.String()),
        notes: t.Optional(t.String()),
      }),
    }
  )

  .patch(
    "/:id",
    async ({ params, body, user, set }) => {
      const [existing] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.id, params.id), eq(customers.businessId, user!.businessId)))
        .limit(1);
      if (!existing) {
        set.status = 404;
        return { error: "Customer not found." };
      }
      const [row] = await db
        .update(customers)
        .set({
          name: body.name ?? existing.name,
          phone: body.phone ?? existing.phone,
          notes: body.notes ?? existing.notes,
        })
        .where(eq(customers.id, params.id))
        .returning();
      return row;
    },
    {
      beforeHandle: requireAuth,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        phone: t.Optional(t.String()),
        notes: t.Optional(t.String()),
      }),
    }
  )

  // Customer profile with full purchase/service history (US-10)
  .get(
    "/:id/history",
    async ({ params, user, set }) => {
      const [customer] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.id, params.id), eq(customers.businessId, user!.businessId)))
        .limit(1);
      if (!customer) {
        set.status = 404;
        return { error: "Customer not found." };
      }

      const customerSales = await db
        .select()
        .from(sales)
        .where(eq(sales.customerId, params.id))
        .orderBy(desc(sales.createdAt));

      const withItems = await Promise.all(
        customerSales.map(async (sale) => {
          const items = await db.select().from(saleItems).where(eq(saleItems.saleId, sale.id));
          return {
            id: sale.id,
            date: sale.createdAt,
            total: toNum(sale.total),
            paymentMethod: sale.paymentMethod,
            items: items.map((i) => ({
              type: i.itemType,
              name: i.nameSnapshot,
              unitPrice: toNum(i.unitPrice),
              quantity: i.quantity,
            })),
          };
        })
      );

      return { customer, visits: withItems };
    },
    { beforeHandle: requireAuth }
  );

export const supplierRoutes = new Elysia({ prefix: "/suppliers" })
  .use(authPlugin)

  .get(
    "/",
    async ({ user }) => {
      return db.select().from(suppliers).where(eq(suppliers.businessId, user!.businessId));
    },
    { beforeHandle: requireAuth }
  )

  .post(
    "/",
    async ({ body, user, set }) => {
      const [row] = await db
        .insert(suppliers)
        .values({
          businessId: user!.businessId,
          name: body.name,
          phone: body.phone ?? null,
          notes: body.notes ?? null,
        })
        .returning();
      set.status = 201;
      return row;
    },
    {
      beforeHandle: requireAuth,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        phone: t.Optional(t.String()),
        notes: t.Optional(t.String()),
      }),
    }
  )

  // Products supplied by this supplier (US-11)
  .get(
    "/:id/products",
    async ({ params, user }) => {
      return db
        .select()
        .from(products)
        .where(and(eq(products.supplierId, params.id), eq(products.businessId, user!.businessId)));
    },
    { beforeHandle: requireAuth }
  );
  