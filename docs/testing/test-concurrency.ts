import dotenv from "dotenv";
dotenv.config();
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import jwt from "jsonwebtoken";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("No DATABASE_URL found");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const JWT_SECRET = process.env.JWT_SECRET || "accreditOS-super-secret-key-change-in-production";

async function main() {
  try {
    console.log("Cleaning up any stale test data from previous runs...");
    const staleClients = await prisma.client.findMany({
      where: { companyName: { startsWith: "Test Temporary Client" } }
    });
    for (const sc of staleClients) {
      await prisma.certificate.deleteMany({ where: { clientId: sc.id } });
      await prisma.training.deleteMany({ where: { clientId: sc.id } });
      await prisma.client.delete({ where: { id: sc.id } });
    }

    await prisma.course.deleteMany({
      where: { name: { startsWith: "Test Temporary Course" } }
    });

    console.log("Setting up database variables for test...");
    const runId = Math.floor(Math.random() * 1000000);
    const clientName = `Test Temporary Client ${runId}`;
    const courseName = `Test Temporary Course ${runId}`;

    const client = await prisma.client.create({
      data: {
        companyName: clientName,
        contactPerson: "Test Contact",
        phone: "123456",
        mobile: "123456",
        email: "test@client.com",
        trnNo: "1234567890",
        poBox: "123",
        location: "Test Location",
        status: "active"
      }
    });

    const course = await prisma.course.create({
      data: {
        name: courseName
      }
    });

    let ab = await prisma.awardingBody.findFirst({
      where: { isSystemIssued: true }
    });

    if (!ab) {
      console.log("No system-issued awarding body found. Creating a temporary one...");
      ab = await prisma.awardingBody.create({
        data: {
          name: "Test System Body",
          isSystemIssued: true,
          certificateFee: 10.0,
          isActive: true
        }
      });
    }

    const token = jwt.sign(
      { id: "test-admin-id", email: "test-admin@safetypro.com", role: "super_admin", name: "Test Admin" },
      JWT_SECRET
    );

    console.log("Sending 20 simultaneous certificate generation requests...");
    const promises = Array.from({ length: 20 }, (_, i) => {
      return fetch("http://localhost:5000/api/certificates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          participantName: `Test Participant ${i}`,
          courseId: course.id,
          clientId: client.id,
          issueDate: "2026-07-08",
          expiryYears: "1",
          certificateType: "Specific",
          awardingBodyId: ab.id
        })
      }).then(res => {
        if (!res.ok) {
          return res.json().then(err => { throw err; });
        }
        return res.json();
      });
    });

    const results = await Promise.all(promises);
    const certNumbers = results.map(r => r.certificateNumber);
    console.log("Successfully created certificates! Generated numbers:");
    console.log(certNumbers);

    const uniqueNumbers = new Set(certNumbers);
    if (uniqueNumbers.size === certNumbers.length) {
      console.log("SUCCESS! All 20 certificate numbers are completely unique.");
    } else {
      console.error("FAILURE: Duplicate certificate numbers found!");
    }

    console.log("Cleaning up generated test certificates...");
    const certIds = results.map(r => r.id);
    await prisma.certificate.deleteMany({
      where: { id: { in: certIds } }
    });

    console.log("Cleaning up temporary client...");
    await prisma.client.delete({ where: { id: client.id } });

    console.log("Cleaning up temporary course...");
    await prisma.course.delete({ where: { id: course.id } });

    if (ab.name === "Test System Body") {
      console.log("Cleaning up temporary awarding body...");
      await prisma.awardingBody.delete({ where: { id: ab.id } });
    }
    console.log("Cleanup complete!");

  } catch (err) {
    console.error("Concurrency test failed:", err);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
