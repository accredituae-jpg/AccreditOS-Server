import { Response, NextFunction } from "express";
import prisma from "../prisma.js";
import logger from "../logger.js";
import { AuthenticatedRequest } from "./auth.js";
import {
  ConfigurableRole,
  DEFAULT_PERMISSIONS,
  PermissionMap,
  resolveRolePermissions,
} from "../config/defaultPermissions.js";

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  permissions: PermissionMap;
  expiresAt: number;
}

const permissionCache = new Map<ConfigurableRole, CacheEntry>();

export function invalidatePermissionCache(): void {
  permissionCache.clear();
}

async function loadRolePermissions(role: ConfigurableRole): Promise<PermissionMap> {
  const cached = permissionCache.get(role);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.permissions;
  }

  const row = await prisma.permissionConfig.findUnique({ where: { role } });
  const permissions = resolveRolePermissions(
    role,
    row?.configJson as PermissionMap | undefined
  );

  permissionCache.set(role, {
    permissions,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return permissions;
}

function hasPermission(
  permissions: PermissionMap,
  permissionKey: string | string[],
  match: "any" | "all"
): boolean {
  const keys = Array.isArray(permissionKey) ? permissionKey : [permissionKey];
  if (keys.length === 0) {
    return false;
  }
  if (match === "all") {
    return keys.every((key) => permissions[key] === true);
  }
  return keys.some((key) => permissions[key] === true);
}

type RequirePermissionOptions = {
  /** When multiple keys are provided: "any" (default) or "all" must pass. */
  match?: "any" | "all";
};

/**
 * Enforces PermissionConfig for the authenticated user's JWT role.
 * super_admin bypasses all permission checks.
 */
export function requirePermission(
  permissionKey: string | string[],
  options?: RequirePermissionOptions
) {
  const match = options?.match ?? "any";

  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Access denied. No token provided." });
      return;
    }

    if (req.user.role === "super_admin") {
      next();
      return;
    }

    const role = req.user.role as ConfigurableRole;
    if (!DEFAULT_PERMISSIONS[role]) {
      logger.warn(
        {
          userId: req.user.id,
          userRole: req.user.role,
          permissionKey,
          endpoint: `${req.method} ${req.originalUrl}`,
          timestamp: new Date().toISOString(),
        },
        "Permission denied: unknown role"
      );
      res.status(403).json({ error: "Forbidden. Insufficient permissions." });
      return;
    }

    try {
      const permissions = await loadRolePermissions(role);
      const allowed = hasPermission(permissions, permissionKey, match);

      if (!allowed) {
        logger.warn(
          {
            userId: req.user.id,
            userRole: req.user.role,
            permissionKey,
            endpoint: `${req.method} ${req.originalUrl}`,
            timestamp: new Date().toISOString(),
          },
          "Permission denied"
        );
        res.status(403).json({ error: "Forbidden. Insufficient permissions." });
        return;
      }

      next();
    } catch (err) {
      logger.error(err, "Permission lookup failed");
      res.status(500).json({ error: "Failed to verify permissions." });
    }
  };
}
