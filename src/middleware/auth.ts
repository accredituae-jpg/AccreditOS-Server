import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import prisma from "../prisma.js";

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error(
    "FATAL CONFIGURATION ERROR: JWT_SECRET environment variable is not defined!",
  );
}

const AUTH_JWT_SECRET: string = JWT_SECRET;

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: "super_admin" | "admin" | "operation_admin" | "trainer";
    name: string;
  };
}

export async function authenticateJWT(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: "Access denied. No token provided." });
    return;
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    res.status(401).json({ error: "Access denied. Invalid token format." });
    return;
  }

  try {
    const decoded = jwt.verify(token, AUTH_JWT_SECRET) as any;
    const user = await prisma.user.findFirst({
      where: { id: decoded.id, isDeleted: false, isActive: true },
    });
    if (!user) {
      res
        .status(403)
        .json({ error: "Access denied. Account is inactive or deleted." });
      return;
    }
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired token." });
    return;
  }
}

export function authorizeRoles(roles: string[]) {
  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: "Forbidden. Insufficient permissions." });
      return;
    }
    next();
  };
}
