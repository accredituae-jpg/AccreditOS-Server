import { Response } from "express";
import logger from "../../logger.js";

export enum ErrorCode {
  VALIDATION_ERROR = "VALIDATION_ERROR",
  NOT_FOUND = "NOT_FOUND",
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
  CONFLICT = "CONFLICT",
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  BAD_REQUEST = "BAD_REQUEST",
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface PaginatedResponse<T> {
  success: boolean;
  message: string;
  data: T[];
  pagination: Pagination;
  meta?: {
    requestId?: string;
    timestamp: string;
    executionTimeMs?: number;
  };
}

export function sendPaginatedResponse<T>(
  res: Response,
  message: string,
  data: T[],
  total: number,
  page: number,
  limit: number,
  startTime?: number,
  extra?: Record<string, any>
): void {
  const pages = Math.ceil(total / limit) || 1;
  const hasNext = page < pages;
  const hasPrevious = page > 1;

  const executionTimeMs = startTime ? Date.now() - startTime : undefined;
  const isDevOrStaging = process.env.NODE_ENV !== "production";

  if (!isDevOrStaging && executionTimeMs !== undefined) {
    res.setHeader("Server-Timing", `db;dur=${executionTimeMs}`);
    logger.info({ executionTimeMs, path: res.req?.originalUrl }, "Query execution time");
  }

  const responsePayload: any = {
    success: true,
    message,
    data,
    pagination: {
      page,
      limit,
      total,
      pages,
      hasNext,
      hasPrevious,
    },
    meta: {
      timestamp: new Date().toISOString(),
      ...(isDevOrStaging && executionTimeMs !== undefined ? { executionTimeMs } : {}),
    },
    ...(extra ? extra : {}),
  };

  res.status(200).json(responsePayload);
}

export function successResponse<T>(res: Response, message: string, data?: T, statusCode = 200): void {
  res.status(statusCode).json({
    success: true,
    message,
    data: data ?? null,
  });
}

export function errorResponse(
  res: Response,
  message: string,
  statusCode = 500,
  code: ErrorCode = ErrorCode.INTERNAL_SERVER_ERROR,
  errors?: any
): void {
  res.status(statusCode).json({
    success: false,
    message,
    code,
    ...(errors ? { errors } : {}),
  });
}
