import { assert } from "./assert.js";
import { relinkReissuedCertificateToVendorBill } from "../src/services/vendorBillCertificate.service.js";

async function runTest() {
  const certificate = {
    id: "reissued-certificate",
    certificateNumber: "CERT-REISSUED",
    participantName: "Updated Inspection Name",
    trainingId: "inspection-training",
    awardingBodyId: null,
    course: { name: "Excavation Inspection" },
    vendorBillLineItem: null,
  };
  const paidVendorLine = {
    id: "capital-zone-paid-line",
    trainingId: "inspection-training",
    participantName: "Old Inspection Name",
    courseName: "Excavation Inspection",
    vendorBill: { awardingBodyId: "capital-zone" },
  };
  let attachedLineId: string | null = null;

  const tx = {
    certificate: {
      findUnique: async () => certificate,
    },
    vendorBillLineItem: {
      findMany: async ({ where }: any) =>
        where.trainingId === "inspection-training" ? [paidVendorLine] : [],
      update: async ({ where, data }: any) => {
        attachedLineId = where.id;
        assert(data.certificateId === certificate.id, "Reissued certificate is linked to the paid vendor line");
        return { ...paidVendorLine, ...data };
      },
    },
  };

  const relinked = await relinkReissuedCertificateToVendorBill(tx as any, certificate.id);
  assert(relinked, "Certificate is relinked using its training ID even without an awarding-body ID");
  assert(attachedLineId === paidVendorLine.id, "The existing vendor-bill line is reused instead of creating a new liability");

  console.log("All vendor-bill certificate relinking tests passed.");
}

runTest().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
