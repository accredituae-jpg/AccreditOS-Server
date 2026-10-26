import prisma from "../src/prisma.js";

async function main() {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: "company_documents" },
  });
  console.log("Current company_documents:", JSON.stringify(setting?.valueJson, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
