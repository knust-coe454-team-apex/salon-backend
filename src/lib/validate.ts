// Small helpers shared across resource routes.

// Turns a numeric string from Postgres (e.g. "12.50") into a number for JSON responses.
export const toNum = (v: string | null) => (v === null ? null : Number(v));

// Money comes back from Drizzle's `numeric` columns as strings; format consistently.
export const money = (v: string | number) => Number(v).toFixed(2);