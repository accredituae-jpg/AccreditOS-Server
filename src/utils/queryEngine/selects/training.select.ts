import { Prisma } from "@prisma/client";

export const TrainingListSelect = {
  id: true,
  courseId: true,
  trainingType: true,
  serviceType: true,
  clientId: true,
  participantName: true,
  participantPhone: true,
  drivingLicenseNo: true,
  drivingLicenseType: true,
  customCompany: true,
  regDate: true,
  issueDate: true,
  time: true,
  status: true,
  certificateIssued: true,
  awardingBodyId: true,
  createdAt: true,
  updatedAt: true,
  client: {
    select: {
      id: true,
      companyName: true,
    },
  },
  course: {
    select: {
      id: true,
      name: true,
    },
  },
  awardingBody: {
    select: {
      id: true,
      name: true,
    },
  },
  certificate: {
    select: {
      id: true,
    },
  },
} as const satisfies Prisma.TrainingSelect;

export const TrainingOptionsSelect = {
  id: true,
  participantName: true,
  drivingLicenseNo: true,
  drivingLicenseType: true,
  customCompany: true,
  serviceType: true,
  status: true,
  certificateIssued: true,
  client: {
    select: {
      id: true,
      companyName: true,
    },
  },
  course: {
    select: {
      id: true,
      name: true,
    },
  },
} as const satisfies Prisma.TrainingSelect;
