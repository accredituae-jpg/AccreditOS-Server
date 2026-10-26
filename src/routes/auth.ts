import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import prisma from "../prisma.js";
import { authenticateJWT, AuthenticatedRequest } from "../middleware/auth.js";
import logger from "../logger.js";
import { sendOtpEmail } from "../services/emailService.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "30d";

if (!JWT_SECRET) {
  throw new Error("FATAL CONFIGURATION ERROR: JWT_SECRET environment variable is not defined!");
}

const AUTH_JWT_SECRET: string = JWT_SECRET;
const AUTH_JWT_EXPIRES_IN: SignOptions["expiresIn"] = JWT_EXPIRES_IN as SignOptions["expiresIn"];

// Helper: Generate 6-digit numeric OTP
function generate6DigitOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST /api/auth/login
router.post("/login", async (req, res): Promise<void> => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  try {
    const user = await prisma.user.findFirst({
      where: { 
        email: { equals: email.trim(), mode: "insensitive" },
        isDeleted: false, 
        isActive: true 
      }
    });
    if (!user) {
      logger.warn({ email }, "Failed login attempt: User not found or inactive/deleted");
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      logger.warn({ email }, "Failed login attempt: Invalid password");
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }

    const payload = {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      mobile: user.mobile
    };

    const token = jwt.sign(payload, AUTH_JWT_SECRET, { expiresIn: AUTH_JWT_EXPIRES_IN });

    logger.info({ email: user.email, role: user.role }, "User logged in successfully");

    res.json({
      token,
      user: payload
    });
  } catch (err: any) {
    logger.error(err, "Login error");
    res.status(500).json({ error: "Server error occurred during login." });
  }
});

// GET /api/auth/me
router.get("/me", authenticateJWT, (req: AuthenticatedRequest, res): void => {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({ user: req.user });
});

// POST /api/auth/impersonate
// Developer / Super Admin quick login to another user's dashboard
router.post("/impersonate", authenticateJWT, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (req.user?.role !== "super_admin") {
    res.status(403).json({ error: "Access denied. Developer / Super Admin privileges required." });
    return;
  }

  const { targetUserId } = req.body;
  if (!targetUserId) {
    res.status(400).json({ error: "targetUserId is required." });
    return;
  }

  try {
    const targetUser = await prisma.user.findFirst({
      where: { id: targetUserId, isDeleted: false, isActive: true },
    });

    if (!targetUser) {
      res.status(404).json({ error: "Target user not found or inactive." });
      return;
    }

    const payload = {
      id: targetUser.id,
      email: targetUser.email,
      role: targetUser.role,
      name: targetUser.name,
      mobile: targetUser.mobile,
      impersonatedBy: req.user.id,
    };

    const token = jwt.sign(payload, AUTH_JWT_SECRET, { expiresIn: AUTH_JWT_EXPIRES_IN });

    logger.info(
      { adminId: req.user.id, targetUserId: targetUser.id, targetRole: targetUser.role },
      "Admin impersonated user successfully"
    );

    res.json({
      token,
      user: payload,
    });
  } catch (err: any) {
    logger.error(err, "Impersonation error");
    res.status(500).json({ error: "Server error occurred during impersonation." });
  }
});

// POST /api/auth/forgot-password -> Generates 6-Digit OTP
router.post("/forgot-password", async (req, res): Promise<void> => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: "Email address is required." });
    return;
  }

  try {
    const cleanEmail = email.trim().toLowerCase();
    const user = await prisma.user.findFirst({
      where: { email: { equals: cleanEmail, mode: "insensitive" }, isDeleted: false, isActive: true }
    });

    if (!user) {
      res.status(404).json({ error: "No active user account found with this email address." });
      return;
    }

    const tokenModel = (prisma as any).passwordResetToken || (prisma as any).PasswordResetToken;

    if (!tokenModel) {
      logger.error("Prisma PasswordResetToken model is not initialized.");
      res.status(500).json({ error: "Password reset system is initializing. Please try again." });
      return;
    }

    // Invalidate existing unused tokens for this email
    await tokenModel.updateMany({
      where: { email: cleanEmail, isUsed: false },
      data: { isUsed: true }
    });

    // Generate 6-digit OTP valid for 10 minutes
    const otp = generate6DigitOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await tokenModel.create({
      data: {
        email: cleanEmail,
        otp,
        expiresAt
      }
    });

    logger.info({ email: cleanEmail, otp }, "OTP Password reset code generated");

    // Dispatch real email via Nodemailer SMTP service if configured
    const emailSent = await sendOtpEmail(cleanEmail, otp);

    res.json({
      message: `Verification OTP sent to ${cleanEmail}`,
      emailSent,
      otpPreview: process.env.NODE_ENV !== "production" ? otp : undefined
    });
  } catch (err: any) {
    logger.error(err, "Forgot password error");
    res.status(500).json({ error: "Failed to generate password reset OTP." });
  }
});

