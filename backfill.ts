import prisma from './src/prisma.js';

async function backfill() {
  const records = await prisma.payrollRecord.findMany({ include: { user: true } });
  for (const r of records) {
    if (r.userName === 'Unknown' && r.user) {
      await prisma.payrollRecord.update({
        where: { id: r.id },
        data: { userName: r.user.name }
      });
    }
  }
  
  const profiles = await prisma.salaryProfile.findMany({ include: { user: true } });
  for (const p of profiles) {
    if (p.userName === 'Unknown' && p.user) {
      await prisma.salaryProfile.update({
        where: { id: p.id },
        data: { userName: p.user.name }
      });
    }
  }
  console.log("Backfill complete");
}

backfill().finally(() => prisma.$disconnect());
