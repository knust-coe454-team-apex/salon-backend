import { Elysia } from "elysia";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../db";
import { sales, saleItems, products } from "../db/schema";
import { authPlugin, requireAuth } from "../lib/auth";

// Start and end of a given day (defaults to today), in the server's time.
function dayBounds(dateStr?: string) {
  const base = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 59, 999);
  return { start, end };
}

export const reportRoutes = new Elysia({ prefix: "/reports" })
  .use(authPlugin)

  // Daily earnings summary — US-06 (the client's core pain point)
  .get(
    "/daily",
    async ({ user, query }) => {
      const { start, end } = dayBounds(query.date);

      const daySales = await db
        .select()
        .from(sales)
        .where(
          and(
            eq(sales.businessId, user!.businessId),
            gte(sales.createdAt, start),
            lte(sales.createdAt, end)
          )
        );

      let cash = 0;
      let momo = 0;
      for (const s of daySales) {
        const amt = Number(s.total);
        if (s.paymentMethod === "cash") cash += amt;
        else momo += amt;
      }

      // Split income into product vs service by reading the line items
      let productIncome = 0;
      let serviceIncome = 0;
      for (const s of daySales) {
        const items = await db.select().from(saleItems).where(eq(saleItems.saleId, s.id));
        for (const i of items) {
          const line = Number(i.unitPrice) * i.quantity;
          if (i.itemType === "product") productIncome += line;
          else serviceIncome += line;
        }
      }

      const total = cash + momo;

      return {
        date: start.toISOString().slice(0, 10),
        totalTakings: Number(total.toFixed(2)),
        salesCount: daySales.length,
        byPaymentMethod: {
          cash: Number(cash.toFixed(2)),
          momo: Number(momo.toFixed(2)),
        },
        byType: {
          product: Number(productIncome.toFixed(2)),
          service: Number(serviceIncome.toFixed(2)),
        },
      };
    },
    { beforeHandle: requireAuth }
  )

  // Low-stock list — US-08
  .get(
    "/low-stock",
    async ({ user }) => {
      const rows = await db
        .select()
        .from(products)
        .where(
          and(
            eq(products.businessId, user!.businessId),
            eq(products.archived, false),
            lte(products.quantity, products.minStockLevel)
          )
        );

      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        quantity: p.quantity,
        minStockLevel: p.minStockLevel,
        supplierId: p.supplierId,
      }));
    },
    { beforeHandle: requireAuth }
  );
  