// POST /api/auth/verify-otp -> Validates 6-Digit OTP Code
router.post("/verify-otp", async (req, res): Promise<void> => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    res.status(400).json({ error: "Email and 6-digit OTP code are required." });
    return;
  }

  try {
    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = otp.toString().trim();
    const tokenModel = (prisma as any).passwordResetToken || (prisma as any).PasswordResetToken;

    if (!tokenModel) {
      res.status(500).json({ error: "Password reset system is initializing. Please try again." });
      return;
    }

    const resetToken = await tokenModel.findFirst({
      where: {
        email: { equals: cleanEmail, mode: "insensitive" },
        otp: cleanOtp,
        isUsed: false,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: "desc" }
    });

    if (!resetToken) {
      res.status(400).json({ error: "Invalid or expired OTP code. Please request a new OTP." });
      return;
    }

    res.json({ success: true, message: "OTP verified successfully. You can now set your new password." });
  } catch (err: any) {
    logger.error(err, "Verify OTP error");
    res.status(500).json({ error: "Failed to verify OTP code." });
  }
});

// POST /api/auth/reset-password -> Sets New Password via OTP
router.post("/reset-password", async (req, res): Promise<void> => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) {
    res.status(400).json({ error: "Email, OTP code, and new password are required." });
    return;
  }

  if (newPassword.length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters long." });
    return;
  }

  try {
    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = otp.toString().trim();
    const tokenModel = (prisma as any).passwordResetToken || (prisma as any).PasswordResetToken;

    if (!tokenModel) {
      res.status(500).json({ error: "Password reset system is initializing. Please try again." });
      return;
    }

    const resetToken = await tokenModel.findFirst({
      where: {
        email: { equals: cleanEmail, mode: "insensitive" },
        otp: cleanOtp,
        isUsed: false,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: "desc" }
    });

    if (!resetToken) {
      res.status(400).json({ error: "Invalid or expired OTP code." });
      return;
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: cleanEmail, mode: "insensitive" }, isDeleted: false }
    });

    if (!user) {
      res.status(404).json({ error: "User account not found." });
      return;
    }

    // Hash new password and update user record
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash }
    });

    // Mark reset token as used
    await tokenModel.update({
      where: { id: resetToken.id },
      data: { isUsed: true }
    });

    logger.info({ email: cleanEmail }, "Password reset successfully via OTP");

    res.json({ success: true, message: "Password updated successfully. Please log in with your new password." });
  } catch (err: any) {
    logger.error(err, "Reset password error");
    res.status(500).json({ error: "Failed to reset password." });
  }
});

// POST /api/auth/change-password -> Authenticated password change from inside system
router.post("/change-password", authenticateJWT, async (req: AuthenticatedRequest, res): Promise<void> => {
  const { currentPassword, newPassword } = req.body;
  if (!req.user || !req.user.id) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "Current password and new password are required." });
    return;
  }

  if (newPassword.length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters long." });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user) {
      res.status(404).json({ error: "User account not found." });
      return;
    }

    const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isMatch) {
      res.status(400).json({ error: "Current password is incorrect." });
      return;
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash }
    });

    logger.info({ userId: user.id, email: user.email }, "User changed password in settings");

    res.json({ success: true, message: "Password changed successfully." });
  } catch (err: any) {
    logger.error(err, "Change password error");
    res.status(500).json({ error: "Failed to change password." });
  }
});

export default router;
