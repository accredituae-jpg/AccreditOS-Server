import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  await prisma.permissionConfig.deleteMany({});
  console.log("Permission overrides cleared.");
}
run().finally(() => prisma.$disconnect());
