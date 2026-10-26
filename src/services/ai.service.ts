import "dotenv/config";
import { GoogleGenAI, Type } from "@google/genai";
import prisma from "../prisma.js";
import logger from "../logger.js";

function getAiClient(): GoogleGenAI {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the backend server.");
  }
  return new GoogleGenAI({ apiKey: geminiApiKey });
}

// System instructions for AccreditOS ERP Assistant
const SYSTEM_PROMPT = `
You are the AccreditOS Intelligent ERP Copilot, an AI executive assistant for AccreditOS — an enterprise ERP for training institutes and certification bodies in the United Arab Emirates (UAE).

Key Business Context:
- Currency: UAE Dirham (AED). Always format amounts with AED (e.g., "2,672.25 AED").
- VAT: Standard UAE VAT rate is 5%.

CRITICAL COMMUNICATION & FORMATTING RULES:
1. **CONVERSATIONAL & HUMAN (LIKE A SMART EXECUTIVE ASSISTANT IN CHAT)**:
   - Talk naturally, concisely, and directly like a messaging chat (WhatsApp / Slack / Teams).
   - If asked "who owes me more?" or "who has the highest due?", answer directly in the first line:
     "**Emirates Recruitment Services LLC** owes you the most right now, with **2,672.25 AED** pending across 6 invoices."
   - If asked for unpaid clients or dues, give a quick conversational summary followed by a simple, clean bullet list:
     "You have **5,482.00 AED** total pending across 7 clients:
     - **Emirates Recruitment Services LLC**: 2,672.25 AED (6 invoices)
     - **Seven Days Manpower Supply LLC**: 1,785.00 AED (4 invoices)
     - **Aqua Dynamic Electromechanical LLC**: 446.25 AED (1 invoice)
     - **Sky High HR Provision Services LLC**: 300.00 AED (1 invoice)
     - **Middle East Manpower Supply LLC**: 178.50 AED (1 invoice)
     - **Zeina Al Gharbia General Maintenance**: 100.00 AED (1 invoice)
     - **Telal Najed General Maintenance LLC**: 100.00 AED (1 invoice)"

2. **ABSOLUTELY NO COMPLEX MARKDOWN TABLES (| col | col |)**:
   - DO NOT generate markdown tables with pipes (|) and dashes (---). Tables are hard to read and cluttered in a mobile or drawer chat.
   - Use clean, punchy bullet lists or conversational sentences instead.

3. **SUPPLIERS & AWARDING BODIES (e.g., Tatweer, Highfield, ICRQ)**:
   - When asked "how much do I need to pay to Tatweer?" or about any supplier/awarding body, call get_vendor_payables with vendorName.
   - CRITICAL: Suppliers have TWO types of payables:
     a) **Unbilled Issued Certificates**: Training certificates issued by the institute under that awarding body that haven't been registered into a formal vendor bill yet! The institute still owes this money.
     b) **Registered Unpaid Vendor Bills**: Invoices/bills already recorded with pending balances.
   - Always clearly report the breakdown:
     "**Tatweer**: You owe **X AED** total (Y AED from Z unbilled issued certificates, and W AED from registered bills)."

4. **EMPLOYEE PAYROLL & SALARIES**:
   - When asked "is employee salary paid?" or about a specific employee (e.g. "is [Name]'s salary paid?"), call get_employee_payroll.
   - Report clearly if it's Paid, Approved, or Draft, the net amount, and the payment date.

5. **CANDIDATE & TRAINING SEARCH**:
   - When asked to search training, certificates, or courses for any person/candidate, call search_recent_trainings with candidateName.
   - List the courses, company/client, registration date, and whether the certificate has been issued.

6. **PAYMENT & FINANCIAL REPORTS**:
   - When asked "what is last month payment report?", call get_payment_report with period "last_month".
   - Summarize client collections, operating expenses, employee payroll paid, and net cashflow in clear, conversational bullet points.

7. **DIRECT & TO THE POINT**:
   - Don't give verbose preamble or corporate filler. Answer the user's specific question immediately.

8. **DATA ACCURACY**:
   - ALWAYS call the appropriate tool to fetch live database records before answering. NEVER invent or hallucinate financial numbers.
`;

