const express = require("express");
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");
const crypto = require("crypto");
const QRCode = require("qrcode");
const cloudinary = require("cloudinary").v2;
const { createCanvas, loadImage } = require("canvas");
const fs = require("fs");
const path = require("path");
const { nanoid } = require("nanoid"); // 🌟 المحرك السري لتوليد الـ Slugs الفريدة والمكثفة

const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
  checkMaxLimit,
} = require("../middleware/auth");

const { sendAutoWhatsApp } = require("../utils/whatsappUtils");

const router = express.Router();
const prisma = new PrismaClient();

// =============================================
// Cloudinary Config
// =============================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// =============================================
// Helpers & Configurations
// =============================================
const ALLOWED_STAGES = ["PRIMARY", "MIDDLE", "HIGH"];
const ALLOWED_SUBSCRIPTION_TYPES = [
  "PER_SESSION",
  "MONTHLY",
  "HALF_MONTH",
  "COURSE",
];

// ثوابت الألوان المأخوذة من إعدادات Tailwind لتصميم الكارت الدارك الاحترافي
const BRAND_COLORS = {
  bg: "#030712", // أسود عميق جداً (dark.bg)
  card: "#0f172a", // لون الكروت الداخلي (dark.card)
  border: "#1e293b", // لون الحدود والخطوط الدقيقة (dark.border)
  primary: "#3b82f6", // الأزرق الأساسي المضيء (primary.500)
  textMain: "#ffffff", // النص الأبيض الأساسي
  textMuted: "#94a3b8", // النص الرمادي الفرعي
};

/**
 * دالة مساعدة لرفع البافر (Buffer) مباشرة إلى Cloudinary عبر مسارات تدفق البيانات Streams
 */
function uploadBufferToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    console.log(
      "⏳ [Cloudinary Stream]: جاري فتح مسار تدفق البيانات لرفع بافر الصورة...",
    );
    const uploadStream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) {
          console.error(
            "❌ [Cloudinary Stream Error]: تفجر الرفع السحابي عبر التدفق:",
            error.message,
          );
          return reject(error);
        }
        console.log(
          "✅ [Cloudinary Stream Success]: تمت عملية الرفع السحابي بنجاح ميكانيكي.",
        );
        resolve(result);
      },
    );
    uploadStream.end(buffer);
  });
}

/**
 * 👑 محرك تقصير الروابط الداخلي الفخم واللحظي لمنظومة Sentryk
 * توليد كود فريد (Slug) وحفظه برابط Cloudinary الأصلي مقترناً بمعرف السنتر (Multi-Tenancy)
 */
async function generateSentrykShortUrl(longUrl, centerId = null) {
  console.log(
    `🔗 [Sentryk Shortener]: محاولة توليد رابط قصير للرابط الطويل: ${longUrl}`,
  );
  if (!longUrl || !String(longUrl).startsWith("http")) {
    console.warn(
      "⚠️ [Sentryk Shortener]: الرابط الطويل غير صالح أو فارغ. تم إلغاء التقصير.",
    );
    return longUrl || "";
  }

  try {
    if (!centerId) {
      console.warn(
        "⚠️ [Sentryk Shortener]: تم استدعاء دالة التقصير بدون تمرير centerId. سيتم إرجاع الرابط الأصلي.",
      );
      return longUrl;
    }

    const slug = nanoid(12);
    console.log(
      `⚙️ [Sentryk Shortener]: تم توليد الـ Slug الفريد بنجاح: [${slug}]. جاري الحفظ في الـ DB...`,
    );

    await prisma.shortLink.create({
      data: {
        slug: slug,
        longUrl: longUrl,
        centerId: Number(centerId),
        description: "رابط كارت حضور ذكي موحد ومولد تلقائياً للطالب",
      },
    });

    const baseUrl = process.env.BACKEND_URL || "https://sentryk.com";
    const finalShortUrl = `${baseUrl}/l/${slug}`;
    console.log(
      `✅ [Sentryk Shortener Success]: تم تسجيل وتفعيل الرابط المختصر الشغال: ${finalShortUrl}`,
    );
    return finalShortUrl;
  } catch (error) {
    console.error(
      "❌ [Sentryk Custom Shortener Critical Error]: تفجر نظام تقصير الروابط المخصص:",
      error.message,
    );
    return longUrl;
  }
}

const isValidSubscriptionType = (value) =>
  ALLOWED_SUBSCRIPTION_TYPES.includes(String(value || "").toUpperCase());
const normalizeStage = (value) =>
  String(value || "")
    .toUpperCase()
    .trim();

const calculateEndDate = (
  subscriptionType,
  durationInMonths = 1,
  baseDate = new Date(),
) => {
  const end = new Date(baseDate);
  end.setHours(23, 59, 59, 999);
  const type = String(subscriptionType || "").toUpperCase();
  console.log(
    `📅 [Date Engine]: حساب تاريخ انتهاء الصلاحية لنوع [${type}] بدءاً من [${baseDate.toISOString()}]`,
  );

  switch (type) {
    case "HALF_MONTH":
      end.setDate(end.getDate() + 15);
      break;
    case "COURSE":
      end.setMonth(end.getMonth() + (Number(durationInMonths) || 3));
      break;
    case "PER_SESSION":
      end.setDate(end.getDate() + 1);
      break;
    case "MONTHLY":
    default:
      end.setMonth(end.getMonth() + 1);
      break;
  }
  console.log(
    `📅 [Date Engine Success]: تاريخ الانتهاء المحسوب بدقة هو: ${end.toISOString()}`,
  );
  return end;
};

const getMatchingPriceConfig = (
  teacher,
  studentStage,
  studentGrade,
  subscriptionType,
) => {
  const stage = normalizeStage(studentStage);
  const type = String(subscriptionType || "").toUpperCase();
  const grade = Number(studentGrade);

  console.log(
    `🔍 [Price Configuration Matching]: جاري مطابقة الأسعار للمدرس [${teacher?.name || "غير معروف"}] | المرحلة: ${stage} | الصف: ${grade} | نوع الاشتراك: ${type}`,
  );

  const configs = Array.isArray(teacher?.priceConfigs)
    ? teacher.priceConfigs
    : [];

  const directMatch = configs.find((cfg) => {
    const cfgStage = normalizeStage(cfg.stage);
    const cfgType = String(cfg.subscriptionType || "").toUpperCase();
    const grades = Array.isArray(cfg.grades) ? cfg.grades : [];
    return cfgStage === stage && cfgType === type && grades.includes(grade);
  });

  if (directMatch) {
    console.log(
      `🎯 [Price Match Found]: تم العثور على تطابق سعر مباشر وصريح بقيمة: ${directMatch.price} ج.م`,
    );
    return directMatch;
  }

  if (type === "HALF_MONTH") {
    console.log(
      "ℹ️ [Price Match fallback]: لم يتم العثور على تهيئة نصف شهرية مباشرة. جاري محاولة الاشتقاق الهيكلي من الباقة الشهرية (القسمة على 2)...",
    );
    const monthlyMatch = configs.find((cfg) => {
      const cfgStage = normalizeStage(cfg.stage);
      const cfgType = String(cfg.subscriptionType || "").toUpperCase();
      const grades = Array.isArray(cfg.grades) ? cfg.grades : [];
      return (
        cfgStage === stage && cfgType === "MONTHLY" && grades.includes(grade)
      );
    });

    if (monthlyMatch) {
      const derivedPrice = Math.round(Number(monthlyMatch.price) / 2);
      console.log(
        `🎯 [Price Match Derived]: تم اشتقاق السعر النصف شهري بنجاح بقيمة: ${derivedPrice} ج.م بناءً على السعر الشهري ${monthlyMatch.price}`,
      );
      return {
        ...monthlyMatch,
        price: derivedPrice,
        subscriptionType: "HALF_MONTH",
      };
    }
  }

  console.warn(
    "⚠️ [Price Match Mismatch]: فشل العثور على أي تهيئة سعرية متطابقة لهذا الكومبو الأكاديمي!",
  );
  return null;
};

