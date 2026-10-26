import { env } from "./config/env.js";
import express from "express";
import cors from "cors";

import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import logger from "./logger.js"; // reloaded schema
import { startDailyDatabaseBackup } from "./dbBackup.js";
import authRoutes from "./routes/auth.js";
import clientsRoutes from "./routes/clients.js";
import coursesRoutes from "./routes/courses.js";
import trainingsRoutes from "./routes/trainings.js";
import certificatesRoutes from "./routes/certificates.js";
import financeRoutes from "./routes/finance.js";
import settingsRoutes from "./routes/settings.js";
import receiptsRoutes from "./routes/receipts.js";
import vendorBillsRoutes from "./routes/vendorBills.js";
import dashboardRoutes from "./routes/dashboard.js";
import usersRoutes from "./routes/users.js";
import payrollRoutes from "./routes/payroll.js";
import auditRoutes from "./routes/audit.js";
import aiRoutes from "./routes/ai.js";

import compression from "compression";

const app = express();
const PORT = env.PORT;

// Enable HTTP response payload compression (Gzip / Brotli)
app.use(compression());

// Apply W3C Server-Timing & Request Duration telemetry middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  const originalWriteHead = res.writeHead;
  res.writeHead = function (...args: any[]) {
    const duration = Date.now() - startTime;
    if (!res.headersSent) {
      res.setHeader("Server-Timing", `total;dur=${duration}`);
    }
    if (duration > 200) {
      logger.warn(
        {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: duration,
        },
        "SLOW_API_REQUEST_DETECTED",
      );
    }
    return originalWriteHead.apply(res, args as any);
  };
  next();
});

// Apply Helmet security headers
app.use(helmet());

// Configure CORS — supports comma-separated origins for multi-environment
const rawOrigins = env.FRONTEND_URL || "http://localhost:8080";
const allowedOrigins = rawOrigins
  .split(",")
  .flatMap((o) => {
    const clean = o.trim().replace(/\/$/, "");
    if (!clean) return [];
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      return [clean, "https://" + clean, "http://" + clean];
    }
    return [clean];
  });

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server requests (no origin) and matched origins
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${origin}' not allowed`));
      }
    },
    credentials: true,
  }),
);

app.use(express.json());

app.set("trust proxy", 1);

// Configure Rate Limiters
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 300, // Limit each IP to 300 requests per 15 minutes
  message: { error: "Too many requests. Please try again after 15 minutes." },
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // Limit each user email / IP combination to 20 failed attempts per 15 minutes
  skipSuccessfulRequests: true, // Do not count successful logins towards rate limit
  validate: { keyGeneratorIpFallback: false, ip: false },
  keyGenerator: (req) => {
    const clientIp = req.ip || "127.0.0.1";
    const email = req.body?.email?.toString().toLowerCase().trim() || "";
    // Use combination of IP and login email so users on the same office network don't block each other
    return email ? `${clientIp}_${email}` : clientIp;
  },
  message: {
    error: "Too many login attempts. Please try again after 15 minutes.",
  },
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

// Apply Limiters (only in production)
if (env.NODE_ENV === "production") {
  app.use("/api/", generalLimiter);
  app.use("/api/auth/login", authLimiter);
} else {
  logger.info("Rate limiting disabled in development mode.");
}

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/clients", clientsRoutes);
app.use("/api/courses", coursesRoutes);
app.use("/api/trainings", trainingsRoutes);
app.use("/api/certificates", certificatesRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/finance/receipts", receiptsRoutes);
app.use("/api/finance", vendorBillsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/payroll", payrollRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/ai", aiRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date() });
});

// Start Server
const server = app.listen(PORT, () => {
  logger.info(`AccreditOS backend running on port ${PORT}`);
});

// Configure Node.js HTTP server timeouts to prevent socket hang-ups and ECONNRESET errors
server.keepAliveTimeout = 65000; // 65 seconds
server.headersTimeout = 66000;   // 66 seconds

startDailyDatabaseBackup();
