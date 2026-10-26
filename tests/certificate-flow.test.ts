import prisma from "../src/prisma.js";
import { StatusService } from "../src/services/status.service.js";
import { assert, assertThrows } from "./assert.js";

async function runTest() {
  console.log("🚀 STARTING CERTIFICATE FLOW BUSINESS RULE TESTS");

  await prisma.certificate.deleteMany({
    where: { participantName: "Jane Cert" }
  });
  await prisma.training.deleteMany({
    where: { client: { companyName: "Test Cert Client Ltd" } }
  });
  await prisma.client.deleteMany({
    where: { companyName: "Test Cert Client Ltd" }
  });
  await prisma.course.deleteMany({
    where: { name: "Test Safety Course Level 4" }
  });

  const client = await prisma.client.create({
    data: {
      companyName: "Test Cert Client Ltd",
      contactPerson: "John Cert",
      phone: "0503333333",
      email: "test.cert@example.com",
      trnNo: "100200300400004",
      poBox: "8888",
      location: "Dubai",
    },
  });

  const course = await prisma.course.create({
    data: {
      name: "Test Safety Course Level 4",
    },
  });

  const training = await prisma.training.create({
    data: {
      clientId: client.id,
      courseId: course.id,
      participantName: "Jane Cert",
      participantPhone: "0504444444",
      regDate: new Date(),
      issueDate: new Date(),
      time: "09:00 - 17:00",
      trainingType: "online",
      status: "completed",
    },
  });

  const cert = await prisma.certificate.create({
    data: {
      trainingId: training.id,
      participantName: training.participantName,
      courseId: course.id,
      clientId: client.id,
      certificateNumber: "MOCK-CERT-77777",
      certificateType: "Specific",
      issueDate: new Date(),
      expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      status: "created",
    },
  });

  try {
    // 1. created -> sent
    const c1 = await StatusService.changeCertificateStatus(cert.id, "sent", "TestRunner", "Dispatched to client admin");
    assert(c1.status === "sent", "Certificate successfully transitioned to sent");

    // 2. sent -> printed
    const c2 = await StatusService.changeCertificateStatus(cert.id, "printed", "TestRunner", "Physically printed hardcopy");
    assert(c2.status === "printed", "Certificate successfully transitioned to printed");
    assert(c2.printedDate !== null, "printedDate timestamp has been set on print");

    // 3. printed -> distributed
    const c3 = await StatusService.changeCertificateStatus(cert.id, "distributed", "TestRunner", "Handed over to participant");
    assert(c3.status === "distributed", "Certificate successfully transitioned to distributed");
    assert(c3.distributedDate !== null, "distributedDate timestamp has been set on distribution");
    assert(c3.distributedBy === "TestRunner", "distributedBy tracking details are stored");

    // 4. Blocked invalid transitions
    await assertThrows(
      () => StatusService.changeCertificateStatus(cert.id, "created", "TestRunner", "Try cheat state"),
      "Invalid certificate status transition",
      "Terminal logistics status distributed cannot be reversed"
    );

    console.log("✨ ALL CERTIFICATE FLOW TESTS PASSED SUCCESSFULLY");
  } finally {
    // Cleanup
    await prisma.certificate.deleteMany({ where: { trainingId: training.id } });
    await prisma.training.deleteMany({ where: { clientId: client.id } });
    await prisma.course.delete({ where: { id: course.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await prisma.$disconnect();
  }
}

runTest().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