// Function declarations for Gemini Tool Calling
const GEMINI_TOOLS: any[] = [
  {
    functionDeclarations: [
      {
        name: "get_client_dues",
        description: "Get consolidated client accounts, receivables, outstanding balances, overdue amounts past payment terms, collected amounts to date, settlement percentages, and contact info (phone, contact person, TRN).",
        parameters: {
          type: Type.OBJECT,
          properties: {
            clientName: {
              type: Type.STRING,
              description: "Optional filter by client name or company name.",
            },
            limit: {
              type: Type.NUMBER,
              description: "Maximum number of clients to return. Defaults to 15.",
            },
          },
        },
      },
      {
        name: "get_financial_kpis",
        description: "Get high-level financial summary including total invoiced, total collections, total outstanding AR, and petty cash balance.",
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
      {
        name: "get_expiring_certificates",
        description: "Get certificates that are expiring soon or already expired within a certain number of days.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            daysAhead: {
              type: Type.NUMBER,
              description: "Look ahead window in days (e.g., 30, 60, 90). Defaults to 30.",
            },
            limit: {
              type: Type.NUMBER,
              description: "Maximum number of certificates to return. Defaults to 10.",
            },
          },
        },
      },
      {
        name: "search_recent_trainings",
        description: "Search for training registrations, courses conducted, and candidate participation by candidate or participant name or course name.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            candidateName: {
              type: Type.STRING,
              description: "Candidate or participant full or partial name.",
            },
            courseName: {
              type: Type.STRING,
              description: "Optional course name filter (e.g., First Aid, Fire Safety, Rigging).",
            },
            limit: {
              type: Type.NUMBER,
              description: "Number of records to return. Defaults to 10.",
            },
          },
        },
      },
      {
        name: "get_vendor_payables",
        description: "Get vendor bills and awarding body payables (e.g., Tatweer, Highfield, OSHAcademy) and amounts owed by the institute to vendors/awarding bodies.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            vendorName: {
              type: Type.STRING,
              description: "Vendor or awarding body name (e.g., Tatweer, Highfield). Leave empty for all pending vendors.",
            },
            limit: {
              type: Type.NUMBER,
              description: "Maximum number of records to return. Defaults to 20.",
            },
          },
        },
      },
      {
        name: "get_employee_payroll",
        description: "Check employee salary status, payslips, and payroll records to see if a specific employee's salary is paid, approved, generated, or pending.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            employeeName: {
              type: Type.STRING,
              description: "Optional employee name to check.",
            },
            month: {
              type: Type.NUMBER,
              description: "Optional month number (1 to 12).",
            },
            year: {
              type: Type.NUMBER,
              description: "Optional 4-digit year (e.g., 2026).",
            },
          },
        },
      },
      {
        name: "get_payment_report",
        description: "Get monthly financial summary of collections received from clients, operating expenses, employee payroll paid, and vendor bills paid.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            period: {
              type: Type.STRING,
              description: "Period to report: 'last_month' or 'this_month'. Defaults to 'last_month'.",
            },
            month: {
              type: Type.NUMBER,
              description: "Optional specific month number (1 to 12).",
            },
            year: {
              type: Type.NUMBER,
              description: "Optional specific 4-digit year.",
            },
          },
        },
      },
      {
        name: "get_unreimbursed_employee_expenses",
        description: "Get operating expenses paid by employees out of pocket that have NOT been reimbursed yet (status = not_returned).",
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
    ],
  },
];

