import { Elysia } from "elysia";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../db";
import { sales, saleItems, products, expenses } from "../db/schema";
import { authPlugin, requireAuth, requireOwner } from "../lib/auth";

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

  // Period report: sales, expenses, net, and best sellers — US-12 (owner only)
  .get(
    "/range",
    async ({ user, query, set }) => {
      if (!query.from || !query.to) {
        set.status = 400;
        return { error: "Both 'from' and 'to' dates are required (YYYY-MM-DD)." };
      }

      const start = new Date(`${query.from}T00:00:00`);
      const end = new Date(`${query.to}T23:59:59.999`);

      const periodSales = await db
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
      for (const s of periodSales) {
        const amt = Number(s.total);
        if (s.paymentMethod === "cash") cash += amt;
        else momo += amt;
      }
      const totalSales = cash + momo;

      // Tally income and units by item, split by type
      let productIncome = 0;
      let serviceIncome = 0;
      const tally = new Map<string, { name: string; type: string; quantity: number; income: number }>();

      for (const s of periodSales) {
        const items = await db.select().from(saleItems).where(eq(saleItems.saleId, s.id));
        for (const i of items) {
          const line = Number(i.unitPrice) * i.quantity;
          if (i.itemType === "product") productIncome += line;
          else serviceIncome += line;

          const key = `${i.itemType}:${i.nameSnapshot}`;
          const prev = tally.get(key) ?? { name: i.nameSnapshot, type: i.itemType, quantity: 0, income: 0 };
          prev.quantity += i.quantity;
          prev.income += line;
          tally.set(key, prev);
        }
      }

      const ranked = [...tally.values()].sort((a, b) => b.income - a.income);
      const topProducts = ranked.filter((r) => r.type === "product").slice(0, 5)
        .map((r) => ({ ...r, income: Number(r.income.toFixed(2)) }));
      const topServices = ranked.filter((r) => r.type === "service").slice(0, 5)
        .map((r) => ({ ...r, income: Number(r.income.toFixed(2)) }));

      // Expenses in the same window
      const periodExpenses = await db
        .select()
        .from(expenses)
        .where(
          and(
            eq(expenses.businessId, user!.businessId),
            gte(expenses.spentAt, start),
            lte(expenses.spentAt, end)
          )
        );

      let totalExpenses = 0;
      const byCategory = new Map<string, number>();
      for (const e of periodExpenses) {
        const amt = Number(e.amount);
        totalExpenses += amt;
        byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + amt);
      }

      return {
        period: { from: query.from, to: query.to },
        sales: {
          total: Number(totalSales.toFixed(2)),
          count: periodSales.length,
          byPaymentMethod: {
            cash: Number(cash.toFixed(2)),
            momo: Number(momo.toFixed(2)),
          },
          byType: {
            product: Number(productIncome.toFixed(2)),
            service: Number(serviceIncome.toFixed(2)),
          },
        },
        expenses: {
          total: Number(totalExpenses.toFixed(2)),
          count: periodExpenses.length,
          byCategory: Object.fromEntries(
            [...byCategory.entries()].map(([k, v]) => [k, Number(v.toFixed(2))])
          ),
        },
        net: Number((totalSales - totalExpenses).toFixed(2)),
        topProducts,
        topServices,
      };
    },
    { beforeHandle: requireOwner }
  )

  // Current stock levels for all products — US-12 stock report
  .get(
    "/stock",
    async ({ user }) => {
      const rows = await db
        .select()
        .from(products)
        .where(and(eq(products.businessId, user!.businessId), eq(products.archived, false)));

      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        quantity: p.quantity,
        minStockLevel: p.minStockLevel,
        low: p.quantity <= p.minStockLevel,
      }));
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
  