import prisma from "../src/prisma.js";
import { StatusService } from "../src/services/status.service.js";
import { assert, assertThrows } from "./assert.js";

async function runTest() {
  console.log("🚀 STARTING TRAINING FLOW BUSINESS RULE TESTS");

  // 1. Setup mock data
  await prisma.training.deleteMany({
    where: { client: { companyName: "Test Training Client Ltd" } }
  });
  await prisma.client.deleteMany({
    where: { companyName: "Test Training Client Ltd" }
  });
  await prisma.course.deleteMany({
    where: { name: "Test Safety Course Level 3" }
  });

  const client = await prisma.client.create({
    data: {
      companyName: "Test Training Client Ltd",
      contactPerson: "John Trainer",
      phone: "0501111111",
      email: "test.trainer@example.com",
      trnNo: "100200300400003",
      poBox: "9999",
      location: "Abu Dhabi",
    },
  });

  const course = await prisma.course.create({
    data: {
      name: "Test Safety Course Level 3",
    },
  });

  const training = await prisma.training.create({
    data: {
      clientId: client.id,
      courseId: course.id,
      participantName: "Jane Doe",
      participantPhone: "0502222222",
      regDate: new Date(),
      issueDate: new Date(),
      time: "09:00 - 17:00",
      trainingType: "classroom",
      status: "upcoming",
    },
  });

  try {
    // 2. Validate valid transition: upcoming -> pending
    const t1 = await StatusService.changeTrainingStatus(training.id, "pending", "TestRunner", "Scheduled past date checker");
    assert(t1.status === "pending", "Upcoming training successfully transitioned to pending");

    // 3. Validate valid transition: pending -> completed
    const t2 = await StatusService.changeTrainingStatus(training.id, "completed", "TestRunner", "Manual completion post training");
    assert(t2.status === "completed", "Pending training successfully transitioned to completed");

    // 4. Validate blocked transition: completed -> upcoming (Completed is locked/terminal)
    await assertThrows(
      () => StatusService.changeTrainingStatus(training.id, "upcoming", "TestRunner", "Try override"),
      "Invalid training status transition",
      "Completed training status transitions must be blocked"
    );

    // 5. Create certificate and assert training is locked from manual edits
    const certificate = await prisma.certificate.create({
      data: {
        trainingId: training.id,
        participantName: training.participantName,
        courseId: course.id,
        clientId: client.id,
        certificateNumber: "MOCK-CERT-99999",
        certificateType: "Specific",
        issueDate: new Date(),
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        status: "created",
      },
    });

    await assertThrows(
      () => StatusService.changeTrainingStatus(training.id, "pending", "TestRunner", "Try override", undefined, false),
      "locked because a certificate has been generated",
      "Training status is locked once a certificate is generated"
    );

    // Clean up certificate
    await prisma.certificate.delete({ where: { id: certificate.id } });

    console.log("✨ ALL TRAINING FLOW TESTS PASSED SUCCESSFULLY");
  } finally {
    // Cleanup mock data
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
