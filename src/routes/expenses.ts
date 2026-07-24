import { Elysia, t } from "elysia";
import { and, eq, gte, lte, desc } from "drizzle-orm";
import { db } from "../db";
import { expenses } from "../db/schema";
import { authPlugin, requireOwner } from "../lib/auth";
import { toNum } from "../lib/validate";

const shape = (e: any) => ({ ...e, amount: toNum(e.amount) });

// Every expense route is owner-only (US-09 criterion)
export const expenseRoutes = new Elysia({ prefix: "/expenses" })
  .use(authPlugin)

  .get(
    "/",
    async ({ user, query }) => {
      const filters = [eq(expenses.businessId, user!.businessId)];
      if (query.from) filters.push(gte(expenses.spentAt, new Date(query.from)));
      if (query.to) filters.push(lte(expenses.spentAt, new Date(query.to)));

      const rows = await db
        .select()
        .from(expenses)
        .where(and(...filters))
        .orderBy(desc(expenses.spentAt));
      return rows.map(shape);
    },
    { beforeHandle: requireOwner }
  )

  .post(
    "/",
    async ({ body, user, set }) => {
      // Only set spentAt when the owner explicitly back-dates the expense.
      // Otherwise let the database default supply it, so sales and expenses
      // share one clock and always land in the same reporting period.
      const values: any = {
        businessId: user!.businessId,
        userId: user!.id,
        amount: String(body.amount),
        category: body.category,
        note: body.note ?? null,
      };
      if (body.spentAt) values.spentAt = new Date(body.spentAt);

      const [row] = await db.insert(expenses).values(values).returning();

      if (!row) {
        set.status = 500;
        return { error: "Failed to record expense." };
      }

      set.status = 201;
      return shape(row);
    },
    {
      beforeHandle: requireOwner,
      body: t.Object({
        amount: t.Number({ minimum: 0 }),
        category: t.String({ minLength: 1 }),
        note: t.Optional(t.String()),
        spentAt: t.Optional(t.String()),
      }),
    }
  )

  .patch(
    "/:id",
    async ({ params, body, user, set }) => {
      const [existing] = await db
        .select()
        .from(expenses)
        .where(and(eq(expenses.id, params.id), eq(expenses.businessId, user!.businessId)))
        .limit(1);
      if (!existing) {
        set.status = 404;
        return { error: "Expense not found." };
      }

      const [row] = await db
        .update(expenses)
        .set({
          amount: body.amount !== undefined ? String(body.amount) : existing.amount,
          category: body.category ?? existing.category,
          note: body.note ?? existing.note,
          spentAt: body.spentAt ? new Date(body.spentAt) : existing.spentAt,
        })
        .where(eq(expenses.id, params.id))
        .returning();

      if (!row) {
        set.status = 500;
        return { error: "Failed to update expense." };
      }
      return shape(row);
    },
    {
      beforeHandle: requireOwner,
      body: t.Object({
        amount: t.Optional(t.Number({ minimum: 0 })),
        category: t.Optional(t.String({ minLength: 1 })),
        note: t.Optional(t.String()),
        spentAt: t.Optional(t.String()),
      }),
    }
  )

  .delete(
    "/:id",
    async ({ params, user, set }) => {
      const [existing] = await db
        .select()
        .from(expenses)
        .where(and(eq(expenses.id, params.id), eq(expenses.businessId, user!.businessId)))
        .limit(1);
      if (!existing) {
        set.status = 404;
        return { error: "Expense not found." };
      }

      await db.delete(expenses).where(eq(expenses.id, params.id));
      return { deleted: true, id: params.id };
    },
    { beforeHandle: requireOwner }
  );
  