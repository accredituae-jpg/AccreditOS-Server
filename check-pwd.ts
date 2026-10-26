import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function check() {
  const user = await prisma.user.findUnique({ where: { email: 'marcus@safetypro.com' } });
  if (!user) {
    console.log("User not found");
    return;
  }
  console.log("Mobile:", user.mobile);
  console.log("Password Hash:", user.passwordHash);
  
  const p1 = "mar485";
  const p2 = "mar123";
  const p3 = "mar5698586485";
  
  const m1 = await bcrypt.compare(p1, user.passwordHash);
  const m2 = await bcrypt.compare(p2, user.passwordHash);
  const m3 = await bcrypt.compare(p3, user.passwordHash);
  
  console.log("Match mar485:", m1);
  console.log("Match mar123:", m2);
  console.log("Match mar5698586485:", m3);
}

check().catch(console.error).finally(() => prisma.$disconnect());
