require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");

// --- استيراد المجدول التلقائي ---
const startSmsScheduler = require("./corn/smsScheduler");

// الميدلوير
const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
} = require("./middleware/auth");

// الراوتات
const authRouter = require("./routes/auth");
const centersRouter = require("./routes/centers");
const usersRouter = require("./routes/users");
const subjectsRouter = require("./routes/subjects");
const groupsRouter = require("./routes/groups");
const studentsRouter = require("./routes/students");
const subscriptionsRouter = require("./routes/subscriptions");
const smsWalletRouter = require("./routes/sms-wallet");
const activityLogRouter = require("./routes/activity-log");
const paymentsRouter = require("./routes/payments");
const dashboardRouter = require("./routes/dashboard");

const app = express();
const prisma = new PrismaClient();

// ==== CORS ====
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.use(express.json());

// ==== الراوتات العامة ====
app.use("/api/auth", authRouter);
app.get("/health", (req, res) =>
  res.json({ status: "OK", message: "الباك إند شغال تمام" }),
);

// ==== راوت المدفوعات ====
app.use("/api/payments", paymentsRouter);

// ==== الراوتات المحمية بالكامل ====
app.use(
  "/api/centers",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  centersRouter,
);
app.use(
  "/api/users",
  authenticateToken,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  usersRouter,
);
app.use(
  "/api/subjects",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  subjectsRouter,
);
app.use(
  "/api/groups",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  groupsRouter,
);
app.use(
  "/api/students",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  studentsRouter,
);
app.use(
  "/api/subscriptions",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  subscriptionsRouter,
);
app.use(
  "/api/sms-wallet",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  smsWalletRouter,
);
app.use(
  "/api/activity-log",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  activityLogRouter,
);
app.use(
  "/api/dashboard",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  dashboardRouter,
);

// ==== تشغيل المجدول التلقائي (المنبه الأسطوري) ====
// سيبدأ العمل يومياً الساعة 7 صباحاً كما تم ضبطه في ملفه
startSmsScheduler();

// ==== Handling 404 & Errors ====
app.use((req, res) => res.status(404).json({ error: "الراوت غير موجود" }));
app.use((err, req, res, next) => {
  console.error("خطأ عام:", err.stack);
  res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
});

// ==== تشغيل السيرفر ====
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () =>
  console.log(`🚀 الباك إند شغال على http://localhost:${PORT}`),
);

// ==== SIGINT / Cleanup Handler ====
const gracefulShutdown = async () => {
  console.log("\n🛑 Shutting down gracefully...");
  try {
    await prisma.$disconnect();
    server.close(() => {
      console.log("✅ Server closed. Goodbye!");
      process.exit(0);
    });
    setTimeout(() => {
      console.error("⚠️ Force exit after 5s...");
      process.exit(1);
    }, 5000);
  } catch (err) {
    console.error("❌ Error during shutdown:", err);
    process.exit(1);
  }
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);