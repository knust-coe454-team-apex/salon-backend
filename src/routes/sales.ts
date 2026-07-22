import { Elysia, t } from "elysia";
import { and, eq, gte, desc, sql } from "drizzle-orm";
import { db } from "../db";
import { sales, saleItems, products, services, inventoryChanges } from "../db/schema";
import { authPlugin, requireAuth } from "../lib/auth";
import { toNum } from "../lib/validate";

export const saleRoutes = new Elysia({ prefix: "/sales" })
  .use(authPlugin)

  // Record a sale — products and services mixed, stock decremented for products only (US-05, US-07)
  .post(
    "/",
    async ({ body, user, set }) => {
      if (body.items.length === 0) {
        set.status = 400;
        return { error: "A sale must contain at least one item." };
      }

      // Everything below runs in a single transaction: either the whole
      // sale is written and stock adjusted, or nothing is.
      try {
        const result = await db.transaction(async (tx) => {
          const lines: {
            itemType: "product" | "service";
            productId: string | null;
            serviceId: string | null;
            nameSnapshot: string;
            unitPrice: string;
            quantity: number;
          }[] = [];
          let total = 0;

          for (const item of body.items) {
            const qty = item.quantity ?? 1;

            if (item.type === "product") {
              const [product] = await tx
                .select()
                .from(products)
                .where(and(eq(products.id, item.id), eq(products.businessId, user!.businessId)))
                .limit(1);

              if (!product) throw new Error(`Product not found: ${item.id}`);
              if (product.quantity < qty) {
                throw new Error(`Not enough stock for "${product.name}" (have ${product.quantity}, need ${qty}).`);
              }

              const unit = Number(product.sellingPrice);
              total += unit * qty;
              lines.push({
                itemType: "product",
                productId: product.id,
                serviceId: null,
                nameSnapshot: product.name,
                unitPrice: product.sellingPrice,
                quantity: qty,
              });
            } else {
              const [service] = await tx
                .select()
                .from(services)
                .where(and(eq(services.id, item.id), eq(services.businessId, user!.businessId)))
                .limit(1);

              if (!service) throw new Error(`Service not found: ${item.id}`);

              const unit = Number(service.price);
              total += unit * qty;
              lines.push({
                itemType: "service",
                productId: null,
                serviceId: service.id,
                nameSnapshot: service.name,
                unitPrice: service.price,
                quantity: qty,
              });
            }
          }

          // 1. The sale header
          const [sale] = await tx
            .insert(sales)
            .values({
              businessId: user!.businessId,
              userId: user!.id,
              customerId: body.customerId ?? null,
              total: total.toFixed(2),
              paymentMethod: body.paymentMethod,
            })
            .returning();

          if (!sale) throw new Error("Failed to create sale.");

          // 2. The line items
          await tx.insert(saleItems).values(
            lines.map((l) => ({ ...l, saleId: sale.id }))
          );

          // 3. Decrement stock — PRODUCTS ONLY — and log each movement
          for (const l of lines) {
            if (l.itemType === "product" && l.productId) {
              await tx
                .update(products)
                .set({ quantity: sql`${products.quantity} - ${l.quantity}` })
                .where(eq(products.id, l.productId));

              await tx.insert(inventoryChanges).values({
                productId: l.productId,
                userId: user!.id,
                delta: -l.quantity,
                reason: "sale",
                note: `Sale ${sale.id}`,
              });
            }
          }

          return { saleId: sale.id, total: total.toFixed(2) };
        });

        set.status = 201;
        return {
          id: result.saleId,
          total: toNum(result.total),
          paymentMethod: body.paymentMethod,
        };
      } catch (e: any) {
        set.status = 400;
        return { error: e.message ?? "Could not record the sale." };
      }
    },
    {
      beforeHandle: requireAuth,
      body: t.Object({
        paymentMethod: t.Union([t.Literal("cash"), t.Literal("momo")]),
        customerId: t.Optional(t.String()),
        items: t.Array(
          t.Object({
            type: t.Union([t.Literal("product"), t.Literal("service")]),
            id: t.String(),
            quantity: t.Optional(t.Integer({ minimum: 1 })),
          })
        ),
      }),
    }
  )

  // List recent sales with their line items
  .get(
    "/",
    async ({ user, query }) => {
      const rows = await db
        .select()
        .from(sales)
        .where(eq(sales.businessId, user!.businessId))
        .orderBy(desc(sales.createdAt))
        .limit(query.limit ? Number(query.limit) : 50);

      return Promise.all(
        rows.map(async (sale) => {
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
    },
    { beforeHandle: requireAuth }
  );
  