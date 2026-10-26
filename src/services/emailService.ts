import nodemailer from "nodemailer";
import logger from "../logger.js";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || `"AccreditOS Security" <${SMTP_USER || "no-reply@accreditos.com"}>`;

let transporter: nodemailer.Transporter | null = null;

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

export async function sendOtpEmail(toEmail: string, otpCode: string): Promise<boolean> {
  const htmlContent = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px; background-color: #0f172a; border-radius: 16px; color: #f8fafc;">
      <div style="text-align: center; padding-bottom: 24px; border-bottom: 1px solid #1e293b;">
        <h1 style="color: #38bdf8; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">AccreditOS</h1>
        <p style="color: #94a3b8; font-size: 12px; margin-top: 4px; text-transform: uppercase; letter-spacing: 2px;">Enterprise ERP Security</p>
      </div>

      <div style="padding: 24px 0; text-align: center;">
        <h2 style="font-size: 20px; font-weight: 700; margin-bottom: 8px; color: #ffffff;">Password Reset Verification</h2>
        <p style="color: #cbd5e1; font-size: 14px; line-height: 1.5; margin-bottom: 24px;">
          You requested to reset your password for your AccreditOS ERP account. Use the 6-digit verification code below:
        </p>

        <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; display: inline-block; margin: 0 auto;">
          <span style="font-family: monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #38bdf8;">${otpCode}</span>
        </div>

        <p style="color: #64748b; font-size: 12px; margin-top: 24px;">
          This code is valid for <strong>10 minutes</strong>. Do not share this OTP with anyone.
        </p>
      </div>

      <div style="border-top: 1px solid #1e293b; pt: 16px; text-align: center; color: #475569; font-size: 11px;">
        <p style="margin: 0;">If you did not request this password reset, please ignore this email.</p>
        <p style="margin-top: 4px;">© 2026 AccreditOS ERP Systems Inc.</p>
      </div>
    </div>
  `;

  if (transporter) {
    try {
      await transporter.sendMail({
        from: SMTP_FROM,
        to: toEmail,
        subject: `${otpCode} is your AccreditOS Password Reset OTP`,
        text: `Your AccreditOS Password Reset OTP code is: ${otpCode}. Valid for 10 minutes.`,
        html: htmlContent,
      });
      logger.info({ toEmail }, "OTP email dispatched successfully via SMTP");
      return true;
    } catch (err: any) {
      logger.error(err, `Failed to dispatch SMTP email to ${toEmail}`);
    }
  } else {
    logger.warn({ toEmail, otpCode }, "SMTP is not configured in .env. OTP generated and logged in backend console.");
  }

  return false;
}
