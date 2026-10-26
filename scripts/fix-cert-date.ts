import prisma from "../src/prisma.js";

async function main() {
  const cert = await prisma.certificate.findFirst({
    where: { certificateNumber: "TCT-5779-AC" }
  });

  console.log("Current Certificate in DB:", cert);

  if (cert) {
    // Update issueDate to Aug 1, 2026 12:00:00 UTC
    const newIssueDate = new Date(Date.UTC(2026, 7, 1, 12, 0, 0));
    const newExpiryDate = new Date(Date.UTC(2027, 6, 31, 12, 0, 0));

    const updated = await prisma.certificate.update({
      where: { id: cert.id },
      data: {
        issueDate: newIssueDate,
        expiryDate: newExpiryDate
      }
    });

    console.log("Updated Certificate in DB:", updated);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
