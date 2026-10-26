import type { Response } from "express";
import crypto from "crypto";
import logger from "../logger.js";
import { errorResponse } from "./apiResponse.js";

export function generateErrorId(): string {
  return `ERR-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

export function handleHttpError(res: Response, err: unknown, userMessage: string, statusCode = 500) {
  const referenceId = generateErrorId();
  logger.error({ err, referenceId }, userMessage);
  return errorResponse(
    res,
    `${userMessage} Reference ID: ${referenceId}`,
    statusCode,
    [referenceId]
  );
}

export function genericErrorHandler(err: unknown, res: Response) {
  return handleHttpError(res, err, "An unexpected error occurred.", 500);
}
