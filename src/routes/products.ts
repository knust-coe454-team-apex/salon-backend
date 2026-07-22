import { Elysia, t } from "elysia";
import { and, eq, ilike } from "drizzle-orm";
import { db } from "../db";
import { products, inventoryChanges } from "../db/schema";
import { authPlugin, requireAuth, requireOwner } from "../lib/auth";
import { toNum } from "../lib/validate";

const shape = (p: any) => ({
  ...p,
  costPrice: toNum(p.costPrice),
  sellingPrice: toNum(p.sellingPrice),
});

export const productRoutes = new Elysia({ prefix: "/products" })
  .use(authPlugin)

  // List products for this business (optional ?search= and ?includeArchived=)
  .get(
    "/",
    async ({ user, query }) => {
      const filters = [eq(products.businessId, user!.businessId)];
      if (!query.includeArchived) filters.push(eq(products.archived, false));
      if (query.search) filters.push(ilike(products.name, `%${query.search}%`));

      const rows = await db.select().from(products).where(and(...filters));
      return rows.map(shape);
    },
    { beforeHandle: requireAuth }
  )

  // Single product
  .get(
    "/:id",
    async ({ params, user, set }) => {
      const [row] = await db
        .select()
        .from(products)
        .where(and(eq(products.id, params.id), eq(products.businessId, user!.businessId)))
        .limit(1);
      if (!row) {
        set.status = 404;
        return { error: "Product not found." };
      }
      return shape(row);
    },
    { beforeHandle: requireAuth }
  )

  // Create a product (owner or staff)
  .post(
    "/",
    async ({ body, user, set }) => {
      const [row] = await db
        .insert(products)
        .values({
          businessId: user!.businessId,
          name: body.name,
          category: body.category ?? null,
          costPrice: String(body.costPrice ?? 0),
          sellingPrice: String(body.sellingPrice),
          quantity: body.quantity ?? 0,
          minStockLevel: body.minStockLevel ?? 5,
          barcode: body.barcode ?? null,
          supplierId: body.supplierId ?? null,
        })
        .returning();

      if (!row) {
        set.status = 500;
        return { error: "Failed to create product." };
      }

      // If it opens with stock, log that as an initial movement
      if ((body.quantity ?? 0) > 0) {
        await db.insert(inventoryChanges).values({
          productId: row.id,
          userId: user!.id,
          delta: body.quantity!,
          reason: "restock",
          note: "Initial stock",
        });
      }

      set.status = 201;
      return shape(row);
    },
    {
      beforeHandle: requireAuth,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        category: t.Optional(t.String()),
        costPrice: t.Optional(t.Number({ minimum: 0 })),
        sellingPrice: t.Number({ minimum: 0 }),
        quantity: t.Optional(t.Integer({ minimum: 0 })),
        minStockLevel: t.Optional(t.Integer({ minimum: 0 })),
        barcode: t.Optional(t.String()),
        supplierId: t.Optional(t.String()),
      }),
    }
  )

  // Update product details (not stock — stock changes go through /restock)
  .patch(
    "/:id",
    async ({ params, body, user, set }) => {
      const [existing] = await db
        .select()
        .from(products)
        .where(and(eq(products.id, params.id), eq(products.businessId, user!.businessId)))
        .limit(1);
      if (!existing) {
        set.status = 404;
        return { error: "Product not found." };
      }

      const [row] = await db
        .update(products)
        .set({
          name: body.name ?? existing.name,
          category: body.category ?? existing.category,
          costPrice: body.costPrice !== undefined ? String(body.costPrice) : existing.costPrice,
          sellingPrice: body.sellingPrice !== undefined ? String(body.sellingPrice) : existing.sellingPrice,
          minStockLevel: body.minStockLevel ?? existing.minStockLevel,
          barcode: body.barcode ?? existing.barcode,
          supplierId: body.supplierId ?? existing.supplierId,
          archived: body.archived ?? existing.archived,
          updatedAt: new Date(),
        })
        .where(eq(products.id, params.id))
        .returning();
      return shape(row);
    },
    {
      beforeHandle: requireAuth,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        category: t.Optional(t.String()),
        costPrice: t.Optional(t.Number({ minimum: 0 })),
        sellingPrice: t.Optional(t.Number({ minimum: 0 })),
        minStockLevel: t.Optional(t.Integer({ minimum: 0 })),
        barcode: t.Optional(t.String()),
        supplierId: t.Optional(t.String()),
        archived: t.Optional(t.Boolean()),
      }),
    }
  )

  // Restock or correct stock — recorded in the movement history
  .post(
    "/:id/restock",
    async ({ params, body, user, set }) => {
      const [existing] = await db
        .select()
        .from(products)
        .where(and(eq(products.id, params.id), eq(products.businessId, user!.businessId)))
        .limit(1);
      if (!existing) {
        set.status = 404;
        return { error: "Product not found." };
      }

      const newQty = existing.quantity + body.delta;
      if (newQty < 0) {
        set.status = 400;
        return { error: "Resulting stock cannot be negative." };
      }

      const [row] = await db
        .update(products)
        .set({ quantity: newQty, updatedAt: new Date() })
        .where(eq(products.id, params.id))
        .returning();

      if (!row) {
        set.status = 500;
        return { error: "Failed to update stock." };
      }

      await db.insert(inventoryChanges).values({
        productId: params.id,
        userId: user!.id,
        delta: body.delta,
        reason: body.reason ?? "restock",
        note: body.note ?? null,
      });

      return shape(row);
    },
    {
      beforeHandle: requireAuth,
      body: t.Object({
        delta: t.Integer(),
        reason: t.Optional(t.Union([t.Literal("restock"), t.Literal("correction"), t.Literal("damage")])),
        note: t.Optional(t.String()),
      }),
    }
  )

  // Movement history for one product
  .get(
    "/:id/history",
    async ({ params, user }) => {
      const rows = await db
        .select()
        .from(inventoryChanges)
        .where(eq(inventoryChanges.productId, params.id));
      return rows;
    },
    { beforeHandle: requireAuth }
  );
  