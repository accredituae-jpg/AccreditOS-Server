import { Response } from "express";

export interface ApiResponseWrapper<T = any> {
  success: boolean;
  message: string;
  referenceId?: string;
  data?: T;
  code?: string;
  errors?: string[];
}

/**
 * Returns a standardized success API response wrapper.
 */
export function successResponse<T = any>(
  res: Response,
  message: string,
  data?: T,
  statusCode = 200
): Response {
  const responseBody: ApiResponseWrapper<T> = {
    success: true,
    message,
    data,
  };
  return res.status(statusCode).json(responseBody);
}

/**
 * Returns a standardized error API response wrapper.
 */
export function errorResponse(
  res: Response,
  message: string,
  statusCode = 500,
  errors?: string[],
  code?: string
): Response {
  let inferredCode = code;
  if (!inferredCode) {
    if (statusCode === 401) {
      inferredCode = "UNAUTHORIZED";
    } else if (statusCode === 403) {
      inferredCode = "FORBIDDEN";
    } else if (statusCode === 404) {
      inferredCode = "NOT_FOUND";
    } else {
      const cleaned = message
        .replace(/[^a-zA-Z0-9\s-]/g, "")
        .trim()
        .replace(/[\s-]+/g, "_")
        .toUpperCase();
      if (cleaned.length > 0 && cleaned.length <= 45) {
        inferredCode = cleaned;
      } else {
        inferredCode = "SERVER_ERROR";
      }
    }
  }

  const responseBody: ApiResponseWrapper = {
    success: false,
    message,
    errors,
    code: inferredCode,
  };
  return res.status(statusCode).json(responseBody);
}