// Tool execution router against Prisma
async function executeTool(name: string, args: Record<string, any>) {
  try {
    switch (name) {
      case "get_client_dues": {
        const clientName = args.clientName ? String(args.clientName).trim() : "";
        const limit = args.limit || 15;

        const whereClient: any = {
          invoices: {
            some: {
              status: { not: "cancelled" },
            },
          },
        };

        if (clientName) {
          whereClient.companyName = { contains: clientName, mode: "insensitive" };
        }

        const clientsWithInvoices = await prisma.client.findMany({
          where: whereClient,
          include: {
            invoices: {
              where: { status: { not: "cancelled" } },
              select: {
                invoiceNumber: true,
                totalAmount: true,
                paidAmount: true,
                balance: true,
                dueDate: true,
                status: true,
              },
              orderBy: { date: "desc" },
            },
          },
          orderBy: { companyName: "asc" },
        });

        const now = new Date();

        const clients = clientsWithInvoices.map((client) => {
          const totalInvoiced = client.invoices.reduce((sum, inv) => sum + Number(inv.totalAmount || 0), 0);
          const totalPaid = client.invoices.reduce((sum, inv) => sum + Number(inv.paidAmount || 0), 0);
          const totalOutstanding = client.invoices.reduce((sum, inv) => sum + Number(inv.balance || 0), 0);
          const totalInvoicesCount = client.invoices.length;

          const unpaidInvoices = client.invoices.filter((inv) => Number(inv.balance || 0) > 0.009);
          const overdueInvoices = unpaidInvoices.filter((inv) => new Date(inv.dueDate) < now);
          const overdueAmount = overdueInvoices.reduce((sum, inv) => sum + Number(inv.balance || 0), 0);

          const settlementRate = totalInvoiced > 0 ? Math.round((totalPaid / totalInvoiced) * 100) : 0;

          return {
            clientId: client.id,
            clientName: client.companyName,
            contactPerson: client.contactPerson,
            phone: client.phone,
            trnNo: client.trnNo,
            totalOutstandingAED: Math.round(totalOutstanding * 100) / 100,
            overduePastTermsAED: Math.round(overdueAmount * 100) / 100,
            collectedToDateAED: Math.round(totalPaid * 100) / 100,
            totalInvoicedAED: Math.round(totalInvoiced * 100) / 100,
            settlementRatePercent: `${settlementRate}%`,
            unpaidInvoicesCount: unpaidInvoices.length,
            totalInvoicesCount,
            status: totalOutstanding > 0.009 ? (totalPaid > 0.009 ? "Partial" : "Unpaid") : "Fully Paid",
          };
        });

        // Sort clients with pending dues first (highest outstanding first)
        const sorted = clients
          .sort((a, b) => b.totalOutstandingAED - a.totalOutstandingAED)
          .slice(0, limit);

        const totalOutstandingAll = clients.reduce((sum, c) => sum + c.totalOutstandingAED, 0);

        return {
          totalClientsCount: clients.length,
          totalClientsWithPendingDues: clients.filter((c) => c.totalOutstandingAED > 0).length,
          totalOutstandingAED: Math.round(totalOutstandingAll * 100) / 100,
          clients: sorted,
        };
      }

      case "get_financial_kpis": {
        const [invoices, receipts, expenses, pettyCashTopUps] = await Promise.all([
          prisma.invoice.findMany({
            where: { status: { notIn: ["cancelled"] } },
            select: { totalAmount: true, paidAmount: true, balance: true, status: true },
          }),
          prisma.receipt.findMany({
            where: { status: "paid" },
            select: { amount: true },
          }),
          prisma.expense.findMany({
            where: { isDeleted: false },
            select: { amount: true, paymentMethod: true, status: true },
          }),
          prisma.pettyCashTopUp.findMany({
            where: { isDeleted: false },
            select: { amount: true },
          }),
        ]);

        let totalInvoiced = 0;
        let totalReceivables = 0;
        invoices.forEach((inv) => {
          totalInvoiced += Number(inv.totalAmount || 0);
          if (inv.status !== "paid") {
            totalReceivables += Number(inv.balance || 0);
          }
        });

        const totalCollections = receipts.reduce((sum, r) => sum + Number(r.amount || 0), 0);
        const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);

        // Petty Cash calculation
        const totalTopUps = pettyCashTopUps.reduce((sum, t) => sum + Number(t.amount || 0), 0);
        const pettyCashExpenses = expenses
          .filter((e) => e.paymentMethod === "petty_cash")
          .reduce((sum, e) => sum + Number(e.amount || 0), 0);
        const pettyCashBalance = totalTopUps - pettyCashExpenses;

        return {
          totalInvoicedAED: totalInvoiced,
          totalCollectionsAED: totalCollections,
          totalOutstandingReceivablesAED: totalReceivables,
          totalExpensesAED: totalExpenses,
          approximateNetProfitAED: totalCollections - totalExpenses,
          pettyCashBalanceAED: pettyCashBalance,
        };
      }

      case "get_expiring_certificates": {
        const days = args.daysAhead || 30;
        const limit = args.limit || 10;
        const now = new Date();
        const targetDate = new Date();
        targetDate.setDate(now.getDate() + days);

        const certs = await prisma.certificate.findMany({
          where: {
            expiryDate: {
              lte: targetDate,
            },
          },
          include: {
            course: { select: { name: true } },
            client: { select: { id: true, companyName: true } },
          },
          orderBy: { expiryDate: "asc" },
          take: limit,
        });

        return {
          totalExpiringCount: certs.length,
          certificates: certs.map((c) => ({
            certificateNumber: c.certificateNumber || "Pending",
            candidateName: c.participantName,
            company: c.client?.companyName || c.customCompany || "Individual",
            course: c.course?.name || "N/A",
            expiryDate: c.expiryDate ? c.expiryDate.toISOString().split("T")[0] : "N/A",
            isAlreadyExpired: c.expiryDate ? c.expiryDate < now : false,
          })),
        };
      }

      case "search_recent_trainings": {
        const candidateName = args.candidateName ? String(args.candidateName).trim() : "";
        const courseName = args.courseName ? String(args.courseName).trim() : "";
        const limit = args.limit || 10;
        const where: any = {};
        if (candidateName) {
          where.participantName = { contains: candidateName, mode: "insensitive" };
        }
        if (courseName) {
          where.course = { name: { contains: courseName, mode: "insensitive" } };
        }

        const [trainings, certs] = await Promise.all([
          prisma.training.findMany({
            where,
            include: {
              course: { select: { name: true } },
              client: { select: { id: true, companyName: true } },
            },
            orderBy: { regDate: "desc" },
            take: limit,
          }),
          candidateName
            ? prisma.certificate.findMany({
                where: { participantName: { contains: candidateName, mode: "insensitive" } },
                include: {
                  course: { select: { name: true } },
                  client: { select: { id: true, companyName: true } },
                },
                orderBy: { issueDate: "desc" },
                take: limit,
              })
            : Promise.resolve([]),
        ]);

        return {
          totalTrainingsFound: trainings.length,
          trainings: trainings.map((t) => ({
            id: t.id,
            candidateName: t.participantName,
            courseName: t.course?.name || "N/A",
            clientName: t.client?.companyName || t.customCompany || "Individual",
            registrationDate: t.regDate ? t.regDate.toISOString().split("T")[0] : null,
            status: t.status,
            certificateIssued: t.certificateIssued,
          })),
          certificates: certs.map((c) => ({
            certificateNumber: c.certificateNumber || "Pending",
            candidateName: c.participantName,
            courseName: c.course?.name || "N/A",
            issueDate: c.issueDate ? c.issueDate.toISOString().split("T")[0] : null,
            expiryDate: c.expiryDate ? c.expiryDate.toISOString().split("T")[0] : null,
            status: c.status,
          })),
        };
      }

      case "get_vendor_payables": {
        const vendorName = args.vendorName ? String(args.vendorName).trim() : "";
        const limit = args.limit || 20;

        const whereBody: any = { isActive: true };
        if (vendorName) {
          whereBody.name = { contains: vendorName, mode: "insensitive" };
        }

        const bodies = await prisma.awardingBody.findMany({
          where: whereBody,
          include: {
            certificates: {
              where: {
                OR: [
                  { vendorBillLineItem: null },
                  { vendorBillLineItem: { vendorBill: { status: "CANCELLED" } } },
                ],
              },
              include: {
                course: { select: { name: true } },
              },
              orderBy: { issueDate: "desc" },
            },
            vendorBills: {
              where: { status: { not: "CANCELLED" } },
              orderBy: { createdAt: "desc" },
            },
          },
          orderBy: { name: "asc" },
        });

        let grandTotalPayable = 0;
        let grandTotalUnbilled = 0;
        let grandTotalBilled = 0;

        const vendors = bodies.map((body) => {
          const abFee = Number(body.certificateFee || 0);
          const isVat = body.isVatRegistered !== false;
          const rawVat = Number(body.vatPercent);
          const vatPct = isVat ? (rawVat > 0 ? rawVat : 5.0) : 0;

          // Unbilled certificates (issued under this body but not yet added to a formal vendor bill)
          const unbilledCerts = body.certificates.map((c) => {
            const fee = abFee > 0 ? abFee : (Number(c.awardingBodyFee) || 0);
            return {
              id: c.id,
              certificateNumber: c.certificateNumber || "Pending",
              participantName: c.participantName,
              courseName: c.course?.name || "Training",
              issueDate: c.issueDate ? c.issueDate.toISOString().split("T")[0] : null,
              fee,
            };
          });

          const unbilledSubtotal = unbilledCerts.reduce((sum, c) => sum + c.fee, 0);
          const unbilledVat = isVat ? unbilledSubtotal * (vatPct / 100) : 0;
          const unbilledAmount = Math.round((unbilledSubtotal + unbilledVat) * 100) / 100;

          // Registered vendor bills with unpaid balance
          const billedBalance = body.vendorBills
            .filter((b) => b.status !== "PAID")
            .reduce((sum, b) => sum + Number(b.balance || 0), 0);
          const billedTotal = body.vendorBills.reduce((sum, b) => sum + Number(b.totalAmount || 0), 0);
          const billedPaid = body.vendorBills.reduce((sum, b) => sum + Number(b.paidAmount || 0), 0);

          const totalPending = Math.round((unbilledAmount + billedBalance) * 100) / 100;

          grandTotalPayable += totalPending;
          grandTotalUnbilled += unbilledAmount;
          grandTotalBilled += billedBalance;

          return {
            vendorId: body.id,
            vendorName: body.name,
            totalPendingPayableAED: totalPending,
            unbilledCertificatesCount: unbilledCerts.length,
            unbilledCertificatesAmountAED: unbilledAmount,
            registeredBillsUnpaidBalanceAED: Math.round(billedBalance * 100) / 100,
            registeredBillsCount: body.vendorBills.length,
            unpaidBillsCount: body.vendorBills.filter((b) => Number(b.balance) > 0.01).length,
            certificateFeeAED: abFee,
            vatPercent: vatPct,
            hasUnbilledCertificates: unbilledCerts.length > 0,
            hasRegisteredBills: body.vendorBills.length > 0,
            unbilledCertificatesSample: unbilledCerts.slice(0, 5),
            contactPerson: body.contactPerson,
            phone: body.phone,
          };
        });

        const filteredVendors = vendors
          .filter(
            (v) =>
              v.totalPendingPayableAED > 0.001 ||
              (vendorName && v.vendorName.toLowerCase().includes(vendorName.toLowerCase())),
          )
          .sort((a, b) => b.totalPendingPayableAED - a.totalPendingPayableAED);

        return {
          totalPayableAcrossVendorsAED: Math.round(grandTotalPayable * 100) / 100,
          totalUnbilledCertificatesAmountAED: Math.round(grandTotalUnbilled * 100) / 100,
          totalRegisteredBillsBalanceAED: Math.round(grandTotalBilled * 100) / 100,
          vendorsCount: filteredVendors.length,
          vendors: filteredVendors.slice(0, limit),
        };
      }

      case "get_employee_payroll": {
        const employeeName = args.employeeName ? String(args.employeeName).trim() : "";
        const month = args.month ? Number(args.month) : undefined;
        const year = args.year ? Number(args.year) : undefined;

        const where: any = {};
        if (employeeName) {
          where.userName = { contains: employeeName, mode: "insensitive" };
        }
        if (month) {
          where.month = month;
        }
        if (year) {
          where.year = year;
        }

        const records = await prisma.payrollRecord.findMany({
          where,
          orderBy: [{ year: "desc" }, { month: "desc" }],
          take: 20,
        });

        return {
          count: records.length,
          records: records.map((r) => ({
            employeeName: r.userName,
            month: r.month,
            year: r.year,
            basicSalaryAED: Number(r.basicSalary),
            grossSalaryAED: Number(r.grossSalary),
            netSalaryAED: Number(r.netSalary),
            status: r.status,
            paymentDate: r.paymentDate ? r.paymentDate.toISOString().split("T")[0] : null,
            payrollNumber: r.payrollNumber,
            payslipNumber: r.payslipNumber,
          })),
        };
      }

      case "get_payment_report": {
        const now = new Date();
        let targetMonth = args.month ? Number(args.month) : undefined;
        let targetYear = args.year ? Number(args.year) : undefined;

        if (args.period === "last_month" || (!targetMonth && !targetYear)) {
          const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          targetMonth = lastMonthDate.getMonth() + 1;
          targetYear = lastMonthDate.getFullYear();
        } else if (args.period === "this_month") {
          targetMonth = now.getMonth() + 1;
          targetYear = now.getFullYear();
        }

        const m = targetMonth || now.getMonth() + 1;
        const y = targetYear || now.getFullYear();
        const startDate = new Date(y, m - 1, 1);
        const endDate = new Date(y, m, 0, 23, 59, 59, 999);

        const [receipts, expenses, payrolls, vendorPayments] = await Promise.all([
          prisma.receipt.findMany({
            where: {
              date: { gte: startDate, lte: endDate },
              status: { not: "voided" },
            },
            select: { amount: true, paymentMethod: true, receiptNumber: true },
          }),
          prisma.expense.findMany({
            where: {
              date: { gte: startDate, lte: endDate },
              isDeleted: false,
            },
            select: { amount: true, paymentMethod: true },
          }),
          prisma.payrollRecord.findMany({
            where: {
              month: m,
              year: y,
              status: "paid",
            },
            select: { netSalary: true },
          }),
          prisma.vendorPayment.findMany({
            where: {
              paymentDate: { gte: startDate, lte: endDate },
              status: "COMPLETED",
            },
            select: { amount: true },
          }),
        ]);

        const totalCollections = receipts.reduce((sum, r) => sum + Number(r.amount), 0);
        const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
        const totalPayroll = payrolls.reduce((sum, p) => sum + Number(p.netSalary), 0);
        const totalVendor = vendorPayments.reduce((sum, v) => sum + Number(v.amount), 0);

        return {
          month: m,
          year: y,
          monthName: startDate.toLocaleString("default", { month: "long" }),
          totalClientCollectionsAED: totalCollections,
          confirmedReceiptsCount: receipts.length,
          totalOperatingExpensesAED: totalExpenses,
          expensesCount: expenses.length,
          totalPayrollPaidAED: totalPayroll,
          employeesPaidCount: payrolls.length,
          totalVendorBillsPaidAED: totalVendor,
          netOperatingCashflowAED: totalCollections - (totalExpenses + totalPayroll + totalVendor),
        };
      }

      case "get_unreimbursed_employee_expenses": {
        const expenses = await prisma.expense.findMany({
          where: {
            isDeleted: false,
            paidByType: "employee",
            status: "not_returned",
          },
          include: { category: true },
          orderBy: { date: "desc" },
          take: 20,
        });

        const totalUnreimbursed = expenses.reduce((sum, e) => sum + Number(e.amount), 0);

        return {
          totalUnreimbursedAmountAED: totalUnreimbursed,
          count: expenses.length,
          expenses: expenses.map((e) => ({
            id: e.id,
            employeeName: e.paidByName || "Employee",
            category: e.category?.name || "General",
            amountAED: Number(e.amount),
            date: e.date.toISOString().split("T")[0],
            description: e.description,
          })),
        };
      }

      default:
        return { error: `Tool ${name} is not implemented.` };
    }
  } catch (err: any) {
    logger.error({ err, tool: name }, "Error executing AI tool");
    return { error: err.message || "Failed to execute database tool." };
  }
}

