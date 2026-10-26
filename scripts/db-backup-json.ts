import fs from "fs/promises";
import path from "path";
import prisma from "../src/prisma.js";

const BACKUP_DIR = path.resolve("backup");

async function runBackup() {
  console.log("Starting JSON database backup...");
  
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });

    // 1. Export database tables
    const data: Record<string, any> = {};

    console.log("Backing up User table...");
    data.user = await prisma.user.findMany();

    console.log("Backing up Client table...");
    data.client = await prisma.client.findMany();

    console.log("Backing up Course table...");
    data.course = await prisma.course.findMany();

    console.log("Backing up Training table...");
    data.training = await prisma.training.findMany();

    console.log("Backing up Certificate table...");
    data.certificate = await prisma.certificate.findMany();

    console.log("Backing up InvoiceType table...");
    data.invoiceType = await prisma.invoiceType.findMany();

    console.log("Backing up ExpenseCategory table...");
    data.expenseCategory = await prisma.expenseCategory.findMany();

    console.log("Backing up Invoice table...");
    data.invoice = await prisma.invoice.findMany();

    console.log("Backing up InvoiceLineItem table...");
    data.invoiceLineItem = await prisma.invoiceLineItem.findMany();

    console.log("Backing up Payment table...");
    data.payment = await prisma.payment.findMany();

    console.log("Backing up Expense table...");
    data.expense = await prisma.expense.findMany();

    console.log("Backing up SalaryProfile table...");
    data.salaryProfile = await prisma.salaryProfile.findMany();

    console.log("Backing up PayrollRecord table...");
    data.payrollRecord = await prisma.payrollRecord.findMany();

    console.log("Backing up AwardingBody table...");
    data.awardingBody = await prisma.awardingBody.findMany();

    console.log("Backing up PermissionConfig table...");
    data.permissionConfig = await prisma.permissionConfig.findMany();

    console.log("Backing up Sequence table...");
    data.sequence = await prisma.sequence.findMany();

    console.log("Backing up Receipt table...");
    data.receipt = await prisma.receipt.findMany();

    console.log("Backing up ReceiptAllocation table...");
    data.receiptAllocation = await prisma.receiptAllocation.findMany();

    console.log("Backing up ReceiptActivity table...");
    data.receiptActivity = await prisma.receiptActivity.findMany();

    console.log("Backing up AuditLog table...");
    data.auditLog = await prisma.auditLog.findMany();

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dataFilename = `database_backup_${timestamp}.json`;
    await fs.writeFile(
      path.join(BACKUP_DIR, dataFilename),
      JSON.stringify(data, null, 2),
      "utf-8"
    );
    console.log(`Table data backup successfully written to backup/${dataFilename}`);

    // Also write a latest backup reference file for restore ease
    await fs.writeFile(
      path.join(BACKUP_DIR, "latest_data_backup.json"),
      JSON.stringify(data, null, 2),
      "utf-8"
    );

    // 2. Save snapshot of prisma schema
    console.log("Saving Prisma schema snapshot...");
    const schemaPath = path.resolve("prisma/schema.prisma");
    const schemaContent = await fs.readFile(schemaPath, "utf-8");
    await fs.writeFile(
      path.join(BACKUP_DIR, `schema_before_phase3_${timestamp}.prisma`),
      schemaContent,
      "utf-8"
    );
    await fs.writeFile(
      path.join(BACKUP_DIR, `schema_before_phase3.prisma`),
      schemaContent,
      "utf-8"
    );
    console.log("Prisma schema snapshot saved successfully.");

    // 3. Record enum values
    console.log("Recording current enum values...");
    const enums = {
      Role: ["super_admin", "admin", "operation_admin", "trainer"],
      ClientStatus: ["active", "archived"],
      TrainingType: ["classroom", "online", "site"],
      TrainingStatus: ["upcoming", "pending", "completed"],
      CertificateType: ["Specific", "General", "Duration"],
      InvoiceStatus: ["draft", "sent", "partially_paid", "paid", "overdue", "cancelled"],
      CertificateStatus: ["pending", "processing", "issued", "cancelled"],
      ReceiptPaymentMethod: ["CASH", "CHEQUE", "BANK_TRANSFER", "ONLINE"],
      ReceiptStatus: ["DRAFT", "ISSUED", "VOIDED"],
      PaymentStatus: ["ACTIVE", "VOIDED"],
      PayrollStatus: ["draft", "approved", "paid"]
    };
    await fs.writeFile(
      path.join(BACKUP_DIR, `enum_snapshot_${timestamp}.json`),
      JSON.stringify(enums, null, 2),
      "utf-8"
    );
    await fs.writeFile(
      path.join(BACKUP_DIR, `enum_snapshot.json`),
      JSON.stringify(enums, null, 2),
      "utf-8"
    );
    console.log("Enum snapshot saved successfully.");
    console.log("Backup process completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Backup process failed:", error);
    process.exit(1);
  }
}

runBackup();
