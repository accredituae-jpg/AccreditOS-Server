import prisma from "../src/prisma.js";

async function main() {
  console.log("=== USERS ===");
  const users = await prisma.user.findMany({
    where: { name: { startsWith: "AuditTest" } }
  });
  console.log(users.map(u => ({ id: u.id, name: u.name, email: u.email })));

  console.log("=== INVOICES ===");
  const invoices = await prisma.invoice.findMany({
    where: { description: { startsWith: "AuditTest" } }
  });
  console.log(invoices.map(i => ({ id: i.id, invoiceNumber: i.invoiceNumber, description: i.description })));

  console.log("=== AUDIT LOGS ===");
  const logs = await prisma.auditLog.findMany({
    where: { details: { startsWith: "Created invoice" } },
    take: 5
  });
  console.log(logs.map(l => ({ id: l.id, entity: l.entity, action: l.action, performedById: l.performedById })));
}

main().catch(console.error);
