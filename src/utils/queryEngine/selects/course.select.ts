import { Prisma } from "@prisma/client";

export const CourseOptionsSelect = {
  id: true,
  name: true,
} as const satisfies Prisma.CourseSelect;
