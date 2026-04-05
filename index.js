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

// ==== CORS (مناسب لريندر وللإنتاج) ====
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173", // تأكد من وضع رابط ريندر في البيئة
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.use(express.json());

// ==== الراوتات العامة ====
app.use("/api/auth", authRouter);
app.get("/health", (req, res) =>
  res.json({ status: "OK", message: "الباك إند شغال تمام وزي الفل 🚀" }),
);

// ==== راوت المدفوعات ====
app.use("/api/payments", paymentsRouter);

// ==== الراوتات المحمية بالكامل ====
// تم ترتيب الميدلوير بشكل منطقي (التأكد من التوكن أولاً، ثم الاشتراك، ثم الصلاحيات)
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
try {
    startSmsScheduler();
    console.log("⏰ SMS Scheduler started successfully.");
} catch (err) {
    console.error("❌ Failed to start SMS Scheduler:", err.message);
}

// ==== Handling 404 & Errors ====
app.use((req, res) => res.status(404).json({ error: "الراوت المطلوب غير موجود" }));

app.use((err, req, res, next) => {
  console.error("❌ خطأ غير متوقع في السيرفر:", err.stack);
  res.status(500).json({ 
    error: "حصل خطأ داخلي في السيرفر",
    details: process.env.NODE_ENV === "development" ? err.message : undefined 
  });
});

// ==== تشغيل السيرفر ====
const PORT = process.env.PORT || 3000;
// هنا قمنا بتخزين السيرفر في متغير لاستخدامه في الإغلاق النظيف
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ******************************************
  🚀 السيرفر اشتغل بنجاح يا بطل!
  📡 المنفذ: ${PORT}
  🔗 الرابط: http://localhost:${PORT}
  ******************************************
  `);
});

// ==== SIGINT / Cleanup Handler (الإغلاق النظيف) ====
const gracefulShutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
  
  // ضبط مهلة زمنية للإغلاق الإجباري لو السيرفر علّق
  const forceExitTimeout = setTimeout(() => {
    console.error("⚠️ Force exit after 10s delay...");
    process.exit(1);
  }, 10000);

  try {
    // 1. فصل قاعدة البيانات
    await prisma.$disconnect();
    console.log("✅ Prisma disconnected.");

    // 2. إغلاق السيرفر والتوقف عن استقبال طلبات جديدة
    server.close(() => {
      console.log("✅ Express server closed.");
      clearTimeout(forceExitTimeout);
      console.log("👋 Goodbye!");
      process.exit(0);
    });
  } catch (err) {
    console.error("❌ Error during shutdown:", err);
    process.exit(1);
  }
};

// الاستماع لإشارات الإغلاق من نظام التشغيل (مهم جداً في ريندر)
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
