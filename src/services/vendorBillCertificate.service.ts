type DbClient = {
  vendorBillLineItem: any;
  certificate: any;
};

type CertSnapshotSource = {
  id: string;
  certificateNumber: string | null;
  participantName: string;
  trainingId?: string | null;
  course?: { name: string } | null;
};

export function vendorLineSnapshot(cert: CertSnapshotSource) {
  const courseName = cert.course?.name || "Training Course";
  const certificateNumber = cert.certificateNumber || `#${cert.id.substring(0, 8)}`;
  return {
    certificateId: cert.id,
    trainingId: cert.trainingId || null,
    certificateNumber,
    participantName: cert.participantName,
    courseName,
    description: `[${certificateNumber}] ${cert.participantName} - ${courseName}`,
  };
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function namesClose(a?: string | null, b?: string | null): boolean {
  const x = (a || "").trim().toLowerCase();
  const y = (b || "").trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const allowed = Math.max(x.length, y.length) <= 6 ? 1 : 2;
  return levenshtein(x, y) <= allowed;
}

async function attachLineToCertificate(tx: DbClient, lineId: string, cert: CertSnapshotSource) {
  await tx.vendorBillLineItem.update({
    where: { id: lineId },
    data: vendorLineSnapshot(cert),
  });
}

export async function stampVendorLineBeforeCertificateDelete(
  tx: DbClient,
  cert: { id: string; trainingId: string | null }
) {
  await tx.vendorBillLineItem.updateMany({
    where: { certificateId: cert.id },
    data: { trainingId: cert.trainingId },
  });
}

export async function relinkReissuedCertificateToVendorBill(tx: DbClient, certificateId: string) {
  const cert = await tx.certificate.findUnique({
    where: { id: certificateId },
    include: { course: true, vendorBillLineItem: true },
  });

  if (!cert || cert.vendorBillLineItem) return false;

  const orphanWhere = {
    certificateId: null as string | null,
    vendorBill: {
      status: { not: "CANCELLED" as const },
    },
  };

  if (cert.trainingId) {
    const byTraining = await tx.vendorBillLineItem.findMany({
      where: { ...orphanWhere, trainingId: cert.trainingId },
      include: { vendorBill: { select: { awardingBodyId: true } } },
    });
    const matchingVendorLines = cert.awardingBodyId
      ? byTraining.filter((line: any) => line.vendorBill.awardingBodyId === cert.awardingBodyId)
      : [];
    const matchingTrainingLine = cert.awardingBodyId
      ? matchingVendorLines.length === 1
        ? matchingVendorLines[0]
        : null
      : byTraining.length === 1
        ? byTraining[0]
        : null;

    if (matchingTrainingLine) {
      await attachLineToCertificate(tx, matchingTrainingLine.id, cert);
      return true;
    }
  }

  if (!cert.awardingBodyId) return false;

  const awardingBodyOrphanWhere = {
    ...orphanWhere,
    vendorBill: {
      ...orphanWhere.vendorBill,
      awardingBodyId: cert.awardingBodyId,
    },
  };

  const orphans = await tx.vendorBillLineItem.findMany({ where: awardingBodyOrphanWhere });
  if (orphans.length !== 1) return false;

  const orphan = orphans[0];
  const close =
    namesClose(orphan.participantName, cert.participantName) ||
    namesClose(orphan.courseName, cert.course?.name);
  if (!close) return false;

  await attachLineToCertificate(tx, orphan.id, cert);
  return true;
}

export async function healOrphanedVendorBillCertificates(client: DbClient) {
  const orphans = await client.vendorBillLineItem.findMany({
    where: {
      certificateId: null,
      vendorBill: { status: { not: "CANCELLED" } },
    },
    include: {
      vendorBill: { select: { awardingBodyId: true } },
    },
  });

  if (orphans.length === 0) return 0;

  const unbilled = await client.certificate.findMany({
    where: {
      awardingBodyId: { not: null },
      OR: [
        { vendorBillLineItem: null },
        { vendorBillLineItem: { vendorBill: { status: "CANCELLED" } } },
      ],
    },
    include: { course: true },
  });

  const usedOrphanIds = new Set<string>();
  const usedCertIds = new Set<string>();
  let linked = 0;

  const attach = async (orphanId: string, cert: (typeof unbilled)[number]) => {
    await attachLineToCertificate(client, orphanId, cert);
    usedOrphanIds.add(orphanId);
    usedCertIds.add(cert.id);
    linked += 1;
  };

  for (const cert of unbilled) {
    if (!cert.trainingId) continue;
    const orphan = orphans.find(
      (o) =>
        !usedOrphanIds.has(o.id) &&
        o.trainingId === cert.trainingId &&
        o.vendorBill.awardingBodyId === cert.awardingBodyId
    );
    if (orphan) {
      await attach(orphan.id, cert);
    }
  }

  const leftoverOrphans = orphans.filter((o) => !usedOrphanIds.has(o.id));
  const leftoverCerts = unbilled.filter((c) => !usedCertIds.has(c.id));
  const vendorIds = new Set(
    [
      ...leftoverOrphans.map((o) => o.vendorBill.awardingBodyId),
      ...leftoverCerts.map((c) => c.awardingBodyId).filter(Boolean),
    ] as string[]
  );

  for (const vendorId of vendorIds) {
    const vendorOrphans = leftoverOrphans.filter((o) => o.vendorBill.awardingBodyId === vendorId);
    const vendorCerts = leftoverCerts.filter((c) => c.awardingBodyId === vendorId);
    if (vendorOrphans.length !== 1 || vendorCerts.length !== 1) continue;

    const orphan = vendorOrphans[0];
    const cert = vendorCerts[0];
    const close =
      namesClose(orphan.participantName, cert.participantName) ||
      namesClose(orphan.courseName, cert.course?.name);
    if (!close) continue;
    await attach(orphan.id, cert);
  }

  return linked;
}