const formatSessionForStudent = (item) => {
  const session = item?.session || null;
  const teacher = session?.teacher || null;
  return {
    id: item.id,
    sessionId: item.sessionId,
    sessionName: session?.name || "مجموعة غير محددة",
    sessionSubject: teacher?.subject || null,
    teacher: teacher
      ? { id: teacher.id, name: teacher.name, subject: teacher.subject }
      : null,
    room: session?.room
      ? { id: session.room.id, name: session.room.name }
      : null,
    priceSnapshot: item.priceSnapshot,
  };
};

/**
 * 🎯 الـ Mapper الذكي المسؤول عن صياغة بيانات الطالب للفرونت إند
 */
const mapStudentStatus = (student) => {
  if (!student) return null;
  const now = new Date();
  const safeSubscriptions = Array.isArray(student.subscriptions)
    ? student.subscriptions
    : [];

  const updatedSubscriptions = safeSubscriptions.map((sub) => {
    const endDate = sub.endDate ? new Date(sub.endDate) : null;
    const isExpired = endDate ? endDate < now : true;
    return {
      id: sub.id,
      startDate: sub.startDate,
      endDate: sub.endDate,
      subscriptionType: sub.subscriptionType,
      totalPrice: sub.totalPrice,
      status: isExpired || sub.status === "EXPIRED" ? "EXPIRED" : "ACTIVE",
      enrolledSessions: Array.isArray(sub.items)
        ? sub.items.map((item) => formatSessionForStudent(item))
        : [],
    };
  });

  return {
    id: student.id,
    name: student.name,
    phone: student.phone,
    stage: student.stage,
    grade: student.grade,
    qrToken: student.qrToken,
    qrImageUrl: student.qrImageUrl, // ✨ تم الإصلاح الجذري هنا: الآن الرابط يمرر للفرونت-إند في كل طلبات الـ GET والـ POST تلقائياً
    createdAt: student.createdAt,
    updatedAt: student.updatedAt,
    subscriptions: updatedSubscriptions,
    computedStatus: updatedSubscriptions.some((sub) => sub.status === "ACTIVE")
      ? "ACTIVE"
      : "EXPIRED",
  };
};

async function safeSendWhatsApp(studentId, type, payload = {}) {
  console.log(
    `📩 [WhatsApp Notification Trigger]: محاولة إرسال رسالة آلية للطالب رقم [${studentId}] من نوع [${type}]`,
  );
  try {
    if (typeof sendAutoWhatsApp === "function") {
      await sendAutoWhatsApp(studentId, type, payload);
      console.log(
        `📩 [WHATSAPP NOTIFICATION SENT] تم إرسال رسالة الترحيب والـ QR بنجاح للطالب ID: ${studentId}`,
      );
    } else {
      console.warn(
        "⚠️ [WhatsApp Notification Bypass]: دالة sendAutoWhatsApp غير موجودة أو لم يتم استيرادها بشكل صحيح.",
      );
    }
  } catch (error) {
    console.error(
      `❌ [STUDENT ROUTE WHATSAPP ERROR] فشل إرسال إشعار الواتساب للطالب رقم ${studentId}:`,
      error.message,
    );
  }
}

