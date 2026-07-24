import { describe, it, expect, beforeAll } from "bun:test";

const BASE = "http://localhost:3000";

// Unique email per run so tests never collide with existing data
const stamp = Date.now();
const ownerEmail = `owner-${stamp}@test.local`;
const staffEmail = `staff-${stamp}@test.local`;
const password = "password123";

let ownerToken = "";
let staffToken = "";
let productId = "";
let serviceId = "";

async function api(path: string, opts: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

beforeAll(async () => {
  // Register a fresh business + owner
  const reg = await api("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      businessName: "Test Salon",
      name: "Test Owner",
      email: ownerEmail,
      password,
    }),
  });
  ownerToken = reg.body.token;

  // Owner creates a staff account
  await api("/auth/staff", {
    method: "POST",
    body: JSON.stringify({ name: "Test Staff", email: staffEmail, password }),
  }, ownerToken);

  const staffLogin = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: staffEmail, password }),
  });
  staffToken = staffLogin.body.token;

  // A product with 10 in stock, and a service
  const prod = await api("/products", {
    method: "POST",
    body: JSON.stringify({ name: "Test Polish", sellingPrice: 25, quantity: 10, minStockLevel: 4 }),
  }, ownerToken);
  productId = prod.body.id;

  const svc = await api("/services", {
    method: "POST",
    body: JSON.stringify({ name: "Test Manicure", price: 50 }),
  }, ownerToken);
  serviceId = svc.body.id;
}, 30000);

describe("Authentication", () => {
  it("issues a token on valid login", async () => {
    const res = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerEmail, password }),
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user.role).toBe("owner");
  });

  it("rejects an invalid password", async () => {
    const res = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ownerEmail, password: "wrongpassword" }),
    });
    expect(res.status).toBe(401);
  });

  it("blocks a protected route without a token", async () => {
    const res = await api("/auth/me");
    expect(res.status).toBe(401);
  });
});

describe("Role-based access control", () => {
  it("forbids a staff account from creating another account", async () => {
    const res = await api("/auth/staff", {
      method: "POST",
      body: JSON.stringify({ name: "Nope", email: `x-${stamp}@test.local`, password }),
    }, staffToken);
    expect(res.status).toBe(403);
  });
});

describe("Sales and stock", () => {
  it("records a mixed product+service sale with the correct total", async () => {
    const res = await api("/sales", {
      method: "POST",
      body: JSON.stringify({
        paymentMethod: "cash",
        items: [
          { type: "product", id: productId, quantity: 2 },
          { type: "service", id: serviceId, quantity: 1 },
        ],
      }),
    }, ownerToken);
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(100); // (2 * 25) + (1 * 50)
  }, 15000);

  it("decrements product stock but not for services", async () => {
    const res = await api(`/products/${productId}`, {}, ownerToken);
    // Started at 10, sold 2 in the test above
    expect(res.body.quantity).toBe(8);
  }, 15000);

  it("refuses a sale that exceeds available stock", async () => {
    const res = await api("/sales", {
      method: "POST",
      body: JSON.stringify({
        paymentMethod: "cash",
        items: [{ type: "product", id: productId, quantity: 999 }],
      }),
    }, ownerToken);
    expect(res.status).toBe(400);
  }, 15000);
});

describe("Reporting", () => {
  it("daily summary total equals cash plus momo", async () => {
    const res = await api("/reports/daily", {}, ownerToken);
    expect(res.status).toBe(200);
    const { totalTakings, byPaymentMethod } = res.body;
    expect(byPaymentMethod.cash + byPaymentMethod.momo).toBe(totalTakings);
  }, 15000);
});
