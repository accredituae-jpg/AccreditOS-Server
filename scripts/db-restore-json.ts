import fs from "fs/promises";
import path from "path";
import prisma from "../src/prisma.js";

async function runRestore() {
  console.log("Starting JSON database restore and migration mapping...");

  try {
    const backupPath = path.resolve("backup/latest_data_backup.json");
    const rawData = await fs.readFile(backupPath, "utf-8");
    const backup = JSON.parse(rawData);

    // 1. Clear existing database in reverse dependency order to prevent FK violations
    console.log("Clearing database tables...");
    await prisma.statusHistory.deleteMany();
    await prisma.receiptActivity.deleteMany();
    await prisma.receiptAllocation.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.invoiceLineItem.deleteMany();
    await prisma.invoice.deleteMany();
    await prisma.receipt.deleteMany();
    await prisma.payrollRecord.deleteMany();
    await prisma.salaryProfile.deleteMany();
    await prisma.expense.deleteMany();
    await prisma.training.deleteMany();
    await prisma.certificate.deleteMany();
    await prisma.awardingBody.deleteMany();
    await prisma.course.deleteMany();
    await prisma.client.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();
    await prisma.sequence.deleteMany();
    await prisma.invoiceType.deleteMany();
    await prisma.expenseCategory.deleteMany();

    console.log("Database cleared successfully.");

    // 2. Restore User
    console.log("Restoring Users...");
    for (const u of backup.user) {
      await prisma.user.create({
        data: {
          id: u.id,
          email: u.email,
          passwordHash: u.passwordHash,
          name: u.name,
          mobile: u.mobile,
          role: u.role,
          isActive: u.isActive !== undefined ? u.isActive : true,
          isDeleted: u.isDeleted || false,
          deletedAt: u.deletedAt ? new Date(u.deletedAt) : null,
          deletedBy: u.deletedBy || null,
          createdAt: new Date(u.createdAt),
          updatedAt: new Date(u.updatedAt),
        },
      });
    }

    // 3. Restore Client
    console.log("Restoring Clients...");
    for (const c of backup.client) {
      await prisma.client.create({
        data: {
          id: c.id,
          companyName: c.companyName,
          contactPerson: c.contactPerson,
          phone: c.phone,
          fax: c.fax,
          email: c.email,
          trnNo: c.trnNo,
          poBox: c.poBox,
          location: c.location,
          status: c.status,
          notes: c.notes,
          isDeleted: c.isDeleted || false,
          deletedAt: c.deletedAt ? new Date(c.deletedAt) : null,
          deletedBy: c.deletedBy || null,
          createdAt: new Date(c.createdAt),
          updatedAt: new Date(c.updatedAt),
        },
      });
    }

    // 4. Restore Course
    console.log("Restoring Courses...");
    for (const co of backup.course) {
      await prisma.course.create({
        data: {
          id: co.id,
          name: co.name,
          isDeleted: co.isDeleted || false,
          deletedAt: co.deletedAt ? new Date(co.deletedAt) : null,
          deletedBy: co.deletedBy || null,
          createdAt: new Date(co.createdAt),
          updatedAt: new Date(co.updatedAt),
        },
      });
    }

    // 5. Restore AwardingBody
    console.log("Restoring Awarding Bodies...");
    for (const ab of backup.awardingBody) {
      await prisma.awardingBody.create({
        data: {
          id: ab.id,
          name: ab.name,
          clientId: ab.clientId,
          certificateFee: ab.certificateFee,
          isSystemIssued: ab.isSystemIssued,
          isActive: ab.isActive,
          createdAt: new Date(ab.createdAt),
          updatedAt: new Date(ab.updatedAt),
        },
      });
    }

    // 6. Restore Training
    console.log("Restoring Trainings...");
    for (const t of backup.training) {
      let mappedStatus = t.status;
      // map status just in case
      if (mappedStatus === "completed") mappedStatus = "completed";
      else if (mappedStatus === "pending") mappedStatus = "pending";
      else if (mappedStatus === "upcoming") mappedStatus = "upcoming";
      else mappedStatus = "upcoming";

      await prisma.training.create({
        data: {
          id: t.id,
          courseId: t.courseId,
          trainingType: t.trainingType,
          clientId: t.clientId,
          participantName: t.participantName,
          participantPhone: t.participantPhone,
          regDate: new Date(t.regDate),
          issueDate: new Date(t.issueDate),
          time: t.time,
          status: mappedStatus,
          certificateIssued: t.certificateIssued,
          awardingBodyId: t.awardingBodyId,
          createdAt: new Date(t.createdAt),
          updatedAt: new Date(t.updatedAt),
        },
      });
    }

    // 7. Restore Certificate (Linking to TrainingId)
    console.log("Restoring Certificates...");
    for (const cert of backup.certificate) {
      // Find matching training to set trainingId
      const training = await prisma.training.findFirst({
        where: {
          clientId: cert.clientId,
          courseId: cert.courseId,
          participantName: cert.participantName,
        },
      });

      let mappedStatus = "created";
      if (cert.status === "issued") mappedStatus = "printed";
      else if (cert.status === "processing") mappedStatus = "sent";
      else if (cert.status === "pending") mappedStatus = "created";
      else if (cert.status === "cancelled") mappedStatus = "created"; // fallback to created

      await prisma.certificate.create({
        data: {
          id: cert.id,
          participantName: cert.participantName,
          courseId: cert.courseId,
          certificateNumber: cert.certificateNumber,
          issueDate: new Date(cert.issueDate),
          expiryDate: new Date(cert.expiryDate),
          clientId: cert.clientId,
          certificateType: cert.certificateType,
          status: mappedStatus as any,
          awardingBodyFee: cert.awardingBodyFee,
          awardingBodyId: cert.awardingBodyId,
          trainingId: training ? training.id : null,
          createdAt: new Date(cert.createdAt),
          updatedAt: new Date(cert.updatedAt),
        },
      });
    }

    // 8. Restore InvoiceType & ExpenseCategory
    console.log("Restoring Invoice Types & Expense Categories...");
    for (const it of backup.invoiceType) {
      await prisma.invoiceType.create({ data: it });
    }
    for (const ec of backup.expenseCategory) {
      await prisma.expenseCategory.create({ data: ec });
    }

    // 9. Restore Invoice
    console.log("Restoring Invoices...");
    for (const inv of backup.invoice) {
      let mappedStatus = "draft";
      if (inv.status === "sent") mappedStatus = "issued";
      else if (inv.status === "overdue") mappedStatus = "issued";
      else if (["draft", "partially_paid", "paid", "cancelled"].includes(inv.status)) {
        mappedStatus = inv.status;
      }

      await prisma.invoice.create({
        data: {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          clientId: inv.clientId,
          typeId: inv.typeId,
          clientName: inv.clientName,
          clientTRN: inv.clientTRN,
          clientLocation: inv.clientLocation,
          clientPhone: inv.clientPhone,
          clientMobile: inv.clientMobile,
          clientEmail: inv.clientEmail,
          clientPoBox: inv.clientPoBox,
          clientReferenceContact: inv.clientReferenceContact,
          trnNo: inv.trnNo,
          poBox: inv.poBox,
          location: inv.location,
          phone: inv.phone,
          mobile: inv.mobile,
          referenceContact: inv.referenceContact,
          
          subtotal: inv.amount,
          discountAmount: inv.discount,
          vatAmount: inv.vatAmount,
          totalAmount: inv.total,
          paidAmount: inv.paid,
          balance: inv.balance,
          
          status: mappedStatus as any,
          date: new Date(inv.date),
          dueDate: new Date(inv.dueDate),
          description: inv.description,
          currency: inv.currency || "AED",
          notes: inv.notes,
          terms: inv.terms,
          createdById: inv.createdById,
          createdByName: inv.createdByName,
          updatedById: inv.updatedById,
          updatedByName: inv.updatedByName,
          createdAt: new Date(inv.createdAt),
          updatedAt: new Date(inv.updatedAt),
        },
      });
    }

    // 10. Restore InvoiceLineItem (Resolving certificateId)
    console.log("Restoring Invoice Line Items & Linking Certificates...");
    for (const li of backup.invoiceLineItem) {
      // Find if there's a certificate that belonged to this invoice (linked via cert.invoiceId in backup)
      // and match it by participant name inside description if possible
      let matchedCertId: string | null = null;
      
      const invoiceCerts = backup.certificate.filter((c: any) => c.invoiceId === li.invoiceId);
      if (invoiceCerts.length > 0) {
        // Try exact match on participantName in description
        const found = invoiceCerts.find((c: any) => 
          li.description.toLowerCase().includes(c.participantName.toLowerCase())
        );
        if (found) {
          matchedCertId = found.id;
        } else {
          // Fallback to first certificate of this invoice that hasn't been linked yet
          // Check what certificates are already linked
          const linkedInThisRun = await prisma.invoiceLineItem.findMany({
            where: { invoiceId: li.invoiceId },
            select: { certificateId: true }
          });
          const linkedIds = linkedInThisRun.map(l => l.certificateId).filter(Boolean);
          const unlinked = invoiceCerts.find((c: any) => !linkedIds.includes(c.id));
          if (unlinked) {
            matchedCertId = unlinked.id;
          }
        }
      }

      await prisma.invoiceLineItem.create({
        data: {
          id: li.id,
          invoiceId: li.invoiceId,
          description: li.description,
          quantity: li.quantity,
          unit: li.unit,
          unitPrice: li.unitPrice,
          discount: li.discount,
          vatPercent: li.vatPercent,
          lineSubtotal: li.lineSubtotal,
          lineVat: li.lineVat,
          lineTotal: li.lineTotal,
          sortOrder: li.sortOrder,
          certificateId: matchedCertId,
          createdAt: new Date(li.createdAt),
          updatedAt: new Date(li.updatedAt),
        },
      });
    }

    // 11. Restore Receipt & ReceiptAllocation
    console.log("Restoring Receipts...");
    for (const r of backup.receipt) {
      let mappedStatus = "issued";
      if (r.status === "ISSUED") mappedStatus = "paid"; // Issued payments in old schema were paid
      else if (r.status === "VOIDED") mappedStatus = "voided";
      else if (r.status === "DRAFT") mappedStatus = "issued";

      // Calculate allocated amount
      const allocations = backup.receiptInvoice.filter((ri: any) => ri.receiptId === r.id);
      const allocatedAmount = allocations.reduce((sum: number, ri: any) => sum + Number(ri.amount), 0);

      await prisma.receipt.create({
        data: {
          id: r.id,
          receiptNumber: r.receiptNumber,
          clientId: r.clientId,
          amount: r.amount,
          allocatedAmount: allocatedAmount,
          amountInWords: r.amountInWords,
          date: new Date(r.date),
          paymentMethod: r.paymentMethod,
          referenceNo: r.referenceNo,
          drawnOnBank: r.drawnOnBank,
          notes: r.notes,
          status: mappedStatus as any,
          currency: r.currency || "AED",
          exchangeRate: r.exchangeRate,
          clientSnapshot: r.clientSnapshot,
          pdfUrl: r.pdfUrl,
          createdById: r.createdById,
          createdByName: r.createdByName,
          voidedById: r.voidedById,
          voidedByName: r.voidedByName,
          voidedAt: r.voidedAt ? new Date(r.voidedAt) : null,
          voidReason: r.voidReason,
          createdAt: new Date(r.createdAt),
          updatedAt: new Date(r.updatedAt),
        },
      });

      // Restore allocations
      for (const alloc of allocations) {
        await prisma.receiptAllocation.create({
          data: {
            receiptId: alloc.receiptId,
            invoiceId: alloc.invoiceId,
            amount: alloc.amount,
            isVoided: mappedStatus === "voided",
            createdAt: new Date(r.createdAt),
            createdBy: r.createdByName,
            voidedAt: mappedStatus === "voided" ? new Date(r.voidedAt || Date.now()) : null,
            voidedBy: mappedStatus === "voided" ? r.voidedByName : null,
          },
        });
      }
    }

    // 12. Restore Payments, Expenses, Salaries
    console.log("Restoring Payments, Expenses, and Salaries...");
    for (const p of backup.payment) {
      await prisma.payment.create({
        data: {
          id: p.id,
          invoiceId: p.invoiceId,
          amount: p.amount,
          date: new Date(p.date),
          paymentMethod: p.paymentMethod,
          referenceNo: p.referenceNo,
          notes: p.notes,
          status: p.status,
          createdAt: new Date(p.createdAt),
          updatedAt: new Date(p.updatedAt),
        },
      });
    }

    for (const e of backup.expense) {
      await prisma.expense.create({
        data: {
          id: e.id,
          categoryId: e.categoryId,
          description: e.description,
          amount: e.amount,
          date: new Date(e.date),
          createdAt: new Date(e.createdAt),
          updatedAt: new Date(e.updatedAt),
        },
      });
    }

    for (const sp of backup.salaryProfile) {
      await prisma.salaryProfile.create({
        data: {
          id: sp.id,
          userId: sp.userId,
          userName: sp.userName,
          basicSalary: sp.basicSalary,
          allowances: sp.allowances,
          deductions: sp.deductions,
          paymentMethod: sp.paymentMethod,
          joiningDate: sp.joiningDate ? new Date(sp.joiningDate) : null,
          isActive: sp.isActive,
          createdAt: new Date(sp.createdAt),
          updatedAt: new Date(sp.updatedAt),
        },
      });
    }

    for (const pr of backup.payrollRecord) {
      await prisma.payrollRecord.create({
        data: {
          id: pr.id,
          userId: pr.userId,
          userName: pr.userName,
          month: pr.month,
          year: pr.year,
          basicSalary: pr.basicSalary,
          allowances: pr.allowances,
          deductions: pr.deductions,
          grossSalary: pr.grossSalary,
          netSalary: pr.netSalary,
          status: pr.status,
          periodStart: pr.periodStart ? new Date(pr.periodStart) : null,
          periodEnd: pr.periodEnd ? new Date(pr.periodEnd) : null,
          paymentReference: pr.paymentReference,
          paymentDate: pr.paymentDate ? new Date(pr.paymentDate) : null,
          notes: pr.notes,
          expenseId: pr.expenseId,
          createdById: pr.createdById,
          createdAt: new Date(pr.createdAt),
          updatedAt: new Date(pr.updatedAt),
        },
      });
    }

    // 13. AuditLogs, ReceiptActivity, Sequence
    console.log("Restoring System Config & Logs...");
    for (const seq of backup.sequence) {
      await prisma.sequence.create({ data: seq });
    }
    for (const ra of backup.receiptActivity) {
      await prisma.receiptActivity.create({
        data: {
          id: ra.id,
          receiptId: ra.receiptId,
          action: ra.action,
          performedById: ra.performedById,
          performedByName: ra.performedByName,
          createdAt: new Date(ra.createdAt),
          details: ra.details,
        },
      });
    }
    for (const log of backup.auditLog) {
      await prisma.auditLog.create({
        data: {
          id: log.id,
          entity: log.entity,
          action: log.action,
          entityId: log.entityId,
          performedById: log.performedById,
          performedByName: log.performedByName,
          details: log.details,
          data: log.data,
          createdAt: new Date(log.createdAt),
        },
      });
    }

    console.log("JSON Database restore and migration mapping completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Restore failed:", error);
    process.exit(1);
  }
}

runRestore();
