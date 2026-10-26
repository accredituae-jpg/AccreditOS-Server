import { Router } from "express";
import { authenticateJWT, authorizeRoles } from "../middleware/auth.js";
import { AiService } from "../services/ai.service.js";
import logger from "../logger.js";

const router = Router();

/**
 * POST /api/ai/chat
 * STRICT DEVELOPER / SUPER-ADMIN ONLY ACCESS
 * All other roles receive an immediate 403 Forbidden.
 */
router.post(
  "/chat",
  authenticateJWT,
  authorizeRoles(["super_admin"]),
  async (req, res): Promise<void> => {
    try {
      const { messages } = req.body;

      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: "Invalid request. 'messages' array is required." });
        return;
      }

      const result = await AiService.chat(messages);
      res.json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      logger.error({ err }, "Error in AI Chat Copilot endpoint");
      res.status(500).json({
        error: err.message || "Failed to process AI chat request.",
      });
    }
  }
);

export default router;
