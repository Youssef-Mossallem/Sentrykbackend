require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");

// --- 🚀 استيراد المجدول التلقائي الجديد للواتساب (توقيت القاهرة) ---
const startWhatsAppScheduler = require("./corn/whatsappScheduler");

// الميدلوير الأساسي للأمان والصلاحيات
const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
} = require("./middleware/auth");

// استيراد الـ Routers الأساسية للنظام
const authRouter = require("./routes/auth");
const whatsappWebhookRouter = require("./routes/whatsappWebhook");
const centersRouter = require("./routes/centers");
const usersRouter = require("./routes/users");
const roomsRouter = require("./routes/rooms");
const teachersRouter = require("./routes/teachers");
const sessionsRouter = require("./routes/sessions");
const studentsRouter = require("./routes/students");
const subscriptionsRouter = require("./routes/subscriptions");
const whatsappWalletRouter = require("./routes/whatsappWallet");
const activityLogRouter = require("./routes/activity-log");
const paymentsRouter = require("./routes/payments");
const dashboardRouter = require("./routes/dashboard");
const attendanceRouter = require("./routes/attendance");

// ✨ [إضافة أسطورية حصرية]: استيراد راوت محرك الخصومات وأكواد الترويج للـ SaaS
const promoCodesRouter = require("./routes/promoCodes");

// 💳 [إضافة نظام الفواتير والخطط الجديد]: استيراد راوت إدارة الباقات والاشتراكات للـ SaaS
const billingAndPlansRouter = require("./routes/billingAndPlans");

// 🔒 [إضافة الخزنة الكبرى]: استيراد راوت الإدارة المطلقة والتحليلات للـ Super Admin
const superVaultRouter = require("./routes/superVault");

const app = express();
const prisma = new PrismaClient();

// ==== 🌐 إعدادات الـ CORS ====
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-sentryk-admin-key", "x-sentryk-admin-secret"], // تم إضافة الهيدرز السرية هنا لضمان قبولها من المتصفحات
    credentials: true,
  })
);

app.use(express.json());

// =============================================
// 🔓 الراوتات العامة والتحقق من التشغيل
// =============================================
app.use("/api/auth", authRouter);

app.get("/health", (req, res) =>
  res.json({
    status: "OK",
    message: "الباك إند شغال تمام والواتساب مستقر 🚀🔥",
  })
);

// 🌟🌟🌟 محرك التوجيه الفوري اللحظي للروابط القصيرة الخاصة بالطلاب 🌟🌟🌟
app.get("/l/:slug", async (req, res) => {
  const { slug } = req.params;
  try {
    // جلب السجل المقترن بالـ Slug المكثف مباشرة من الداتابيز
    const linkRecord = await prisma.shortLink.findUnique({
      where: { slug },
    });

    // لو السجل سليم، طيران فوري بأداء خارق إلى رابط كارت Cloudinary الأصلي
    if (linkRecord && linkRecord.longUrl) {
      return res.redirect(302, linkRecord.longUrl);
    }

    // 🛡️ Fallback: لو الرابط تم التلاعب به أو غير موجود، نعرض واجهة مستخدم فخمة مريحة للعين بألوان Sentryk
    return res.status(404).send(`
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>الرابط غير صالح | Sentryk</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Readex+Pro:wght@400;600;700&display=swap" rel="stylesheet">
        <style>
          body {
            font-family: 'Readex Pro', sans-serif;
            text-align: center;
            background: #030712;
            color: #ffffff;
            height: 100vh;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
          }
          .container {
            max-width: 450px;
            background: #0f172a;
            border: 1px solid #1e293b;
            padding: 40px 30px;
            border-radius: 20px;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
          }
          h1 { color: #ef4444; font-size: 28px; margin-bottom: 15px; font-weight: 700; }
          p { color: #94a3b8; font-size: 15px; line-height: 1.6; margin-bottom: 30px; }
          .btn {
            display: inline-block;
            padding: 12px 24px;
            background: #3b82f6;
            color: #ffffff;
            text-decoration: none;
            border-radius: 10px;
            font-weight: 600;
            font-size: 14px;
            transition: all 0.2s ease;
          }
          .btn:hover { background: #2563eb; transform: translateY(-2px); }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🛑 الرابط غير صالح أو منتهي</h1>
          <p>عذراً، لم نتمكن من العثور على كارت الحضور الذكي المطلوب في قاعدة بيانات المنظومة. يرجى مراجعة إدارة السنتر التعليمي لإعادة إرسال الكارت الفعال.</p>
          <a href="${process.env.FRONTEND_URL || "https://sentryk.com"}" class="btn">العودة لمنصة Sentryk</a>
        </div>
      </body>
      </html>
    `);

  } catch (error) {
    console.error("❌ [Sentryk Custom Redirect Core Error]:", error.message);
    return res.status(500).json({ error: "حصل خطأ داخلي أثناء معالجة توجيه الرابط القصير" });
  }
});

