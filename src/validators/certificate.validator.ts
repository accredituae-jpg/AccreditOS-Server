import prisma from "../prisma.js";

export class CertificateValidator {
  static validateCertificateCreation(trainingStatus: string) {
    if (trainingStatus === "cancelled") {
      throw new Error("Certificates cannot be generated for cancelled trainings.");
    }
  }

  static async validateUniqueNumber(certificateNumber: string, ignoreId?: string) {
    if (!certificateNumber) return;

    const existing = await prisma.certificate.findUnique({
      where: { certificateNumber },
    });

    if (existing && existing.id !== ignoreId) {
      throw new Error(`Certificate number '${certificateNumber}' is already in use.`);
    }
  }
}
