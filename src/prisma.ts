import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;

let prisma: PrismaClient;

if (connectionString && !connectionString.includes("[YOUR_PROJECT_ID]")) {
  const pool = new pg.Pool({
    connectionString,
    max: 30,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 5000,
  });
  const adapter = new PrismaPg(pool);
  prisma = new PrismaClient({ adapter });
} else {
  // Fallback for initial builds when connection string is still a placeholder
  const pool = new pg.Pool({
    connectionString: "postgresql://postgres:postgres@localhost:5432/postgres",
    max: 30,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 5000,
  });
  const adapter = new PrismaPg(pool);
  prisma = new PrismaClient({ adapter });
}

export default prisma;