// =============================================
// المحرك المعماري لرسم الكارت الذكي (Sentryk Elite Canvas QR Designer)
// =============================================
async function generateSentrykEliteCard({ studentName, centerName, qrToken }) {
  console.log(
    `🎨 [Canvas Designer]: بدء رسم كارت الحضور النخبوي الفخم للطالب: [${studentName}]...`,
  );
  const width = 550;
  const height = 720;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = BRAND_COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  const cardMargin = 25;
  const cardWidth = width - cardMargin * 2;
  const cardHeight = height - cardMargin * 2;
  const radius = 24;

  ctx.save();
  ctx.fillStyle = BRAND_COLORS.card;
  ctx.strokeStyle = BRAND_COLORS.border;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(cardMargin, cardMargin, cardWidth, cardHeight, radius);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.save();
  let gradient = ctx.createRadialGradient(
    width / 2,
    height / 2,
    50,
    width / 2,
    height / 2,
    300,
  );
  gradient.addColorStop(0, "rgba(59, 130, 246, 0.08)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(cardMargin, cardMargin, cardWidth, cardHeight);
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const fontStack = '"Readex Pro", "Segoe UI", "Arial", sans-serif';

  ctx.fillStyle = BRAND_COLORS.primary;
  ctx.font = `bold 24px ${fontStack}`;
  ctx.fillText(centerName || "المركز التعليمي المشترك", width / 2, 75);

  ctx.fillStyle = BRAND_COLORS.textMuted;
  ctx.font = `14px ${fontStack}`;
  ctx.fillText("بـطـاقـة الـحـضـور الـذكـيـة • SENTRYK", width / 2, 110);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = BRAND_COLORS.border;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(cardMargin + 30, 140);
  ctx.lineTo(width - cardMargin - 30, 140);
  ctx.stroke();
  ctx.restore();

  const qrSize = 300;
  const qrX = (width - qrSize) / 2;
  const qrY = 180;

  console.log(
    `🔮 [Canvas Designer - QR Generator]: جاري إنتاج كتل الـ QR Code للتوكن: ${qrToken}`,
  );
  const qrRawData = QRCode.create(qrToken, { errorCorrectionLevel: "H" });
  const modules = qrRawData.modules;
  const moduleCount = modules.size;
  const cellSize = qrSize / moduleCount;

  ctx.save();
  ctx.strokeStyle = "rgba(59, 130, 246, 0.4)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(qrX - 15, qrY - 15, qrSize + 30, qrSize + 30, 16);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  for (let r = 0; r < moduleCount; r++) {
    for (let c = 0; c < moduleCount; c++) {
      const centerStart = Math.floor(moduleCount / 2) - 3;
      const centerEnd = Math.floor(moduleCount / 2) + 3;
      if (
        r >= centerStart &&
        r <= centerEnd &&
        c >= centerStart &&
        c <= centerEnd
      ) {
        continue;
      }

      if (modules.get(r, c)) {
        const xPos = qrX + c * cellSize;
        const yPos = qrY + r * cellSize;

        const isFinderPattern =
          (r < 7 && c < 7) ||
          (r < 7 && c >= moduleCount - 7) ||
          (r >= moduleCount - 7 && c < 7);

        if (isFinderPattern) {
          ctx.fillStyle = BRAND_COLORS.primary;
          ctx.fillRect(xPos, yPos, cellSize, cellSize);
        } else {
          ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
          ctx.beginPath();
          ctx.arc(
            xPos + cellSize / 2,
            yPos + cellSize / 2,
            cellSize * 0.38,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
      }
    }
  }
  ctx.restore();

  ctx.save();
  const logoSize = 60;
  const logoX = qrX + (qrSize - logoSize) / 2;
  const logoY = qrY + (qrSize - logoSize) / 2;

  ctx.fillStyle = BRAND_COLORS.card;
  ctx.strokeStyle = BRAND_COLORS.primary;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(
    logoX + logoSize / 2,
    logoY + logoSize / 2,
    logoSize / 2 + 4,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.stroke();

  const logoPath = path.join(process.cwd(), "public", "assets", "logo.png");

  if (fs.existsSync(logoPath)) {
    try {
      const logoImg = await loadImage(logoPath);
      ctx.beginPath();
      ctx.arc(
        logoX + logoSize / 2,
        logoY + logoSize / 2,
        logoSize / 2 + 2,
        0,
        Math.PI * 2,
      );
      ctx.clip();
      ctx.drawImage(logoImg, logoX, logoY, logoSize, logoSize);
    } catch (logoErr) {
      console.error(
        "⚠️ [Canvas Logo Load Error]: فشل تحميل اللوجو الرسومي، جاري الانتقال للبديل النصي السريع:",
        logoErr.message,
      );
      renderFallbackLogo(ctx, logoX, logoSize, logoY);
    }
  } else {
    renderFallbackLogo(ctx, logoX, logoSize, logoY);
  }
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillStyle = BRAND_COLORS.textMain;
  ctx.font = `bold 26px ${fontStack}`;
  ctx.fillText(studentName, width / 2, 535);

  ctx.fillStyle = BRAND_COLORS.textMuted;
  ctx.font = `15px ${fontStack}`;
  ctx.fillText(`كود الهوية الرقمية: ${qrToken}`, width / 2, 580);

  ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
  ctx.beginPath();
  ctx.roundRect(cardMargin + 40, 620, cardWidth - 80, 45, 12);
  ctx.fill();

  ctx.fillStyle = BRAND_COLORS.primary;
  ctx.font = `600 14px ${fontStack}`;
  ctx.fillText(
    "يرجى إبراز الكارت للمساعد عند بوابات القاعات لتسجيل الحضور اللحظي",
    width / 2,
    642,
  );
  ctx.restore();

  console.log(
    `✅ [Canvas Designer Success]: تم الفراغ من رسم بافر الكارت بالكامل بنجاح للطالب: ${studentName}`,
  );
  return canvas.toBuffer("image/png");
}

function renderFallbackLogo(ctx, logoX, logoSize, logoY) {
  ctx.fillStyle = BRAND_COLORS.primary;
  ctx.beginPath();
  ctx.arc(
    logoX + logoSize / 2,
    logoY + logoSize / 2,
    logoSize / 3,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 20px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("S", logoX + logoSize / 2, logoY + logoSize / 2);
}

// =============================================
// Validation Middlewares
// =============================================
const validateStudentCreateInput = (req, res, next) => {
  const { name, phone, stage, grade } = req.body;
  console.log("📥 [Validator]: فحص الحقول الأساسية لطلب إنشاء الطالب...");
  if (!name || !phone || !stage || grade === undefined) {
    console.warn(
      "⚠️ [Validator Mismatch]: حقول مفقودة في الطلب المرسل:",
      req.body,
    );
    return res.status(400).json({
      error:
        "جميع الحقول الأساسية مطلوبة (الاسم، الهاتف، المرحلة، السنة الدراسية)",
    });
  }
  if (!ALLOWED_STAGES.includes(String(stage).toUpperCase().trim())) {
    console.warn(
      `⚠️ [Validator Mismatch]: مرحلة دراسية غير مسموح بها نظاماً: [${stage}]`,
    );
    return res
      .status(400)
      .json({ error: "المرحلة الدراسية المرسلة غير صالحة" });
  }
  if (isNaN(Number(grade))) {
    console.warn(
      `⚠️ [Validator Mismatch]: السنة الدراسية ليست رقماً صالحاً: [${grade}]`,
    );
    return res
      .status(400)
      .json({ error: "السنة الدراسية يجب أن تكون رقمًا صحيحًا" });
  }
  console.log("✅ [Validator Success]: تخطي مرحلة فحص المدخلات بنجاح تام.");
  next();
};

// =============================================
// Routes Handlers
// =============================================

// 1) إضافة طالب جديد وتوليد كارت الـ QR الاحترافي الجديد مع الحفظ التلقائي في قاعدة البيانات للـ Link
router.post(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  validateStudentCreateInput,
  checkMaxLimit,
  async (req, res) => {
    console.log(
      "🚀 [Route POST /]: استقبال طلب إنشاء طالب فردي جديد وحقنه بالمعاملة البرمجية...",
    );
    try {
      const {
        name,
        phone,
        stage,
        grade,
        subscriptions,
        qrToken: customQrToken,
        isOfflineMode,
        offlineCreatedAt,
      } = req.body;

      const { centerId, userId } = req.user;
      const normalizedStage = normalizeStage(stage);
      const numericGrade = Number(grade);

      const studentCreationDate =
        isOfflineMode && offlineCreatedAt
          ? new Date(offlineCreatedAt)
          : new Date();
      const finalQrToken =
        customQrToken?.trim() ||
        `STU-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;

      console.log(
        `⚙️ [Route POST / Config]: السنتر ID: ${centerId} | المنشئ ID: ${userId} | الـ QR المعتمد للعملية: ${finalQrToken}`,
      );

      // جلب اسم السنتر مسبقاً لاستخدامه في رسم الكارت دون تعطيل المعاملة
      const currentCenter = await prisma.center.findUnique({
        where: { id: centerId },
        select: { name: true },
      });
      const targetCenterName = currentCenter?.name || "المركز التعليمي الحالي";

      // تنفيذ الخطوات الحرجة في قاعدة البيانات داخل سياق Transaction معزول
      console.log(
        "⛓️ [Prisma Transaction]: بدء المعاملة المتسلسلة لإنشاء الطالب واشتراكاته...",
      );
      const transactionResult = await prisma.$transaction(async (tx) => {
        // التحقق الاستباقي الصارم من عدم تكرار التوكن لمنع أخطاء الـ Unique constraint
        const existingTokenStudent = await tx.student.findUnique({
          where: { qrToken: finalQrToken },
        });
        if (existingTokenStudent) {
          throw new Error(
            `رمز التوكن الرقمي [${finalQrToken}] محجوز مسبقاً لطالب آخر بالنظام`,
          );
        }

        console.log(
          `📝 [Transaction - Step 1]: جاري إدراج سجل كائن الطالب الرئيسي باسم: ${name}`,
        );
        const newStudent = await tx.student.create({
          data: {
            name: name.trim(),
            phone: phone.trim(),
            stage: normalizedStage,
            grade: numericGrade,
            centerId: centerId,
            qrToken: finalQrToken,
            createdAt: studentCreationDate,
          },
        });
        console.log(
          `🔹 [Transaction - Step 1 Success]: تم إنشاء الطالب بنجاح وحصل على معرف رقمي ID: ${newStudent.id}`,
        );

        let createdSubscriptionIds = [];
        if (
          subscriptions &&
          Array.isArray(subscriptions) &&
          subscriptions.length > 0
        ) {
          console.log(
            `📝 [Transaction - Step 2]: جاري معالجة الاشتراكات المضمنة لربط المجموعات التعليمية عدد: ${subscriptions.length}`,
          );

          for (const sub of subscriptions) {
            const {
              subscriptionType,
              items,
              totalSessions: chosenSessions,
                } = sub;
            if (!isValidSubscriptionType(subscriptionType)) {
              throw new Error(
                `نوع باقة الاشتراك المرسل غير مدعوم بالنظام: [${subscriptionType}]`,
              );
            }

            // تحقق صارم من تمرير عدد الحصص المشحونة في حال اختيار الاشتراك بالحصة
            if (subscriptionType === "PER_SESSION") {
              if (
                !chosenSessions ||
                typeof chosenSessions !== "number" ||
                chosenSessions < 1
              ) {
                throw new Error(
                  `يا هندسة، يجب تحديد عدد الحصص المطلوبة (totalSessions) بشكل صحيح لا يقل عن 1 عند اختيار اشتراك بالحصة لشحن رصيد الطالب.`,
                );
              }
            }

            let totalPrice = 0;
            let itemsToCreate = [];
            let detectedDurationMonths = null;
            let detectedTotalSessions = null;

            if (items && Array.isArray(items)) {
              for (const item of items) {
                const { sessionId } = item;
                console.log(
                  `🔍 [Transaction - sub-loop]: جاري فحص والتحقق من وجود المجموعة رقم: ${sessionId}`,
                );

                const sessionData = await tx.session.findUnique({
                  where: { id: Number(sessionId) },
                  include: { teacher: { include: { priceConfigs: true } } },
                });

                if (!sessionData) {
                  throw new Error(
                    `المجموعة التعليمية المطلوبة بالرقم [${sessionId}] غير موجودة بالسيستم كلياً`,
                  );
                }

                // مطابقة واشتقاق السعر من إعدادات المدرس
                const priceConfig = getMatchingPriceConfig(
                  sessionData.teacher,
                  normalizedStage,
                  numericGrade,
                  subscriptionType,
                );

                if (!priceConfig) {
                  throw new Error(
                    `فشل التسجيل: لا توجد فئة سعرية مهيأة للمدرس [${sessionData.teacher?.name || "غير محدد"}] تطابق المرحلة والصف ونوع الاشتراك الحالي لهذه المجموعة.`,
                  );
                }

                // احتساب السعر بذكاء بناءً على التحديث الجديد لعدد الحصص والمدد
                let itemPrice = Number(priceConfig.price);
                if (subscriptionType === "PER_SESSION") {
                  // السعر الإجمالي للمجموعة الحالية = سعر الحصة الواحدة × عدد الحصص التي اختارها الطالب
                  itemPrice = itemPrice * chosenSessions;
                } else if (subscriptionType === "COURSE") {
                  // الاحتفاظ بالمدد والبيانات الافتراضية للكورس من الـ Schema
                  detectedDurationMonths = priceConfig.durationMonths;
                  detectedTotalSessions = priceConfig.totalSessions;
                } else if (
                  subscriptionType === "MONTHLY" ||
                  subscriptionType === "HALF_MONTH"
                ) {
                  detectedTotalSessions = priceConfig.totalSessions;
                }

                totalPrice += itemPrice;
                itemsToCreate.push({
                  sessionId: Number(sessionId),
                  priceSnapshot: itemPrice, // يتم تخزين السعر الإجمالي المشحون لضمان دقة تقارير إيرادات المدرس الحية
                });
              }
            }

            // حساب تاريخ انتهاء الصلاحية بناءً على المدة المكتشفة للكورس أو القيمة الافتراضية (شهر واحد)
            const finalDurationMonths =
              subscriptionType === "COURSE" ? detectedDurationMonths || 1 : 1;
            const endDate = calculateEndDate(
              subscriptionType,
              finalDurationMonths,
              studentCreationDate,
            );

            console.log(
              `📝 [Transaction - sub-loop]: جاري إدراج باقة اشتراك الطالب بقيمة إجمالية: ${totalPrice} ج.م وبعدد حصص: ${subscriptionType === "PER_SESSION" ? chosenSessions : detectedTotalSessions || "حسب النوع"}`,
            );

            // إدراج الاشتراك متضمناً كافة البيانات الهندسية المحدثة لعدادات الحصص
            const newSubscription = await tx.subscription.create({
              data: {
                studentId: newStudent.id,
                subscriptionType: subscriptionType.toUpperCase(),
                totalPrice: totalPrice,
                endDate: endDate,
                status: "ACTIVE",
                createdBy: userId,
                createdAt: studentCreationDate,
                totalSessions:
                  subscriptionType === "PER_SESSION"
                    ? chosenSessions
                    : detectedTotalSessions || null,
                durationMonths:
                  subscriptionType === "COURSE" ? finalDurationMonths : null,
                items: { create: itemsToCreate },
              },
            });
            createdSubscriptionIds.push(newSubscription.id);
          }
        }

        console.log(
          "📝 [Transaction - Step 3]: جاري تدوين السجلات الأمنية في لوج النشاطات العام...",
        );
        await tx.activityLog.create({
          data: {
            centerId,
            userId,
            action: isOfflineMode ? "SYNC_OFFLINE_STUDENT" : "CREATE_STUDENT",
            targetType: "Student",
            targetId: newStudent.id,
            createdAt: studentCreationDate,
            details: JSON.stringify({
              name: newStudent.name,
              isOfflineSync: !!isOfflineMode,
              subscriptionsCount: createdSubscriptionIds.length,
            }),
          },
        });

        // إرجاع البيانات الهامة للخارج لمرحلة معالجة الميديا والرفع
        return { studentId: newStudent.id, studentName: newStudent.name };
      });

      console.log(
        "✅ [Prisma Transaction Success]: تم إغلاق وتثبيت المعاملة بنجاح كامل في الداتابيز.",
      );

      // جلب كائن الطالب كاملاً مع ملحقاته وعلاقاته لإعادته للفرونت إند متطابق 100% مع الـ Mapper بشكل سريع جداً (بدون انتظار الصور)
      console.log(
        "🔄 [Final Fetch]: سحب ملف الطالب المحدث كلياً من قاعدة البيانات لإرساله للاستجابة السريعة...",
      );
      const completeCreatedStudent = await prisma.student.findUnique({
        where: { id: transactionResult.studentId },
        include: {
          subscriptions: {
            include: {
              items: {
                include: {
                  session: {
                    include: {
                      teacher: true,
                      room: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      console.log(
        `✨ [API Response Sent]: تم إرسال كود النجاح 201 الفوري. تم إنشاء الطالب [${transactionResult.studentName}] بنجاح نخبوي ميكانيكي.`,
      );

      // الرد الفوري المباشر على العميل / الفرونت إند لكسر حاجز الـ 12 ثانية انتهاءاً بـ 30 مللي ثانية فقط!
      res.status(201).json({
        success: true,
        message: "تم تسجيل الطالب بنجاح (جاري توليد الكارت وإرساله بالخلفية) 🚀",
        student: mapStudentStatus(completeCreatedStudent),
      });

      // ======================================================================
      // === خط إنتاج العمليات الثقيلة (Background Execution Pipeline) ===
      // ======================================================================
      setImmediate(async () => {
        try {
          console.log(
            `🎨 [Background Phase]: البدء الفوري في محرك توليد وتصميم كارت الهوية النخبوي للطالب [${transactionResult.studentName}] ذو المعرف [${transactionResult.studentId}]...`,
          );
          
          const cardBuffer = await generateSentrykEliteCard({
            studentName: transactionResult.studentName,
            centerName: targetCenterName,
            qrToken: finalQrToken,
          });

          let qrImageUrl = null;
          let shortQrUrl = null;

          if (process.env.CLOUDINARY_CLOUD_NAME) {
            console.log(
              `☁️ [Background Cloudinary]: جاري رفع كارت الطالب لـ Cloudinary...`,
            );
            const uploadResult = await uploadBufferToCloudinary(cardBuffer, {
              folder: `sentryk/center_${centerId}/qrcodes`,
              public_id: `card_${finalQrToken}`,
              overwrite: true,
            });

            qrImageUrl = uploadResult.secure_url;
            console.log(
              `☁️ [Background Cloudinary Success]: الرابط المباشر المستقر: ${qrImageUrl}`,
            );

            // تمرير الرابط المباشر لمحرك التقصير السيادي الخاص بـ Sentryk
            shortQrUrl = await generateSentrykShortUrl(qrImageUrl, centerId);

            const finalSavedUrl = shortQrUrl || qrImageUrl;
            console.log(
              `⚙️ [Background Database Update]: جاري حفظ رابط الكارت المعتمد [${finalSavedUrl}] في ملف الطالب رقم [${transactionResult.studentId}]`,
            );

            await prisma.student.update({
              where: { id: transactionResult.studentId },
              data: { qrImageUrl: finalSavedUrl },
            });
            console.log(
              "✅ [Background Database Update Success]: تم دمج الرابط المظلي بالملف بنجاح في الخلفية.",
            );

            // إرسال الإشعار الترحيبي والـ QR عبر خطافات الواتساب غير الحاصرة بعد التأكد من دمج الرابط تماماً
            if (finalSavedUrl) {
              console.log(
                `💬 [Background WhatsApp]: جاري تحضير وإرسال الرسالة الترحيبية الشاملة على الواتساب للمستخدم...`,
              );
              await safeSendWhatsApp(transactionResult.studentId, "FIRST_SUB", {
                qrImageUrl: finalSavedUrl,
              });
              console.log(`✅ [Background WhatsApp Success]: تم إرسال كارت الهوية والرسالة عبر الواتساب بنجاح.`);
            }
          } else {
            console.warn(
              "⚠️ [Background Cloudinary Warning]: متغيرات البيئة لـ Cloudinary غائبة، تم تجاوز الرفع السحابي والواتساب بالخلفية.",
            );
          }
        } catch (mediaError) {
          console.error(
            "❌ [Background Isolated Media Phase Error]: حدث فشل أثناء معالجة الكارت أو رفعه بالخلفية، تم عزل الخطأ لضمان استقرار الخادم:",
            mediaError.message,
          );
        }
      });

    } catch (error) {
      console.error(
        "❌ [Sentryk Student Create Critical Error]: انهار مسار تسجيل الطالب الفردي كلياً. التفاصيل الفنية المكتشفة 👇",
      );
      console.error(error);
      return res.status(500).json({
        success: false,
        error:
          "فشل إتمام عملية تسجيل الطالب نظراً لوجود تعارض في البيانات أو إعدادات السعر",
        details: error.message,
      });
    }
  },
);

// 1.5) مزامنة الدفعة المجمعة المتقدمة من الطلاب أوفلاين (Bulk Synchronization Mode)
router.post(
  "/bulk-sync",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    console.log(
      "📥 [Bulk Sync Engine]: استلام دفعة مجمعة جديدة للمزامنة الهيكلية في الخلفية...",
    );
    try {
      const { students: studentsArray } = req.body;
      if (!studentsArray || !Array.isArray(studentsArray)) {
        console.warn(
          "⚠️ [Bulk Sync Engine]: البيانات المرسلة لا تطابق مصفوفة صالحة",
        );
        return res
          .status(400)
          .json({ error: "يجب إرسال مصفوفة طلاب صالحة تحت مفتاح 'students'" });
      }

      const { centerId, userId } = req.user;

      const currentCenter = await prisma.center.findUnique({
        where: { id: centerId },
        select: { name: true },
      });
      const targetCenterName = currentCenter?.name || "المركز التعليمي الحالي";

      const syncSummary = { succeeded: [], failed: [] };
      console.log(
        `⚙️ [Bulk Sync Engine]: جاري معالجة مصفوفة تحتوي على [${studentsArray.length}] طالب...`,
      );

      for (const studentData of studentsArray) {
        try {
          const {
            name,
            phone,
            stage,
            grade,
            subscriptions,
            qrToken,
            offlineCreatedAt,
          } = studentData;

          if (
            !name?.trim() ||
            !phone?.trim() ||
            !stage ||
            grade === undefined
          ) {
            throw new Error(
              "بيانات الطالب الأساسية غير مكتملة أو تحتوي على قيم فارغة",
            );
          }

          const normalizedStage = normalizeStage(stage);
          const numericGrade = Number(grade);
          const studentCreationDate = offlineCreatedAt
            ? new Date(offlineCreatedAt)
            : new Date();
          const finalQrToken =
            qrToken?.trim() ||
            `STU-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;

          // معالجة كل طالب على حدة في معاملة منفصلة معزولة حتى لا تنهار كامل الدفعة في حال خطأ طالب واحد
          const syncRecord = await prisma.$transaction(async (tx) => {
            const tokenConflict = await tx.student.findUnique({
              where: { qrToken: finalQrToken },
            });
            if (tokenConflict) {
              throw new Error(
                `رمز التوكن الـ QR [${finalQrToken}] مستخدم بالفعل مسبقاً بطالب آخر`,
              );
            }

            const newStudent = await tx.student.create({
              data: {
                name: name.trim(),
                phone: phone.trim(),
                stage: normalizedStage,
                grade: numericGrade,
                centerId: centerId,
                qrToken: finalQrToken,
                createdAt: studentCreationDate,
              },
            });

            if (subscriptions && Array.isArray(subscriptions)) {
              for (const sub of subscriptions) {
                const {
                  subscriptionType,
                  items,
                  totalSessions: chosenSessions,
                } = sub;

                if (!isValidSubscriptionType(subscriptionType)) {
                  throw new Error(
                    `نوع باقة الاشتراك [${subscriptionType}] غير مدعوم بالنظام كلياً.`,
                  );
                }

                // التحقق الصارم من تمرير عدد الحصص في الاشتراك بالحصة داخل الدفعة المجمعة
                if (subscriptionType === "PER_SESSION") {
                  if (
                    !chosenSessions ||
                    typeof chosenSessions !== "number" ||
                    chosenSessions < 1
                  ) {
                    throw new Error(
                      `فشل المزامنة: يجب تحديد عدد الحصص المطلوبة (totalSessions) بحيث لا تقل عن 1 عند اختيار اشتراك بالحصة لشحن رصيد الطالب أوفلاين.`,
                    );
                  }
                }

                let totalPrice = 0;
                let itemsToCreate = [];
                let detectedDurationMonths = null;
                let detectedTotalSessions = null;

                if (items && Array.isArray(items)) {
                  for (const item of items) {
                    const { sessionId } = item;
                    const sessionData = await tx.session.findUnique({
                      where: { id: Number(sessionId) },
                      include: {
                        teacher: { include: { priceConfigs: true } },
                      },
                    });

                    if (!sessionData) {
                      throw new Error(
                        `المجموعة التعليمية بالرقم [${sessionId}] غير موجودة بالسيستم`,
                      );
                    }

                    const priceConfig = getMatchingPriceConfig(
                      sessionData.teacher,
                      normalizedStage,
                      numericGrade,
                      subscriptionType,
                    );

                    if (!priceConfig) {
                      throw new Error(
                        `لا توجد فئة سعرية مهيأة للمدرس تطابق هذه المجموعة والصف ونوع الاشتراك.`,
                      );
                    }

                    // احتساب السعر بذكاء هندسي بناءً على نوع الاشتراك والبيانات المحدثة
                    let itemPrice = Number(priceConfig.price);
                    if (subscriptionType === "PER_SESSION") {
                      itemPrice = itemPrice * chosenSessions;
                    } else if (subscriptionType === "COURSE") {
                      detectedDurationMonths = priceConfig.durationMonths;
                      detectedTotalSessions = priceConfig.totalSessions;
                    } else if (
                      subscriptionType === "MONTHLY" ||
                      subscriptionType === "HALF_MONTH"
                    ) {
                      detectedTotalSessions = priceConfig.totalSessions;
                    }

                    totalPrice += itemPrice;
                    itemsToCreate.push({
                      sessionId: Number(sessionId),
                      priceSnapshot: itemPrice, // تخزين لقطة السعر الإجمالي المشحون
                    });
                  }
                }

                // حساب تاريخ انتهاء الصلاحية المعتمد
                const finalDurationMonths =
                  subscriptionType === "COURSE"
                    ? detectedDurationMonths || 1
                    : 1;
                const endDate = calculateEndDate(
                  subscriptionType,
                  finalDurationMonths,
                  studentCreationDate,
                );

                await tx.subscription.create({
                  data: {
                    studentId: newStudent.id,
                    subscriptionType: subscriptionType.toUpperCase(),
                    totalPrice: totalPrice,
                    endDate: endDate,
                    status: "ACTIVE",
                    createdBy: userId,
                    createdAt: studentCreationDate,
                    totalSessions:
                      subscriptionType === "PER_SESSION"
                        ? chosenSessions
                        : detectedTotalSessions || null,
                    durationMonths:
                      subscriptionType === "COURSE"
                        ? finalDurationMonths
                        : null,
                    items: { create: itemsToCreate },
                  },
                });
              }
            }

            await tx.activityLog.create({
              data: {
                centerId,
                userId,
                action: "SYNC_OFFLINE_STUDENT",
                targetType: "Student",
                targetId: newStudent.id,
                createdAt: studentCreationDate,
                details: JSON.stringify({
                  name: newStudent.name,
                  isOfflineSync: true,
                }),
              },
            });

            return newStudent;
          });

          // ترحيل عمليات معالجة الميديا والرفع السحابي للخلفية فوراً عبر الـ Microtasks للتسريع الزمني الفائق
          setImmediate(() => {
            console.log(
              `⏳ [Background Worker]: جاري رسم ومعالجة بطاقة الطالب المزامَن [${syncRecord.name}]...`,
            );
            generateSentrykEliteCard({
              studentName: syncRecord.name,
              centerName: targetCenterName,
              qrToken: finalQrToken,
            })
              .then(async (cardBuffer) => {
                let savedUrl = null;
                if (process.env.CLOUDINARY_CLOUD_NAME) {
                  const uploadResult = await uploadBufferToCloudinary(
                    cardBuffer,
                    {
                      folder: `sentryk/center_${centerId}/qrcodes`,
                      public_id: `card_${finalQrToken}`,
                      overwrite: true,
                    },
                  );
                  savedUrl = uploadResult.secure_url;
                  const shortUrl = await generateSentrykShortUrl(
                    savedUrl,
                    centerId,
                  );
                  savedUrl = shortUrl || savedUrl;

                  await prisma.student
                    .update({
                      where: { id: syncRecord.id },
                      data: { qrImageUrl: savedUrl },
                    })
                    .catch((e) =>
                      console.error("❌ Bulk Sync DB Update Error:", e.message),
                    );
                }
                await safeSendWhatsApp(syncRecord.id, "FIRST_SUB", {
                  qrImageUrl: savedUrl,
                });
              })
              .catch((err) =>
                console.error(
                  "❌ Bulk Sync Background Drawing Exception:",
                  err.message,
                ),
              );
          });

          syncSummary.succeeded.push({
            id: syncRecord.id,
            name: syncRecord.name,
            qrToken: finalQrToken,
          });
        } catch (singleError) {
          console.error(
            `⚠️ [Bulk Sync Single Failure]: تخطي ومعالجة الخطأ للطالب الفاشل:`,
            singleError.message,
          );
          syncSummary.failed.push({
            name: studentData?.name || "اسم غير متوفر",
            error: singleError.message,
          });
        }
      }

      console.log(
        `🏁 [Bulk Sync Complete Summary]: نجاح مزامنة [${syncSummary.succeeded.length}] طلاب، وفشل [${syncSummary.failed.length}]`,
      );
      return res.json({
        success: true,
        message: "تمت معالجة دفعة الطلاب ومزامنتها بنجاح نظامي",
        summary: syncSummary,
      });
    } catch (error) {
      console.error("❌ Bulk Sync Root Critical Error:", error);
      return res.status(500).json({
        error: "فشل إتمام معالجة الدفعة المجمعة كلياً بالسيرفر",
        details: error.message,
      });
    }
  },
);

// 2) جلب جميع الطلاب مع الفلترة المتقدمة والبحث والـ Pagination المشروط السريع
router.get(
  "/",
  authenticateToken,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    console.log(
      "🔍 [Route GET /]: بدء سحب قائمة الطلاب وتطبيق الفلاتر والبحث اللحظي المتقدم...",
    );
    try {
      const {
        page = 1,
        limit = 10,
        search,
        stage,
        grade,
        status,
        sessionId,
      } = req.query;
      const { centerId } = req.user;

      // حماية المدخلات الخاصة بالصفحات لضمان عدم تمرير قيم سالبة أو صفرية تسبب انهيار قاعدة البيانات
      const pageNum = Math.max(1, Number(page) || 1);
      const limitNum = Math.max(1, Number(limit) || 10);

      const where = { centerId: Number(centerId) };
      console.log(
        `⚙️ [Filter Query Engine]: بناء كائن الاستعلام للسنتر رقم [${centerId}]`,
      );

      // 1. فلتر البحث اللحظي المتقدم (الاسم، الهاتف، التوكن)
      if (search?.trim()) {
        where.OR = [
          { name: { contains: search.trim(), mode: "insensitive" } },
          { phone: { contains: search.trim() } },
          { qrToken: { contains: search.trim() } },
        ];
      }

      // 2. فلتر المرحلة الدراسية
      if (stage) {
        where.stage = normalizeStage(stage);
      }

      // 3. فلتر الصف الدراسي
      if (grade !== undefined && grade !== "") {
        where.grade = Number(grade);
      }

      // 4. الهندسة المتقاطعة لفلاتر المجموعات (sessionId) وحالة الاشتراك (status) منعاً للتضارب
      if (sessionId || status) {
        const now = new Date();

        if (status) {
          const targetStatus = String(status).toUpperCase();

          if (targetStatus === "ACTIVE") {
            // الطلاب الذين يمتلكون اشتراكاً نشطاً وساري الصلاحية تاريخياً
            where.subscriptions = {
              some: {
                status: "ACTIVE",
                endDate: { gte: now },
                ...(sessionId
                  ? { items: { some: { sessionId: Number(sessionId) } } }
                  : {}),
              },
            };
          } else if (targetStatus === "EXPIRED") {
            // الطلاب الذين انتهت اشتراكاتهم
            if (sessionId) {
              // إذا حدد مجموعة معينة: نريد الطلاب الذين اشتركوا في هذه المجموعة سابقاً ولكن ليس لديهم أي اشتراك نشط لها حالياً
              where.AND = [
                {
                  subscriptions: {
                    some: { items: { some: { sessionId: Number(sessionId) } } },
                  },
                },
                {
                  subscriptions: {
                    none: {
                      status: "ACTIVE",
                      endDate: { gte: now },
                      items: { some: { sessionId: Number(sessionId) } },
                    },
                  },
                },
              ];
            } else {
              // منتهي بشكل عام في السنتر: لا يملك أي باقة نشطة حالياً
              where.subscriptions = {
                none: {
                  status: "ACTIVE",
                  endDate: { gte: now },
                },
              };
            }
          }
        } else {
          // إذا تم اختيار المجموعة فقط بدون تحديد الحالة النشطة أو المنتهية
          where.subscriptions = {
            some: {
              items: {
                some: { sessionId: Number(sessionId) },
              },
            },
          };
        }
      }

      console.log(
        "⚙️ [Prisma Student Count & Query Where Clause]:",
        JSON.stringify(where),
      );

      // جلب الطلاب وعداد الإجمالي بالتوازي (Parallel Execution) لرفع الكفاءة الزمنية القصوى للاستجابة
      const [students, total] = await prisma.$transaction([
        prisma.student.findMany({
          where,
          include: {
            subscriptions: {
              include: {
                items: {
                  include: {
                    session: {
                      include: {
                        teacher: true,
                        room: true,
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: { name: "asc" },
          skip: (pageNum - 1) * limitNum,
          take: limitNum,
        }),
        prisma.student.count({ where }),
      ]);

      const nowCheck = new Date();

      // دالة الخرائط الهيكلية المعززة للبيانات (Inline Advanced Mapper)
      const formattedStudents = students.map((student) => {
        // حساب حالة الطالب الإجمالية الحالية في المركز بناءً على وجود أي باقة نشطة وسارية
        const hasActiveSubscription = student.subscriptions.some(
          (sub) => sub.status === "ACTIVE" && new Date(sub.endDate) >= nowCheck,
        );

        return {
          id: student.id,
          name: student.name,
          phone: student.phone,
          stage: student.stage,
          grade: student.grade,
          qrToken: student.qrToken,
          qrImageUrl: student.qrImageUrl,
          createdAt: student.createdAt,
          updatedAt: student.updatedAt,
          overallStatus: hasActiveSubscription ? "ACTIVE" : "EXPIRED",

          // تنظيف وتسطيح باقات الاشتراكات والمجموعات المرتبطة بالطالب لتسهيل قراءتها بالفرونت إند
          subscriptions: student.subscriptions.map((sub) => {
            const isSubValid =
              sub.status === "ACTIVE" && new Date(sub.endDate) >= nowCheck;

            // حساب رصيد الحصص المتبقية ذكياً للاشتراكات من نوع PER_SESSION
            let remainingSessions = null;
            if (
              sub.subscriptionType === "PER_SESSION" &&
              sub.totalSessions !== null
            ) {
              remainingSessions = Math.max(
                0,
                sub.totalSessions - sub.usedSessions,
              );
            }

            return {
              id: sub.id,
              subscriptionType: sub.subscriptionType,
              status: sub.status,
              isExpired: !isSubValid,
              totalPrice: sub.totalPrice,
              startDate: sub.startDate,
              endDate: sub.endDate,
              totalSessions: sub.totalSessions,
              usedSessions: sub.usedSessions,
              remainingSessions: remainingSessions,
              durationMonths: sub.durationMonths,
              sessions: sub.items.map((item) => ({
                id: item.session?.id,
                name: item.session?.name,
                startTime: item.session?.startTime,
                endTime: item.session?.endTime,
                days: item.session?.days,
                priceSnapshot: item.priceSnapshot,
                teacherName: item.session?.teacher?.name,
                subject: item.session?.teacher?.subject,
                roomName: item.session?.room?.name,
              })),
            };
          }),
        };
      });

      console.log(
        `✅ [Query Success]: تم استخراج [${students.length}] طالب من أصل إجمالي [${total}] سجل بقاعدة البيانات.`,
      );

      return res.json({
        success: true,
        pagination: {
          totalStudents: total,
          currentPage: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
        },
        data: formattedStudents,
      });
    } catch (error) {
      console.error("❌ Fetch Students Filter Error:", error);
      return res.status(500).json({
        error: "فشل جلب قائمة الطلاب المقيدين بالفلاتر الحالية كلياً",
        details: error.message,
      });
    }
  },
);

// 3) جلب بيانات طالب معين بالتفصيل عبر المعرف الفريد (Profile)
router.get(
  "/:id",
  authenticateToken,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    const studentId = Number(req.params.id);
    const { centerId } = req.user;

    // 1. صمام الأمان الأول: التحقق الصارم من نوع المعرف لحماية السيرفر وقاعدة البيانات من قيم خبيثة أو عشوائية
    if (isNaN(studentId) || studentId <= 0) {
      console.warn(
        `⚠️ [Profile Bad Request]: محاولة تمرير معرف طالب غير صالح أو تالف: [${req.params.id}]`,
      );
      return res.status(400).json({
        error:
          "فشل معالجة الطلب: معرف الطالب يجب أن يكون رقماً صحيحاً موجباً كلياً.",
      });
    }

    console.log(
      `👤 [Route GET /:id]: طلب استدعاء لملف الطالب بالمعرف: [${studentId}] للسنتر الحركي: [${centerId}]`,
    );

    try {
      // 2. الاستعلام المدمج والأمن متعدد السنتر الحركي (Scoped Multi-Tenant DB Query)
      const student = await prisma.student.findFirst({
        where: {
          id: studentId,
          centerId: Number(centerId), // التحقق المباشر يضمن عدم قراءة أي سجل لا يخص السنتر الحالي نهائياً
        },
        include: {
          subscriptions: {
            include: {
              items: {
                include: {
                  session: {
                    include: {
                      teacher: true,
                      room: true,
                    },
                  },
                },
              },
            },
            orderBy: { createdAt: "desc" }, // ترتيب الاشتراكات من الأحدث للأقدم لتسهيل قراءتها داخل بروفايل الطالب
          },
        },
      });

      // 3. التحقق الصارم من وجود السجل وأمن الموارد
      if (!student) {
        console.warn(
          `⚠️ [Profile Mismatch/Not Found]: السجل بالمعرف [${studentId}] غير موجود أو لا يتبع السنتر رقم [${centerId}]`,
        );
        return res.status(404).json({
          error: "عذراً، الطالب المطلوب غير موجود بسجلات هذا المركز التعليمي",
        });
      }

      const nowCheck = new Date();

      // 4. المحرك الهيكلي المتقدم لتسطيح بيانات ملف الطالب (Advanced Profile Structural Mapper)
      const hasActiveSubscription = student.subscriptions.some(
        (sub) => sub.status === "ACTIVE" && new Date(sub.endDate) >= nowCheck,
      );

      const formattedStudentProfile = {
        id: student.id,
        name: student.name,
        phone: student.phone,
        stage: student.stage,
        grade: student.grade,
        qrToken: student.qrToken,
        qrImageUrl: student.qrImageUrl,
        createdAt: student.createdAt,
        updatedAt: student.updatedAt,
        overallStatus: hasActiveSubscription ? "ACTIVE" : "EXPIRED", // الحالة العامة للطالب بالسنتر حالياً

        // تسوية وهندسة باقات الاشتراكات والمجموعات المرتبطة بها
        subscriptions: student.subscriptions.map((sub) => {
          const isSubValid =
            sub.status === "ACTIVE" && new Date(sub.endDate) >= nowCheck;

          // احتساب هندسي فائق لعداد رصيد الحصص المتبقية والمشحونة للطالب بنمط باقة الحصص (PER_SESSION)
          let remainingSessions = null;
          if (
            sub.subscriptionType === "PER_SESSION" &&
            sub.totalSessions !== null
          ) {
            remainingSessions = Math.max(
              0,
              sub.totalSessions - sub.usedSessions,
            );
          }

          return {
            id: sub.id,
            subscriptionType: sub.subscriptionType,
            status: sub.status,
            isExpired: !isSubValid,
            totalPrice: sub.totalPrice,
            startDate: sub.startDate,
            endDate: sub.endDate,
            totalSessions: sub.totalSessions,
            usedSessions: sub.usedSessions,
            remainingSessions: remainingSessions, // يُرسل مباشرة للفرونت إند لعرض العدادات
            durationMonths: sub.durationMonths,
            createdAt: sub.createdAt,
            // تفكيك وتسطيح المجموعات والمدرسين والشهادات السعرية لتلك الباقة
            sessions: sub.items.map((item) => ({
              id: item.session?.id,
              name: item.session?.name,
              startTime: item.session?.startTime,
              endTime: item.session?.endTime,
              days: item.session?.days,
              priceSnapshot: item.priceSnapshot, // السعر وقت الاشتراك الفعلي
              teacherName: item.session?.teacher?.name,
              subject: item.session?.teacher?.subject,
              roomName: item.session?.room?.name,
            })),
          };
        }),
      };

      console.log(
        `✅ [Profile Success]: تم جلب وتصدير كائن الطالب [${student.name}] للملف التعريفي بنجاح معمارى كامل.`,
      );

      return res.json({
        success: true,
        data: formattedStudentProfile,
      });
    } catch (error) {
      console.error(
        `❌ Fetch Student Profile Critical Error for ID ${studentId}:`,
        error,
      );
      return res.status(500).json({
        error: "فشل إتمام جلب ملف بيانات الطالب التفصيلي من السيرفر كلياً",
        details: error.message,
      });
    }
  },
);

// 4) تحديث بيانات الطالب الحالية (ملف التعريف)
router.put(
  "/:id",
  authenticateToken,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    const studentId = Number(req.params.id);
    const { centerId, userId } = req.user;
    const { name, phone, stage, grade } = req.body;

    // 1. صمام الأمان الأول: التحقق الصارم من سلامة المعرف الرقمي
    if (isNaN(studentId) || studentId <= 0) {
      console.warn(
        `⚠️ [Update Bad Request]: محاولة تمرير معرف طالب تالف أو غير صالح: [${req.params.id}]`,
      );
      return res.status(400).json({
        error: "فشل معالجة الطلب: يجب أن يكون معرف الطالب رقماً صحيحاً موجباً.",
      });
    }

    console.log(
      `📝 [Route PUT /:id]: استقبال طلب تعديل وتحرير بيانات الطالب رقم: [${studentId}] من المستخدم: [${userId}] في السنتر: [${centerId}]`,
    );

    try {
      // 2. التحقق المدمج والآمن على مستوى قاعدة البيانات لضمان التبعية للسنتر الحالي (Multi-Tenant Scope Check)
      const existingStudent = await prisma.student.findFirst({
        where: {
          id: studentId,
          centerId: Number(centerId),
        },
      });

      if (!existingStudent) {
        console.warn(
          `⚠️ [Update Bypass Alert]: محاولة تعديل طالب غير موجود أو ينتمي لمركز آخر من الحساب رقم [${userId}]`,
        );
        return res.status(404).json({
          error:
            "عذراً، الطالب غير موجود بسجلات هذا المركز التعليمي لإتمام التعديل",
        });
      }

      // 3. بناء وتنظيف كائن التحديث ديناميكياً مع التحقق الصارم من المدخلات (Data Sanitization & Validation)
      const updateData = {};

      if (name !== undefined) {
        if (!name.trim()) {
          return res
            .status(400)
            .json({
              error:
                "فشل التحديث: اسم الطالب لا يمكن أن يكون فارغاً أو يحتوي على مسافات فقط.",
            });
        }
        updateData.name = name.trim();
      }

      if (phone !== undefined) {
        if (!phone.trim()) {
          return res
            .status(400)
            .json({
              error: "فشل التحديث: رقم هاتف الطالب لا يمكن أن يكون فارغاً.",
            });
        }
        updateData.phone = phone.trim();
      }

      if (stage) {
        updateData.stage = normalizeStage(stage);
      }

      if (grade !== undefined && grade !== "") {
        updateData.grade = Number(grade);
      }

      // إذا لم يتم إرسال أي حقول فعلية للتعديل، يتم إنهاء الطلب فوراً لتوفير موارد السيرفر
      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({
          error: "لم يتم إرسال أي بيانات جديدة صالحة لتعديلها.",
        });
      }

      console.log(
        "⚙️ [Student Update Data Payload]:",
        JSON.stringify(updateData),
      );

      // 4. تنفيذ التحديث والتوثيق الذري داخل معاملة واحدة معزولة (Atomic Transaction Execution)
      const updatedStudent = await prisma.$transaction(async (tx) => {
        // تحديث بيانات الطالب وجلب علاقات الاشتراكات والمجموعات مباشرة
        const student = await tx.student.update({
          where: { id: studentId },
          data: updateData,
          include: {
            subscriptions: {
              include: {
                items: {
                  include: {
                    session: {
                      include: {
                        teacher: true,
                        room: true,
                      },
                    },
                  },
                },
              },
              orderBy: { createdAt: "desc" }, // جلب الاشتراكات مرتبة تصاعدياً من الأحدث للأقدم
            },
          },
        });

        // توثيق عملية التحديث بدقة داخل سجل النشاطات الخاص بالسنتر
        await tx.activityLog.create({
          data: {
            centerId: Number(centerId),
            userId: Number(userId),
            action: "UPDATE_STUDENT",
            targetType: "Student",
            targetId: studentId,
            details: JSON.stringify({
              updatedFields: Object.keys(updateData),
              changes: {
                before: {
                  name: existingStudent.name,
                  phone: existingStudent.phone,
                  stage: existingStudent.stage,
                  grade: existingStudent.grade,
                },
                after: updateData,
              },
            }),
          },
        });

        return student;
      });

      const nowCheck = new Date();

      // 5. المحرك الهيكلي المتقدم لتسطيح البيانات بعد التعديل (Inline Advanced Profile Structural Mapper)
      const hasActiveSubscription = updatedStudent.subscriptions.some(
        (sub) => sub.status === "ACTIVE" && new Date(sub.endDate) >= nowCheck,
      );

      const formattedStudentProfile = {
        id: updatedStudent.id,
        name: updatedStudent.name,
        phone: updatedStudent.phone,
        stage: updatedStudent.stage,
        grade: updatedStudent.grade,
        qrToken: updatedStudent.qrToken,
        qrImageUrl: updatedStudent.qrImageUrl,
        createdAt: updatedStudent.createdAt,
        updatedAt: updatedStudent.updatedAt,
        overallStatus: hasActiveSubscription ? "ACTIVE" : "EXPIRED",

        // تسوية وهندسة باقات الاشتراكات وحساب عدادات الحصص بدقة متناهية
        subscriptions: updatedStudent.subscriptions.map((sub) => {
          const isSubValid =
            sub.status === "ACTIVE" && new Date(sub.endDate) >= nowCheck;

          let remainingSessions = null;
          if (
            sub.subscriptionType === "PER_SESSION" &&
            sub.totalSessions !== null
          ) {
            remainingSessions = Math.max(
              0,
              sub.totalSessions - sub.usedSessions,
            );
          }

          return {
            id: sub.id,
            subscriptionType: sub.subscriptionType,
            status: sub.status,
            isExpired: !isSubValid,
            totalPrice: sub.totalPrice,
            startDate: sub.startDate,
            endDate: sub.endDate,
            totalSessions: sub.totalSessions,
            usedSessions: sub.usedSessions,
            remainingSessions: remainingSessions, // العداد المحدث للحصص المتبقية
            durationMonths: sub.durationMonths,
            createdAt: sub.createdAt,
            sessions: sub.items.map((item) => ({
              id: item.session?.id,
              name: item.session?.name,
              startTime: item.session?.startTime,
              endTime: item.session?.endTime,
              days: item.session?.days,
              priceSnapshot: item.priceSnapshot,
              teacherName: item.session?.teacher?.name,
              subject: item.session?.teacher?.subject,
              roomName: item.session?.room?.name,
            })),
          };
        }),
      };

      console.log(
        `✅ [Update Student Success]: تم حفظ التعديلات وتوثيق النشاط بنجاح نظامي لطالب ID: [${studentId}]`,
      );

      return res.json({
        success: true,
        message: "تم تحديث بيانات ملف الطالب وتوثيقها بنجاح معماري تام",
        data: formattedStudentProfile,
      });
    } catch (error) {
      console.error(
        `❌ Update Student Critical Error for ID ${studentId}:`,
        error,
      );
      return res.status(500).json({
        error: "فشل تحديث وحفظ بيانات الطالب الجديدة بالسيرفر كلياً",
        details: error.message,
      });
    }
  },
);

// 5) حذف الطالب نهائياً وتنظيف كل العلاقات المتشابكة مع السكيما (Cascading Clean Transaction)
router.delete(
  "/:id",
  authenticateToken,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  async (req, res) => {
    const studentId = Number(req.params.id);
    const { centerId, userId } = req.user;

    // 1. صمام الأمان الأول: التحقق الصارم من سلامة المعرف الرقمي لحماية موارد السيرفر
    if (isNaN(studentId) || studentId <= 0) {
      console.warn(
        `⚠️ [Delete Bad Request]: محاولة تمرير معرف طالب غير صالح للحذف: [${req.params.id}]`,
      );
      return res.status(400).json({
        error:
          "فشل معالجة الطلب: يجب أن يكون معرف الطالب رقماً صحيحاً موجباً كلياً.",
      });
    }

    console.log(
      `🧨 [Route DELETE /:id]: بدء عملية إقصاء وتطهير شامل للطالب ID: [${studentId}] من المستخدم المسؤول: [${userId}]`,
    );

    try {
      // 2. التحقق الآمن والمدمج لضمان التبعية والملكية للسنتر الحالي (Scoped Multi-Tenant Protection)
      const existingStudent = await prisma.student.findFirst({
        where: {
          id: studentId,
          centerId: Number(centerId), // حماية البيانات: يمنع الحذف عبر مراكز الإدارة المختلفة نهائياً
        },
      });

      if (!existingStudent) {
        console.warn(
          `⚠️ [Delete Bypass Alert]: محاولة تدمير سجل طالب غير موجود أو ينتمي لمركز آخر من الحساب رقم [${userId}]`,
        );
        return res.status(404).json({
          error:
            "عذراً، الطالب غير موجود بسجلات هذا المركز التعليمي لإتمام عملية الحذف.",
        });
      }

      // 3. تنفيذ الحذف الذري الشامل والتوثيق الأمني داخل معاملة واحدة (Atomic Transaction)
      // الاستفادة من محرك الـ DB Cascading لضمان سرعة فائقة جداً وعدم حدوث تجميد للاستعلامات
      await prisma.$transaction(async (tx) => {
        console.log(
          `🧹 [Transaction Delete]: جاري حذف السجل الجذري للطالب [${existingStudent.name}]. تتولى قاعدة البيانات تدمير التوابع ميكانيكياً...`,
        );

        // سطر واحد يمسح الطالب، وتلقائياً تقوم قاعدة البيانات بمسح الحضور، والاشتراكات، والتقارير بأعلى كفاءة
        await tx.student.delete({
          where: { id: studentId },
        });

        console.log(
          "📝 [Transaction Delete]: جاري توثيق عملية التدمير الجذري في السجل الأمني لعمليات السنتر (Audit Trail)...",
        );
        await tx.activityLog.create({
          data: {
            centerId: Number(centerId),
            userId: Number(userId),
            action: "DELETE_STUDENT",
            targetType: "Student",
            targetId: studentId,
            details: JSON.stringify({
              deletedStudentName: existingStudent.name,
              deletedStudentPhone: existingStudent.phone,
              stage: existingStudent.stage,
              grade: existingStudent.grade,
              executedByUserId: userId,
              securityLevel: "PERMANENT_CASCADE_DELETE",
            }),
          },
        });
      });

      console.log(
        `✅ [Delete Student Success]: تم تطهير وحذف الطالب رقم [${studentId}] ومتعلقاته بنجاح فائق عبر الـ Database Cascading Engine.`,
      );

      return res.json({
        success: true,
        message:
          "تم إقصاء وحذف الطالب بالكامل مع سجلاته التاريخية والمالية بنجاح معماري تام 🧨",
      });
    } catch (error) {
      console.error(
        `❌ Delete Student Critical Error for ID ${studentId}:`,
        error,
      );
      return res.status(500).json({
        error:
          "فشل إتمام عملية حذف الطالب نظراً لوجود قيود نظام معقدة بالخادم كلياً",
        details: error.message,
      });
    }
  },
);

module.exports = router;
