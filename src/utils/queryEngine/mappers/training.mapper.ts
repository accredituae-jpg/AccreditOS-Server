const formatDate = (date: Date | string | null | undefined): string => {
  if (!date) return "";
  if (typeof date === "string" && date.match(/^\d{2}-\d{2}-\d{4}$/)) {
    return date;
  }
  const d = new Date(date);
  if (isNaN(d.getTime())) return String(date || "");
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return formatter.format(d).replace(/\//g, "-");
};

export interface TrainingDTO {
  id: string;
  courseId: string;
  courseName: string;
  serviceType: "training" | "inspection";
  trainingType: string;
  clientId: string;
  clientName: string;
  client?: { id: string; companyName: string } | null;
  course?: { id: string; name: string } | null;
  participantName: string;
  participantPhone: string | null;
  drivingLicenseNo: string | null;
  drivingLicenseType: string | null;
  customCompany: string | null;
  regDate: string;
  rawRegDate?: Date | string | null;
  issueDate: string;
  rawIssueDate?: Date | string | null;
  time: string;
  status: string;
  certificateIssued: boolean;
  awardingBodyId: string | null;
  awardingBodyName: string;
  createdAt: Date;
  updatedAt: Date;
}

export function mapTrainingToDTO(raw: any): TrainingDTO {
  const serviceType =
    raw.serviceType === "inspection" ? "inspection" : "training";

  return {
    id: raw.id,
    courseId: raw.courseId,
    courseName: raw.course?.name || "",
    serviceType,
    course: raw.course ? { id: raw.course.id || raw.courseId, name: raw.course.name } : null,
    trainingType: raw.trainingType,
    clientId: raw.clientId,
    clientName: raw.client?.companyName || "",
    client: raw.client ? { id: raw.client.id || raw.clientId, companyName: raw.client.companyName } : null,
    participantName: raw.participantName,
    participantPhone: raw.participantPhone ?? null,
    drivingLicenseNo: raw.drivingLicenseNo ?? null,
    drivingLicenseType: raw.drivingLicenseType ?? null,
    customCompany: raw.customCompany ?? null,
    regDate: formatDate(raw.regDate),
    rawRegDate: raw.regDate,
    issueDate: formatDate(raw.issueDate),
    rawIssueDate: raw.issueDate,
    time: raw.time,
    status: raw.status,
    certificateIssued: !!raw.certificate || raw.certificateIssued,
    awardingBodyId: raw.awardingBodyId ?? null,
    awardingBodyName: raw.awardingBody?.name || "",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

