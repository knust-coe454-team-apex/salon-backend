import { Elysia } from "elysia";
import { and, eq, gte, lte, desc } from "drizzle-orm";
import { db } from "../db";
import { sales, saleItems, products } from "../db/schema";
import { authPlugin, requireAuth } from "../lib/auth";
import { toNum } from "../lib/validate";

function todayBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { start, end };
}

export const dashboardRoutes = new Elysia({ prefix: "/dashboard" })
  .use(authPlugin)

  .get(
    "/",
    async ({ user }) => {
      const { start, end } = todayBounds();
      const isOwner = user!.role === "owner";

      // Today's sales
      const todaySales = await db
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
      for (const s of todaySales) {
        const amt = Number(s.total);
        if (s.paymentMethod === "cash") cash += amt;
        else momo += amt;
      }
      const totalToday = cash + momo;

      // Recent activity (last 5 sales, with their items)
      const recent = await db
        .select()
        .from(sales)
        .where(eq(sales.businessId, user!.businessId))
        .orderBy(desc(sales.createdAt))
        .limit(5);

      const recentActivity = await Promise.all(
        recent.map(async (s) => {
          const items = await db.select().from(saleItems).where(eq(saleItems.saleId, s.id));
          return {
            id: s.id,
            date: s.createdAt,
            total: toNum(s.total),
            paymentMethod: s.paymentMethod,
            itemCount: items.length,
          };
        })
      );

      // Low-stock count
      const lowStock = await db
        .select()
        .from(products)
        .where(
          and(
            eq(products.businessId, user!.businessId),
            eq(products.archived, false),
            lte(products.quantity, products.minStockLevel)
          )
        );

      // Staff see a reduced dashboard — no financial totals (US-14 criterion)
      if (!isOwner) {
        return {
          role: "staff",
          salesCountToday: todaySales.length,
          lowStockCount: lowStock.length,
          recentActivity: recentActivity.map((r) => ({
            id: r.id,
            date: r.date,
            paymentMethod: r.paymentMethod,
            itemCount: r.itemCount,
          })),
        };
      }

      return {
        role: "owner",
        today: {
          totalTakings: Number(totalToday.toFixed(2)),
          salesCount: todaySales.length,
          cash: Number(cash.toFixed(2)),
          momo: Number(momo.toFixed(2)),
        },
        lowStockCount: lowStock.length,
        recentActivity,
      };
    },
    { beforeHandle: requireAuth }
  );
  