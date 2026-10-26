import prisma from "../src/prisma.js";

async function main() {
  console.log("=== STAT ACTIVITY ===");
  const activity = await prisma.$queryRawUnsafe(`
    SELECT pid, state, query, age(clock_timestamp(), query_start) as age
    FROM pg_stat_activity
    WHERE query NOT LIKE '%pg_stat_activity%' AND state IS NOT NULL;
  `);
  console.log(activity);

  console.log("=== LOCKS ===");
  const locks = await prisma.$queryRawUnsafe(`
    SELECT
      t.relname AS relation_name,
      l.mode AS lock_mode,
      l.granted,
      a.pid AS blocking_pid,
      a.query AS blocking_query
    FROM pg_locks l
    JOIN pg_class t ON l.relation = t.oid
    JOIN pg_stat_activity a ON l.pid = a.pid
    WHERE NOT l.granted;
  `);
  console.log(locks);
}

main().catch(console.error);