// ===========================================================================
// 💳 محرك فواتير الدفع والاشتراكات (مفتوح للسناتر لتجديد الاشتراكات المنتهية)
// ===========================================================================
app.use("/api/payments", paymentsRouter);

// تفعيل راوت الخطط وباقات الـ SaaS (محمي بالتوكن والسنتر، ولكن لا يشترط اشتراك نشط لتسهيل الترقية)
app.use(
  "/api/billing-plans",
  authenticateToken,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  billingAndPlansRouter
);

// =============================================
// ✨ [إدارة أكواد الخصم والـ SaaS الكبرى] 
// =============================================
app.use("/api/promo-codes", promoCodesRouter);

// ===========================================================================
// 🔒 [الخزنة الأمنية الكبرى للـ Super Admin - إدارة المنصة والتحليلات]
// ===========================================================================
// تم تفعيله هنا ليمر بحرية، والملف نفسه يحتوي على الفلاتر الداخلية الصارمة، الـ TOTP وجلسة الـ JWT المنفصلة
app.use("/api/super-vault", superVaultRouter);


// =============================================
// 📩 WEBHOOK (لازم يكون قبل 404 دايمًا)
// =============================================
app.use("/api/whatsapp-webhook", whatsappWebhookRouter);


// =============================================
// 🔒 الراوتات المحمية بالكامل للسناتر التعليمية (تشترط اشتراك نشط)
// =============================================

app.use(
  "/api/centers",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  centersRouter
);

app.use(
  "/api/users",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  usersRouter
);

app.use(
  "/api/rooms",
  authenticateToken,
  requireActiveSubscription,
  requireCenterAccess,
  roomsRouter
);

app.use(
  "/api/teachers",
  authenticateToken,
  requireActiveSubscription,
  requireCenterAccess,
  teachersRouter
);

app.use(
  "/api/sessions",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  sessionsRouter
);

app.use(
  "/api/students",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  studentsRouter
);

app.use(
  "/api/subscriptions",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  subscriptionsRouter
);

app.use(
  "/api/whatsapp-wallet",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  whatsappWalletRouter
);

app.use(
  "/api/activity-log",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  activityLogRouter
);

app.use(
  "/api/dashboard",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  dashboardRouter
);

app.use(
  "/api/attendance",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  attendanceRouter
);

// =============================================
// ⏰ تشغيل الـ Scheduler لمحرك الرسائل التلقائي
// =============================================
try {
  startWhatsAppScheduler();
  console.log("⏰ WhatsApp Scheduler engine initiated successfully.");
} catch (err) {
  console.error("❌ Failed to start WhatsApp Scheduler Engine:", err.message);
}

// =============================================
// 🛠️ 404 (لازم يكون في الآخر تمامًا)
// =============================================
app.use((req, res) =>
  res.status(404).json({
    error: "الراوت أو المسار المطلوب غير موجود بالسيستم 🛑",
  })
);

// =============================================
// ❌ Error Handler المركزي لمعالجة جميع أخطاء السيرفر الجانبية
// =============================================
app.use((err, req, res, next) => {
  console.error("❌ خطأ غير متوقع في خادم Sentryk:", err.stack);
  res.status(500).json({
    error: "حصل خطأ داخلي غير متوقع في السيرفر",
    details:
      process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// =============================================
// 🏁 تشغيل السيرفر وحجز المنفذ
// =============================================
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`
  **********************************************************
  🚀 سيرفر منظومة Sentryk الذكية جاهز ومستقر الآن!
  📡 المنفذ الحالي: ${PORT}
  🔗 الرابط المحلي: http://localhost:${PORT}
  🌍 توقيت المنظومة: Africa/Cairo
  **********************************************************
  `);
});

// =============================================
// 🔒 الإغلاق الآمن للنظام (Graceful Shutdown) لحماية قاعدة البيانات من الـ Corruptions
// =============================================
const gracefulShutdown = async (signal) => {
  console.log(`🛑 Received ${signal}, shutting down...`);

  const forceExitTimeout = setTimeout(() => {
    console.error("⚠️ Forced shutdown executed!");
    process.exit(1);
  }, 10000);

  try {
    await prisma.$disconnect();

    server.close(() => {
      clearTimeout(forceExitTimeout);
      console.log("✅ Server closed cleanly and Prisma disconnected safely.");
      process.exit(0);
    });
  } catch (err) {
    console.error("❌ Shutdown error:", err);
    process.exit(1);
  }
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));