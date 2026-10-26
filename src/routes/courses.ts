import { Router } from "express";
import prisma from "../prisma.js";
import { authenticateJWT, authorizeRoles } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { Prisma } from "@prisma/client";
import logger from "../logger.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";
import { CourseOptionsSelect } from "../utils/queryEngine/index.js";

const router = Router();

// GET /api/courses/options - Lightweight options projection for dropdowns
router.get("/options", authenticateJWT, requirePermission("trainings"), async (req, res): Promise<void> => {
  try {
    const courses = await prisma.course.findMany({
      where: { isDeleted: false },
      select: CourseOptionsSelect,
      orderBy: { name: "asc" },
    });
    const options = courses.map((c: any) => ({
      id: c.id,
      label: c.name,
      meta: { name: c.name }
    }));
    successResponse(res, "Course options fetched successfully", options);
  } catch (err: any) {
    logger.error(err, "Error fetching course options");
    errorResponse(res, "Failed to retrieve course options.", 500);
  }
});

// GET /api/courses
router.get("/", authenticateJWT, requirePermission("trainings"), async (req, res): Promise<void> => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const search = (req.query.search as string) || "";

    const where: Prisma.CourseWhereInput = {
      isDeleted: false,
      ...(search ? { name: { contains: search, mode: "insensitive" } } : {})
    };

    if (page !== undefined) {
      const skip = (page - 1) * limit;
      const [total, items] = await Promise.all([
        prisma.course.count({ where }),
        prisma.course.findMany({
          where,
          skip,
          take: limit,
          orderBy: { name: "asc" }
        })
      ]);

      successResponse(res, "Courses fetched successfully", {
        items,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      });
      return;
    }

    const courses = await prisma.course.findMany({
      where,
      orderBy: { name: "asc" }
    });
    successResponse(res, "Courses fetched successfully", courses);
  } catch (err: any) {
    logger.error(err, "Error fetching courses");
    errorResponse(res, "Failed to retrieve courses.", 500);
  }
});

// POST /api/courses
router.post("/", authenticateJWT, requirePermission(["trainings", "certificates", "settings"], { match: "any" }), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req, res): Promise<void> => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    errorResponse(res, "Course name is required.", 400);
    return;
  }

  try {
    const trimmedName = name.trim();
    const existing = await prisma.course.findFirst({
      where: {
        name: { equals: trimmedName, mode: "insensitive" },
        isDeleted: false
      }
    });
    if (existing) {
      errorResponse(res, `A course named '${existing.name}' already exists. Duplicate courses are not allowed.`, 400);
      return;
    }

    const course = await prisma.course.create({
      data: { name: trimmedName }
    });
    logger.info({ id: course.id, name: course.name }, "Course created successfully");
    successResponse(res, "Course created successfully", course, 201);
  } catch (err: any) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      errorResponse(res, "A course with this name already exists.", 400);
      return;
    }
    logger.error(err, "Error creating course");
    errorResponse(res, "Failed to create course.", 500);
  }
});

// PUT /api/courses/:id
router.put("/:id", authenticateJWT, requirePermission(["trainings", "certificates", "settings"], { match: "any" }), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const { name } = req.body;
  if (!name || !name.trim()) {
    errorResponse(res, "Course name is required.", 400);
    return;
  }

  try {
    const trimmedName = name.trim();
    const existing = await prisma.course.findFirst({
      where: {
        name: { equals: trimmedName, mode: "insensitive" },
        id: { not: id },
        isDeleted: false
      }
    });
    if (existing) {
      errorResponse(res, `Another course named '${existing.name}' already exists. Duplicate courses are not allowed.`, 400);
      return;
    }

    const course = await prisma.course.update({
      where: { id },
      data: { name: trimmedName }
    });
    logger.info({ id: course.id, name: course.name }, "Course updated successfully");
    successResponse(res, "Course updated successfully", course);
  } catch (err: any) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      errorResponse(res, "Another course with this name already exists.", 400);
      return;
    }
    logger.error(err, "Error updating course");
    errorResponse(res, "Failed to update course.", 500);
  }
});

// DELETE /api/courses/:id - Soft Delete course
router.delete("/:id", authenticateJWT, requirePermission(["trainings", "certificates", "settings"], { match: "any" }), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req: any, res): Promise<void> => {
  const id = req.params.id as string;

  try {
    const existing = await prisma.course.findFirst({ where: { id, isDeleted: false } });
    if (!existing) {
      errorResponse(res, "Course not found.", 404);
      return;
    }
    
    await prisma.course.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: req.user?.name || "System"
      }
    });

    logger.info({ id }, "Course soft deleted successfully");
    successResponse(res, "Course successfully deleted.", { id });
  } catch (err: any) {
    logger.error(err, "Error deleting course");
    errorResponse(res, "Failed to delete course.", 500);
  }
});

export default router;
