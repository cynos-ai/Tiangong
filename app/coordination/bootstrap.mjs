import pg from "pg";

import { PostgresCoordinationStore } from "./postgres-store.mjs";

const { Pool } = pg;

/**
 * Deployment helper. The connection string is consumed in memory by the pg
 * client; callers must provide it from their secret manager or environment.
 * This module intentionally does not persist or print it.
 */
export function createPostgresCoordinationStore({ connectionString = process.env.TIANGONG_COORDINATION_DATABASE_URL, poolOptions = {}, ...storeOptions } = {}) {
  if (typeof connectionString !== "string" || connectionString.length === 0) throw new TypeError("TIANGONG_COORDINATION_DATABASE_URL is required");
  const pool = new Pool({ connectionString, ...poolOptions });
  const store = new PostgresCoordinationStore({ pool, ...storeOptions });
  return Object.freeze({ pool, store });
}

