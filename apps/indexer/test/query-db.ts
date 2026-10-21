// In-process Postgres (PGlite) with the indexer's tables, built from ponder.schema.ts with the
// same snake_case casing Ponder uses, so the T-034 SQL runs against the real table layout.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@czar/indexer/schema";

const snake = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

function ddl(table: PgTable): string[] {
  const config = getTableConfig(table);
  const columns = config.columns.map(
    (column) =>
      `"${snake(column.name)}" ${column.getSQLType()}${column.notNull ? " NOT NULL" : ""}${
        column.primary ? " PRIMARY KEY" : ""
      }`,
  );
  const indexes = config.indexes.map((index) => {
    const { name, columns: on } = index.config;
    const names = on.map((column) => `"${snake((column as { name: string }).name)}"`).join(", ");
    return `CREATE INDEX "${name}" ON "${config.name}" (${names})`;
  });
  return [`CREATE TABLE "${config.name}" (${columns.join(", ")})`, ...indexes];
}

export async function createQueryDatabase() {
  const client = new PGlite();
  for (const value of Object.values(schema)) {
    for (const statement of ddl(value as PgTable)) await client.exec(statement);
  }
  const db = drizzle(client, { casing: "snake_case" });
  return { client, db };
}
