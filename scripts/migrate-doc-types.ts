import prisma from "../src/prisma.js";

async function main() {
  const setting = await (prisma as any).systemSetting.findUnique({
    where: { key: "company_documents" },
  });

  if (!setting || !Array.isArray(setting.valueJson)) {
    console.log("No company_documents found in systemSetting.");
    return;
  }

  const existingDocs = setting.valueJson;
  console.log(`Found ${existingDocs.length} documents. Updating all to 'training_material' and removing any expiryDate...`);

  const updatedDocs = existingDocs.map((doc: any) => {
    const { expiryDate, ...rest } = doc;
    return {
      ...rest,
      type: "training_material",
    };
  });

  await (prisma as any).systemSetting.update({
    where: { key: "company_documents" },
    data: {
      valueJson: updatedDocs,
    },
  });

  console.log(`Successfully migrated ${updatedDocs.length} documents to 'training_material'!`);
  console.log("Sample document after migration:", updatedDocs[0]);
}

main()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