const MODELS_CASCADE = [
  "gemini-flash-lite-latest",
  "gemini-3.5-flash",
  "gemini-flash-latest",
  "gemini-3.8-flash",
];

async function runChatWithModel(
  ai: GoogleGenAI,
  modelName: string,
  history: any[],
  userPrompt: string
): Promise<string> {
  const chat = ai.chats.create({
    model: modelName,
    history,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: GEMINI_TOOLS,
      temperature: 0.2, // Low temperature for high accuracy in ERP calculations
    },
  });

  let response = await chat.sendMessage({ message: userPrompt });

  // Handle tool execution loop if the model requests tools
  let iterations = 0;
  while (response.functionCalls && response.functionCalls.length > 0 && iterations < 5) {
    iterations++;
    const toolResponses = [];

    for (const call of response.functionCalls) {
      const fnName = call.name || "";
      logger.info({ tool: fnName, args: call.args, model: modelName }, "AI Copilot executing ERP database tool");
      const toolResult = await executeTool(fnName, (call.args as Record<string, any>) || {});
      toolResponses.push({
        functionResponse: {
          name: fnName,
          response: toolResult,
        },
      });
    }

    response = await chat.sendMessage({
      message: toolResponses,
    });
  }

  const replyText =
    response.text ||
    (response.candidates?.[0]?.content?.parts
      ? (response.candidates[0].content.parts as any[])
          .map((p) => p.text || "")
          .filter(Boolean)
          .join("\n")
      : "") ||
    "I was unable to retrieve a response from the model.";

  return replyText;
}

export class AiService {
  /**
   * Process a chat conversation using Google Gemini with automatic failover cascade
   */
  static async chat(messages: { role: "system" | "user" | "assistant"; content: string }[]) {
    const ai = getAiClient();

    if (!messages || messages.length === 0) {
      return { reply: "Hello! How can I assist you with AccreditOS today?" };
    }

    // Filter and prepare previous history
    const priorMessages = messages.slice(0, -1);
    const history = priorMessages
      .filter((m) => m.content && m.content.trim())
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const lastMessage = messages[messages.length - 1];
    const userPrompt = lastMessage?.content || "Hello";

    let lastError: any = null;

    for (const model of MODELS_CASCADE) {
      try {
        const reply = await runChatWithModel(ai, model, history, userPrompt);
        return { reply };
      } catch (err: any) {
        lastError = err;
        logger.warn(
          { model, status: err.status, message: err.message },
          "Model in cascade failed or busy, failing over to next model"
        );
      }
    }

    throw lastError || new Error("All AI models in the failover cascade are currently unavailable.");
  }
}
