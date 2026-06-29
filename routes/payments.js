const express = require("express");
const { PrismaClient, PaymentStatus, BillingCycle } = require("@prisma/client");
const crypto = require("crypto");
const axios = require("axios");

const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
} = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();
const PRICE_PER_MESSAGE =
  parseFloat(process.env.CHARGE_WHATSAPP_PRICE_PER_MESSAGE) || 0.4;

// ===========================================================================
// الإعدادات والثوابت التشغيلية للمنصة (تحديثات هندسية لعام 2026)
// ===========================================================================
const ADMIN_MOCK_EMAIL = process.env.ADMIN_MOCK_EMAIL || "ymslm120@gmail.com";
const ADMIN_MOCK_PASSWORD = process.env.ADMIN_MOCK_PASSWORD || "Youssef2011";
const WHATSAPP_PRICE = Number.parseFloat(
  process.env.CHARGE_WHATSAPP_PRICE_PER_MESSAGE || "0.40",
);
const DEBUG_PAYMENTS = process.env.DEBUG_PAYMENTS !== "false";

const PLAN_TIER_LIMITS = {
  TRIAL: { maxStudents: 100, maxUsers: 3, defaultPrice: 0 },
  BASIC: { maxStudents: 250, maxUsers: 4, defaultPrice: 499 },
  PREMIUM: { maxStudents: 1000, maxUsers: 10, defaultPrice: 999 },
  ELITE: { maxStudents: 3000000, maxUsers: 25000, defaultPrice: 1499 },
};

// دالة التسجيل الذكية لتتبع العمليات بدقة عالية جداً وتحليل موجات الدفع
function logEngine(level, stage, message, context = {}) {
  if (DEBUG_PAYMENTS) {
    const timestamp = new Date().toISOString();
    console.log(
      `[${timestamp}] [${level}] [⚙️ PAYMENTS-ENGINE] [${stage}] -> ${message}`,
      Object.keys(context).length ? JSON.stringify(context, null, 2) : "",
    );
  }
}

// ===========================================================================
// أدوات المساعدة والتحقق والتطهير البرمجي (Helpers & Sanitizers)
// ===========================================================================
function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().toUpperCase();
}

function toSafeInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function isValidPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

function safeJsonMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === "object") return metadata;
  if (typeof metadata === "string") {
    try {
      return JSON.parse(metadata);
    } catch {
      return {};
    }
  }
  return {};
}

function calculateEndDate(currentEndDate, cycle) {
  const normalizedCycle = normalizeText(cycle);
  const baseDate =
    currentEndDate && new Date(currentEndDate) > new Date()
      ? new Date(currentEndDate)
      : new Date();
  const date = new Date(baseDate);

  if (normalizedCycle === "YEARLY") {
    date.setFullYear(date.getFullYear() + 1);
    return date;
  }
  if (normalizedCycle === "TRIAL") {
    date.setDate(date.getDate() + 14);
    return date;
  }
  date.setDate(date.getDate() + 30);
  return date;
}

function buildTransactionId(prefix = "TX") {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

/**
 * دالة البحث المطورة والذكية فائق السرعة لتفادي حالات الـ Deadlocks والبطء في الرد.
 * تم تعديل الأولويات هنا لترتكز على معرّفات Paymob المباشرة بناءً على تحديثات الـ Unified Checkout (2026).
 */
/**
 * دالة البحث المطورة والذكية فائق السرعة لتفادي حالات الـ Deadlocks والبطء في الرد.
 * تم تعديل الأولويات هنا لترتكز على معرّفات Paymob المباشرة بناءً على تحديثات الـ Unified Checkout (2026).
 */
/**
 * دالة البحث المطورة والذكية فائقة السرعة لمنع الـ Fallback العشوائي والـ Deadlocks.
 * تم إعادة ترتيب الأولويات بشكل صارم لتبدأ بالمعرفات الخارجية لـ Paymob (معاملات، نوايا دفع، مراجع)
 * قبل الانتقال إلى المعرفات الداخلية، وذلك لضمان العثور على الفاتورة الأصلية فوراً فور وصول الـ Webhook.
 */
async function optimizeFindPayment(identifier) {
  if (!identifier) return null;
  const strId = String(identifier).trim();

  // تصفية القيم النصية المشوهة التي قد تمررها بوابة الدفع بالخطأ
  if (strId === "" || strId === "null" || strId === "undefined") {
    return null;
  }

  logEngine(
    "INFO",
    "DB_LOOKUP",
    `بدء البحث المتقدم عن الفاتورة بالمعرّف الممرر: ${strId}`,
  );

  // -------------------------------------------------------------------------
  // 1. الأولوية الأولى: البحث الفوري باستخدام PayMob Transaction ID (المخزن بـ transactionId)
  // -------------------------------------------------------------------------
  const paymentByTxnId = await prisma.payment.findUnique({
    where: { transactionId: strId },
    include: { promoCode: true, center: true },
  });
  if (paymentByTxnId) {
    logEngine(
      "SUCCESS",
      "DB_LOOKUP",
      `[المسار 1] تم العثور بنجاح عبر حساب transactionId (PayMob ID): ${strId} -> ID داخلي: ${paymentByTxnId.id}`,
    );
    return paymentByTxnId;
  }

  // -------------------------------------------------------------------------
  // 2. الأولوية الثانية: البحث الفريد باستخدام paymobIntentionId المباشر (معرف نية الدفع)
  // -------------------------------------------------------------------------
  const paymentByIntention = await prisma.payment.findUnique({
    where: { paymobIntentionId: strId },
    include: { promoCode: true, center: true },
  });
  if (paymentByIntention) {
    logEngine(
      "SUCCESS",
      "DB_LOOKUP",
      `[المسار 2] تم العثور على الفاتورة عبر حساب paymobIntentionId المباشر والفريد: ID ${paymentByIntention.id}`,
    );
    return paymentByIntention;
  }

  // -------------------------------------------------------------------------
  // 3. الأولوية الثالثة: البحث السريع بالـ merchantReference المفهرس
  // -------------------------------------------------------------------------
  const paymentByRef = await prisma.payment.findFirst({
    where: { merchantReference: strId },
    include: { promoCode: true, center: true },
  });
  if (paymentByRef) {
    logEngine(
      "SUCCESS",
      "DB_LOOKUP",
      `[المسار 3] تم العثور على الفاتورة عبر مرجع التاجر المفهرس merchantReference: ID ${paymentByRef.id}`,
    );
    return paymentByRef;
  }

  // -------------------------------------------------------------------------
  // 4. الأولوية الرابعة: البحث بالـ ID الرقمي الداخلي لنظام المنصة (إذا كان رقماً خالصاً مكوّناً من أقل من 7 خانات)
  // -------------------------------------------------------------------------
  if (/^\d+$/.test(strId) && strId.length < 7) {
    const numId = parseInt(strId, 10);
    const payment = await prisma.payment.findUnique({
      where: { id: numId },
      include: { promoCode: true, center: true },
    });
    if (payment) {
      logEngine(
        "SUCCESS",
        "DB_LOOKUP",
        `[المسار 4] تم العثور على الفاتورة عبر المعرّف الرقمي الداخلي ID: ${payment.id}`,
      );
      return payment;
    }
  }

  // -------------------------------------------------------------------------
  // 5. الأولوية الخامسة: بحث عميق داخل الـ JSON metadata عن paymobIntentionId (مهم جداً لمنع الـ Fallback)
  // -------------------------------------------------------------------------
  const paymentByIntentionMeta = await prisma.payment.findFirst({
    where: {
      metadata: {
        path: ["paymobIntentionId"],
        equals: strId,
      },
    },
    include: { promoCode: true, center: true },
  });
  if (paymentByIntentionMeta) {
    logEngine(
      "SUCCESS",
      "DB_LOOKUP",
      `[المسار 5] تم العثور عبر paymobIntentionId داخل الـ metadata العميق: ID ${paymentByIntentionMeta.id}`,
    );
    return paymentByIntentionMeta;
  }

  // -------------------------------------------------------------------------
  // 6. مسار إنقاذي إضافي: بحث تراجع عميق داخل الـ JSON metadata عن paymobOrderId لضمان عدم ضياع أي معاملة
  // -------------------------------------------------------------------------
  const paymentByMetaOrder = await prisma.payment.findFirst({
    where: {
      metadata: {
        path: ["paymobOrderId"],
        equals: strId,
      },
    },
    include: { promoCode: true, center: true },
  });
  if (paymentByMetaOrder) {
    logEngine(
      "SUCCESS",
      "DB_LOOKUP",
      `[المسار 6] تم العثور على الفاتورة عبر البحث العميق بـ paymobOrderId داخل الـ metadata: ID ${paymentByMetaOrder.id}`,
    );
    return paymentByMetaOrder;
  }

  logEngine(
    "WARN",
    "DB_LOOKUP",
    `فشلت جميع مسارات البحث الذكية والعميقة في العثور على سجل للفاتورة للمعرّف: ${strId}`,
  );
  return null;
}

// ===========================================================================
// LAYER: طبقة الخدمات الموحدة لإدارة منطق معالجة عمليات الدفع (PaymentService)
// ===========================================================================
const PaymentService = {
  // دالة التحقق من التوقيع الرقمي الخارجي (HMAC) لبوابة Paymob لمنع الاختراقات والتلاعب بالطلبات الواردة
  verifyPaymobHmac: (txn, hmacQuery) => {
    try {
      if (!process.env.PAYMOB_HMAC_SECRET) {
        logEngine(
          "WARN",
          "HMAC_VERIFICATION",
          "تنبيه أمني: PAYMOB_HMAC_SECRET غير معرّف بملف البيئة، سيتم تخطي الفحص لأغراض التطوير المحلي فقط.",
        );
        return true;
      }
      if (!hmacQuery) return false;

      const hmacKeys = [
        txn.amount_cents,
        txn.created_at,
        txn.currency,
        txn.error_occured,
        txn.has_parent_transaction,
        txn.id,
        txn.integration_id,
        txn.is_3d_secure,
        txn.is_auth,
        txn.is_capture,
        txn.is_refunded,
        txn.is_standalone_payment,
        txn.is_voided,
        typeof txn.order === "object" ? txn.order?.id : txn.order,
        txn.owner,
        txn.pending,
        txn.source_data?.pan || "",
        txn.source_data?.sub_type || "",
        txn.source_data?.type || "",
        txn.success,
      ];

      const concatenatedString = hmacKeys
        .map((val) => (val === undefined || val === null ? "" : String(val)))
        .join("");

      const calculatedHmac = crypto
        .createHmac("sha512", process.env.PAYMOB_HMAC_SECRET)
        .update(concatenatedString)
        .digest("hex");

      const isValid = calculatedHmac === hmacQuery;
      logEngine(
        isValid ? "SUCCESS" : "ERROR",
        "HMAC_VERIFICATION",
        `نتيجة فحص HMAC الرقمي: ${isValid ? "صحيح وتطابق تام وآمن للبيانات" : "فشل فادح: عدم تطابق التوقيع الرقمي!"}`,
      );
      return isValid;
    } catch (err) {
      logEngine(
        "ERROR",
        "HMAC_VERIFICATION_EXCEPTION",
        `خطأ برمي أثناء احتساب التوقيع الحسابي: ${err.message}`,
      );
      return false;
    }
  },

  // دالة المعالجة الذرية الموحدة لنجاح السداد المالي وحقن الصلاحيات والمميزات بالسنتر (Single Source of Truth)
  processSuccessfulPayment: async (paymentId, paymobTxnId) => {
    const traceId = buildTransactionId("SRV");

    logEngine(
      "INFO",
      "PROCESS_SUCCESSFUL_PAYMENT_START",
      `[Trace: ${traceId}] بدء تطبيق المعالجة الذرية الصارمة لتفعيل الاشتراك للفاتورة ID: ${paymentId} - معاملة رقم: ${paymobTxnId}`,
    );

    try {
      return await prisma.$transaction(async (tx) => {
        // 1️⃣ جلب الفاتورة مع العلاقات كاملة لضمان عدم وجود بيانات ناقصة (Center & PromoCode)
        logEngine(
          "INFO",
          "FETCHING_LIVE_PAYMENT",
          `[Trace: ${traceId}] جلب الفاتورة الحية من قاعدة البيانات وقفل السجل ماليًا`,
        );

        const livePayment = await tx.payment.findUnique({
          where: { id: paymentId },
          include: { center: true, promoCode: true },
        });

        if (!livePayment) {
          logEngine(
            "ERROR",
            "PAYMENT_RECORD_NOT_FOUND",
            `[Trace: ${traceId}] لم يتم العثور على المعاملة رقم ${paymentId} بالمخزن البنكي المالي للسنتر`,
          );
          throw new Error(
            `PAYMENT_RECORD_NOT_FOUND: لم يتم العثور على المعاملة رقم ${paymentId}`,
          );
        }

        logEngine(
          "INFO",
          "PAYMENT_DATA_DUMP",
          `[Trace: ${traceId}] تم العثور على الفاتورة: السنتر=${livePayment.centerId}, الباقة=${livePayment.plan}, المبلغ=${livePayment.amount}, الحالة الحالية=${livePayment.status}`,
        );

        // 2️⃣ آلية الحماية التكرارية القصوى (Idempotency Check)
        if (livePayment.status === PaymentStatus.SUCCESS) {
          logEngine(
            "WARN",
            "IDEMPOTENCY_SAFETY",
            `[Trace: ${traceId}] تنبيه الحماية التكرارية: الفاتورة ID ${paymentId} تمت معالجتها سابقاً بنجاح. كسر الدورة للحفاظ على سلامة البيانات.`,
          );
          return livePayment;
        }

        if (
          livePayment.status === PaymentStatus.FAILED &&
          !safeJsonMetadata(livePayment.metadata).createdByWebhookFallback
        ) {
          logEngine(
            "WARN",
            "IDEMPOTENCY_SAFETY",
            `[Trace: ${traceId}] تنبيه خرق الدورة: الفاتورة ID ${paymentId} مسجلة كفاشلة نهائيًا، لا يمكن إعادة تفعيلها.`,
          );
          return livePayment;
        }

        // 3️⃣ استخراج البيانات الوصفية والتحقق من نوع المشحن
        const metadata = safeJsonMetadata(livePayment.metadata);
        const planName = normalizeText(livePayment.plan);
        const isWhatsappCharge =
          planName === "WHATSAPP" ||
          normalizeText(metadata.requestedType) === "WHATSAPP";

        logEngine(
          "INFO",
          "METADATA_PARSED",
          `[Trace: ${traceId}] تم تحليل الـ Metadata بنجاح: ${JSON.stringify(metadata)}`,
        );

        // 4️⃣ استهلاك الأكواد الترويجية وتحديث العدادات الكلية
        if (
          livePayment.promoCodeId &&
          !metadata.isExistingPromoAutoApplied &&
          !metadata.isPromoPausedEnforced
        ) {
          logEngine(
            "INFO",
            "PROMO_CONSUMPTION_START",
            `[Trace: ${traceId}] جاري استهلاك كود الخصم المرجعي ID: ${livePayment.promoCodeId}`,
          );
          await tx.promoCode.update({
            where: { id: livePayment.promoCodeId },
            data: { usedCount: { increment: 1 } },
          });
          logEngine(
            "SUCCESS",
            "PROMO_CONSUMPTION_DONE",
            `[Trace: ${traceId}] تم زيادة عداد استخدام كود الخصم المرجعي.`,
          );
        }

        // 5️⃣ استهلاك رصيد الأشهر المجانية المستحقة للسنتر (Referral System) إن وجدت
        if (metadata.freeMonthsConsumed && metadata.freeMonthsConsumed > 0) {
          logEngine(
            "INFO",
            "FREE_MONTHS_CONSUMPTION_START",
            `[Trace: ${traceId}] جاري خصم ${metadata.freeMonthsConsumed} شهر مجاني من رصيد السنتر الداعي`,
          );
          await tx.center.update({
            where: { id: livePayment.centerId },
            data: {
              pendingFreeMonths: {
                decrement: metadata.freeMonthsConsumed,
              },
            },
          });
          logEngine(
            "SUCCESS",
            "FREE_MONTHS_CONSUMPTION_DONE",
            `[Trace: ${traceId}] تم تحديث خانة الأشهر المجانية بنجاح.`,
          );
        }

        let targetSubscriptionId = livePayment.centerSubscriptionId;

        // 🟢 [المسار أ]: شحن تفعيل محفظة رسائل الواتساب
        if (isWhatsappCharge) {
          logEngine(
            "INFO",
            "ROUTE_BRANCH_WHATSAPP",
            `[Trace: ${traceId}] توجيه المسار إلى: شحن رصيد محفظة الواتساب`,
          );

          let messageCount = toSafeInt(metadata.whatsappCount, 0);
          if (
            messageCount <= 0 &&
            livePayment.amount > 0 &&
            WHATSAPP_PRICE > 0
          ) {
            messageCount = Math.max(
              1,
              Math.round(livePayment.amount / WHATSAPP_PRICE),
            );
          }

          logEngine(
            "INFO",
            "WHATSAPP_CALCULATION",
            `[Trace: ${traceId}] مقدار الرسائل المحتسب للشحن: ${messageCount} رسالة للسنتر ID: ${livePayment.centerId}`,
          );

          const wallet = await tx.whatsAppWallet.upsert({
            where: { centerId: livePayment.centerId },
            update: { balance: { increment: messageCount } },
            create: { centerId: livePayment.centerId, balance: messageCount },
          });

          await tx.whatsAppTransaction.create({
            data: {
              walletId: wallet.id,
              amount: messageCount,
              type: "CHARGE",
              paymentId: livePayment.id,
              description: `شحن تلقائي ذكي ومعتمد بمقدار ${messageCount} رسالة عبر الويب هوك`,
            },
          });

          // حماية مضافة لتحديث الحقل المباشر للمحفظة مع معالجة آمنة للأنواع (Type Casting) لضمان عدم حدوث Crash بالـ Schema
          try {
            await tx.whatsAppWallet.upsert({
              where: { centerId: Number(livePayment.centerId) },
              update: { balance: { increment: Number(messageCount) } },
              create: {
                centerId: Number(livePayment.centerId),
                balance: Number(messageCount),
              },
            });
            logEngine(
              "SUCCESS",
              "WHATSAPP_WALLET_UPSERT_SECONDARY",
              `[Trace: ${traceId}] تم التأكيد الإضافي على محفظة الواتساب بنجاح.`,
            );
          } catch (walletErr) {
            logEngine(
              "WARN",
              "WHATSAPP_WALLET_SECONDARY_FAILED",
              `[Trace: ${traceId}] تحديث المحفظة الثانوي لم يكتمل (قد لا يكون مطلوبًا في الـ Schema الحالية): ${walletErr.message}`,
            );
          }
        } else {
          // 🔵 [المسار ب]: تمديد وتحديث باقات الـ SaaS القياسية وحقن الصلاحيات
          logEngine(
            "INFO",
            "ROUTE_BRANCH_SAAS",
            `[Trace: ${traceId}] توجيه المسار إلى: تفعيل باقة SaaS قياسية السنتر`,
          );

          const tierLimits =
            PLAN_TIER_LIMITS[planName] || PLAN_TIER_LIMITS.BASIC;
          logEngine(
            "INFO",
            "TIER_LIMITS_LOADED",
            `[Trace: ${traceId}] حدود الباقة المستهدفة (${planName}): ${JSON.stringify(tierLimits)}`,
          );

          const activeSub = await tx.centerSubscription.findFirst({
            where: { centerId: livePayment.centerId, isActive: true },
            orderBy: { endDate: "desc" },
          });

          const currentCycle =
            livePayment.billingCycle || metadata.billingCycle || "MONTHLY";
          const calculatedExpiry = calculateEndDate(
            activeSub?.endDate,
            currentCycle,
          );

          logEngine(
            "INFO",
            "SUBSCRIPTION_MUTATION_PREPARE",
            `[Trace: ${traceId}] الاشتراك الحالي ينتهي في: ${activeSub?.endDate || "لا يوجد اشتراك نشط"} | تاريخ انتهاء الصلاحية الجديد المحتسب: ${calculatedExpiry.toISOString()}`,
          );

          if (activeSub) {
            const updatedSub = await tx.centerSubscription.update({
              where: { id: activeSub.id },
              data: { endDate: calculatedExpiry, isActive: true },
            });
            targetSubscriptionId = updatedSub.id;
            logEngine(
              "SUCCESS",
              "SUBSCRIPTION_UPDATED",
              `[Trace: ${traceId}] تم تمديد سجل الاشتراك الحالي بنجاح. ID: ${targetSubscriptionId}`,
            );
          } else {
            const createdSub = await tx.centerSubscription.create({
              data: {
                centerId: livePayment.centerId,
                startDate: new Date(),
                endDate: calculatedExpiry,
                isActive: true,
              },
            });
            targetSubscriptionId = createdSub.id;
            logEngine(
              "SUCCESS",
              "SUBSCRIPTION_CREATED",
              `[Trace: ${traceId}] تم إنشاء سجل اشتراك جديد كليًا بنجاح. ID: ${targetSubscriptionId}`,
            );
          }

          // 🚨 === التحديث الحرج والأساسي للسنتر مع عمليات الحسابات الرياضية الآمنة لمنع الـ Overwrite ===
          logEngine(
            "INFO",
            "CENTER_CORE_UPDATE_START",
            `[Trace: ${traceId}] جاري تحديث بيانات جدول الـ Center بالصلاحيات والحدود الجديدة...`,
          );

          // حساب الأشهر المجانية المتبقية بشكل رياضي دقيق وآمن منعاً للـ Race Conditions
          const currentPendingFreeMonths =
            livePayment.center?.pendingFreeMonths || 0;
          const consumedFreeMonths = metadata.freeMonthsConsumed || 0;
          const finalPendingFreeMonths = Math.max(
            0,
            currentPendingFreeMonths - consumedFreeMonths,
          );

          const updatedCenter = await tx.center.update({
            where: { id: livePayment.centerId },
            data: {
              plan: planName,
              planExpiresAt: calculatedExpiry,
              isActive: true,
              maxStudents: tierLimits.maxStudents || 250,
              maxUsers: tierLimits.maxUsers || 4,
              pendingFreeMonths: finalPendingFreeMonths,
            },
          });

          logEngine(
            "SUCCESS",
            "CENTER_CORE_UPDATE_SUCCESS",
            `[Trace: ${traceId}] تم تحديث جدول السنتر ${updatedCenter.id} بنجاح إلى باقة ${planName} - الصلاحية حتى: ${calculatedExpiry.toISOString()} - الأشهر المجانية المتبقية بالمخزن: ${finalPendingFreeMonths}`,
          );

          // إدارة تدوير أشهر الخصم المستمر للأكواد الممتدة لعدة أشهر متتالية للسنتر
          if (
            livePayment.promoCodeId &&
            livePayment.promoCode &&
            !metadata.isPromoPausedEnforced
          ) {
            const duration = livePayment.promoCode.durationMonths;
            logEngine(
              "INFO",
              "PROMO_ROLLOVER_CHECK",
              `[Trace: ${traceId}] فحص تدوير كود الخصم الممتد. إجمالي مدة الكود: ${duration} شهر`,
            );

            if (
              livePayment.center.activePromoCodeId === livePayment.promoCodeId
            ) {
              const nextMonthsUsed = livePayment.center.promoMonthsUsed + 1;
              if (nextMonthsUsed >= duration) {
                await tx.center.update({
                  where: { id: livePayment.centerId },
                  data: {
                    activePromoCodeId: null,
                    promoMonthsUsed: 0,
                    promoAppliedAt: null,
                  },
                });
                logEngine(
                  "INFO",
                  "PROMO_ROLLOVER_EXPIRED",
                  `[Trace: ${traceId}] استوفى كود الخصم الممتد كامل مدته الزمنية الكلية وتم إزالته من حساب السنتر بنجاح.`,
                );
              } else {
                await tx.center.update({
                  where: { id: livePayment.centerId },
                  data: { promoMonthsUsed: nextMonthsUsed },
                });
                logEngine(
                  "INFO",
                  "PROMO_ROLLOVER_INCREMENTED",
                  `[Trace: ${traceId}] تم تصعيد عداد الشهور المستهلكة لكود الخصم الممتد حالياً إلى: ${nextMonthsUsed}/${duration}`,
                );
              }
            } else if (duration > 1) {
              await tx.center.update({
                where: { id: livePayment.centerId },
                data: {
                  activePromoCodeId: livePayment.promoCodeId,
                  promoMonthsUsed: 1,
                  promoAppliedAt: new Date(),
                },
              });
              logEngine(
                "INFO",
                "PROMO_ROLLOVER_NEW_INIT",
                `[Trace: ${traceId}] تم تفعيل وتثبيت كود الخصم المستمر الجديد على حساب السنتر لمدة شهور إجمالية: ${duration}`,
              );
            }
          }

          // هندسة تتبع المكافآت الترحيبية لنظام الإحالات المتطور للسنتر الداعي (Referral System Verification)
          const referrerCenterId = livePayment.center.referredById;
          if (
            referrerCenterId &&
            !livePayment.center.referralMilestoneAchieved &&
            !metadata.isPromoPausedEnforced
          ) {
            logEngine(
              "INFO",
              "REFERRAL_VERIFICATION_START",
              `[Trace: ${traceId}] السنتر مسجل عبر إحالة من السنتر المرجعي رقم: ${referrerCenterId}. فحص أهليّة المكافأة...`,
            );

            const successfulPaymentsCount = await tx.payment.count({
              where: {
                centerId: livePayment.centerId,
                status: "SUCCESS",
                NOT: { plan: "TRIAL" },
              },
            });

            if (successfulPaymentsCount === 0) {
              await tx.center.update({
                where: { id: livePayment.centerId },
                data: { referralMilestoneAchieved: true },
              });
              await tx.center.update({
                where: { id: referrerCenterId },
                data: {
                  referralCount: { increment: 1 },
                  pendingFreeMonths: { increment: 1 },
                },
              });
              logEngine(
                "SUCCESS",
                "REFERRAL_REWARD_ACTIVATED",
                `[Trace: ${traceId}] تم تفعيل حافز الإحالة الموثق! منح السنتر الداعي ID [${referrerCenterId}] شهر مجاني إضافي معلق بنجاح بالمخزن الحسابي.`,
              );
            } else {
              logEngine(
                "INFO",
                "REFERRAL_NOT_ELIGIBLE",
                `[Trace: ${traceId}] السنتر ليس في أول دفعة فعلية له؛ تم إلغاء شحن حافز الاحالة لمنع التكرار النفعي.`,
              );
            }
          }
        }

        // 6️⃣ حفظ كائن الفاتورة النهائي نهائياً بتحويل الحالة رسمياً إلى SUCCESS والتسجيل بالمخزن المالي
        logEngine(
          "INFO",
          "FINALIZING_PAYMENT_RECORD",
          `[Trace: ${traceId}] جاري إغلاق المعاملة وتثبيت الطابع الزمني المالي وعقد التفعيل المباشر...`,
        );

        const finalPaymentResult = await tx.payment.update({
          where: { id: livePayment.id },
          data: {
            status: PaymentStatus.SUCCESS,
            paidAt: new Date(),
            activatedAt: new Date(),
            processedAt: new Date(),
            centerSubscriptionId: targetSubscriptionId,
            transactionId: paymobTxnId
              ? String(paymobTxnId)
              : livePayment.transactionId,
          },
          include: { promoCode: true, center: true },
        });

        logEngine(
          "SUCCESS",
          "ENGINE_PROCESS_SUCCESS",
          `[Trace: ${traceId}] [Done] تم إغلاق وتثبيت المعاملة المالية البنكية بنجاح وحقن كافة الصلاحيات التشغيلية للفاتورة ID: ${paymentId}`,
        );

        return finalPaymentResult;
      });
    } catch (error) {
      logEngine(
        "ERROR",
        "PROCESS_SUCCESSFUL_PAYMENT_CRITICAL_FAIL",
        `[Trace: ${traceId}] فشل حرج تسبب في تراجع المعاملة الذرية (Transaction Rollback). السبب الفعلي: ${error.message} \nStack: ${error.stack}`,
      );
      throw error; // إعادة الـ Error لمنع إتمام الـ Transaction بشكل خاطئ بقاعدة البيانات
    }
  },

  // دالة معالجة وتوثيق فشل العمليات المالية لمنع تعليق حالة العمليات المعلقة بالسيستم
  processFailedPayment: async (paymentId, paymobTxnId) => {
    logEngine(
      "INFO",
      "ENGINE_PROCESS_FAILED",
      `تحويل حالة الفاتورة داخلياً إلى فشل السداد المالي للرقم الهيكلي ID: ${paymentId}`,
    );
    return await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: PaymentStatus.FAILED,
        transactionId: paymobTxnId ? String(paymobTxnId) : undefined,
        processedAt: new Date(),
      },
    });
  },
};

// ===========================================================================
// ROUTE [1]: راوت جلب تفاصيل الفاتورة الفوري والآمن (Pure Read-Only Details Engine)
// ذكي ومرن في التقاط معرّفات Paymob الممررة في الـ Redirect URL لمنع الـ 404
// ===========================================================================

router.get("/details/:id", authenticateToken, async (req, res) => {
  const traceId = buildTransactionId("DET");
  const idParam = req.params.id;

  // التقاط كافة المتغيرات الممكنة والممررة من بوابات الدفع المختلفة أثناء الـ Redirect
  const queryOrderId = req.query.order || req.query.order_id;
  const queryTxnId =
    req.query.id || req.query.transaction_id || req.query.txn_id;
  const queryMerchantRef =
    req.query.merchant_order_id || req.query.merchant_reference;
  const queryClientSecret = req.query.client_secret;

  const centerId = Number(req.user?.centerId);
  const userRole = req.user?.role;

  logEngine(
    "INFO",
    "ROUTE_DETAILS_INIT",
    `[Trace: ${traceId}] بدء تشغيل محرك تفاصيل الفاتورة الاحترافي. البارامتر الهيكلي: ${idParam}`,
    { queryOrderId, queryTxnId, queryMerchantRef, centerId, userRole },
  );

  try {
    if (!idParam) {
      logEngine(
        "WARN",
        "ROUTE_DETAILS_MISSING_PARAM",
        `[Trace: ${traceId}] تم رفض الطلب بسبب غياب معرف الفاتورة الأساسي بالـ URL`,
      );
      return res.status(400).json({
        success: false,
        error: "معرف الفاتورة مفقود أو مشوه بالطلب",
      });
    }

    // -------------------------------------------------------------------------
    // STEP 1: آلية البحث الذكية المتعددة والتراتبية لمنع الـ 404 نهائياً
    // -------------------------------------------------------------------------
    let payment = null;
    let resolvedSearchKey = idParam;

    // تصفية وتحديد المفتاح الأكثر موثوقية كخطوة أولى لقراءة سريعة
    if (queryTxnId && /^\d+$/.test(String(queryTxnId))) {
      resolvedSearchKey = String(queryTxnId);
    } else if (queryOrderId && !/^\d{8,}$/.test(idParam)) {
      resolvedSearchKey = String(queryOrderId);
    }

    logEngine(
      "INFO",
      "ROUTE_DETAILS_PRIMARY_LOOKUP",
      `[Trace: ${traceId}] محاولة البحث الأولية باستخدام المفتاح المستقر عليه: ${resolvedSearchKey}`,
    );
    payment = await optimizeFindPayment(resolvedSearchKey);

    // [المسار الرديف الأول]: إذا لم يعثر عليها، نجرب فورا فحص الـ Order ID الممرر بالـ Query
    if (
      !payment &&
      queryOrderId &&
      resolvedSearchKey !== String(queryOrderId)
    ) {
      logEngine(
        "INFO",
        "ROUTE_DETAILS_FALLBACK_ORDER",
        `[Trace: ${traceId}] مسار إنقاذ 1: البحث باستخدام معرف الطلب الخارجي: ${queryOrderId}`,
      );
      payment = await optimizeFindPayment(String(queryOrderId));
    }

    // [المسار الرديف الثاني]: إذا لم يعثر عليها، نجرب فورا فحص الـ Merchant Reference الممرر بالـ Query
    if (!payment && queryMerchantRef) {
      logEngine(
        "INFO",
        "ROUTE_DETAILS_FALLBACK_MERCHANT",
        `[Trace: ${traceId}] مسار إنقاذ 2: البحث باستخدام مرجع التاجر: ${queryMerchantRef}`,
      );
      payment = await prisma.payment.findFirst({
        where: { merchantReference: String(queryMerchantRef) },
        include: { promoCode: true, center: true },
      });
    }

    // [المسار الرديف الثالث]: البحث المعمق داخل حقول الـ JSON Metadata عن الـ client_secret
    if (!payment && queryClientSecret) {
      logEngine(
        "INFO",
        "ROUTE_DETAILS_FALLBACK_METADATA",
        `[Trace: ${traceId}] مسار إنقاذ 3: البحث المعمق داخل الـ Metadata عن الـ client_secret`,
      );
      payment = await prisma.payment.findFirst({
        where: {
          metadata: {
            path: ["paymobClientSecret"],
            equals: String(queryClientSecret),
          },
        },
        include: { promoCode: true, center: true },
      });
    }

    // [المسار الرديف الرابع والاخير]: إذا كان البارامتر الممرر رقماً، نفحص مطابقته لـ ID الفاتورة الداخلي بالسيستم
    if (!payment && /^\d+$/.test(idParam)) {
      logEngine(
        "INFO",
        "ROUTE_DETAILS_FALLBACK_INTERNAL_ID",
        `[Trace: ${traceId}] مسار إنقاذ 4: محاولة المطابقة بالـ ID الرقمي الداخلي للسيستم`,
      );
      payment = await prisma.payment.findUnique({
        where: { id: parseInt(idParam, 10) },
        include: { promoCode: true, center: true },
      });
    }

    // النتيجة النهائية لرحلة البحث الشاملة
    if (!payment) {
      logEngine(
        "WARN",
        "ROUTE_DETAILS_NOT_FOUND_TOTAL",
        `[Trace: ${traceId}] فشل العثور التام على الفاتورة بجميع مسارات البحث الانقاذية المتاحة لـ: ${idParam}`,
      );
      return res.status(404).json({
        success: false,
        error:
          "الفاتورة المطلوبة غير موجودة بنظام خادم المنصة حالياً، أو جاري معالجتها بالخلفية عبر الويب هوك.",
      });
    }

    logEngine(
      "SUCCESS",
      "ROUTE_DETAILS_RECORD_RESOLVED",
      `[Trace: ${traceId}] تم العثور على الفاتورة بنجاح. معرف الفاتورة الداخلي: ${payment.id} | الحالة الحالية: ${payment.status}`,
    );

    // -------------------------------------------------------------------------
    // STEP 2: جدار الحماية الأمني وعزل بيانات المراكز التعليمية (Multi-Tenant Isolation)
    // -------------------------------------------------------------------------
    if (payment.centerId !== centerId && userRole !== "ADMIN") {
      logEngine(
        "ERROR",
        "ROUTE_DETAILS_SECURITY_VIOLATION",
        `[Trace: ${traceId}] خرق أمني! محاولة وصول غير مصرح بها من حساب سنتر [${centerId}] لفاتورة ملك سنتر آخر [${payment.centerId}]`,
      );
      return res.status(403).json({
        success: false,
        error:
          "غير مصرح لك بالوصول لبيانات هذه الفاتورة مالياً وحسابياً لحماية الخصوصية والأمان",
      });
    }

    // -------------------------------------------------------------------------
    // STEP 3: محرك الاستعلام اللحظي والتفعيل التلقائي الفوري (Live Polling & Sync Engine)
    // -------------------------------------------------------------------------
    if (payment.status === PaymentStatus.PENDING) {
      const paymobSecret = process.env.PAYMOB_SECRET_KEY;
      const { success: querySuccess, pending: queryPending } = req.query;

      logEngine(
        "INFO",
        "ROUTE_DETAILS_PENDING_FLOW",
        `[Trace: ${traceId}] الفاتورة معلقة محلياً بالسيستم، جاري فحص المؤشرات اللحظية لتحديث الرؤية للمستخدم.`,
      );

      // أ. التحقق من مؤشرات الفشل الصريحة الممررة برابط العودة
      if (querySuccess === "false" || queryPending === "true") {
        logEngine(
          "INFO",
          "ROUTE_DETAILS_URL_INDICATORS_FAILED",
          `[Trace: ${traceId}] روابط الدفع توحي بفشل أو عدم اكتمال السداد البنكي ظاهرياً.`,
        );
        payment.status = PaymentStatus.FAILED;
      }
      // ب. الاستعلام المباشر عبر سيرفرات Paymob الرسمية للتحقق من الحالة الحقيقية للحفاظ على استقرار الحسابات
      else if (paymobSecret) {
        try {
          const targetCheckId =
            queryTxnId || payment.transactionId || payment.paymobIntentionId;

          if (targetCheckId && /^\d+$/.test(String(targetCheckId))) {
            const checkUrl = `https://accept.paymob.com/api/acceptance/transactions/${targetCheckId}`;
            logEngine(
              "INFO",
              "ROUTE_DETAILS_SENDING_API_POLL",
              `[Trace: ${traceId}] إرسال طلب استعلام فوري لخوادم باي موب للرقم الخارجي: ${targetCheckId}`,
            );

            const paymobCheckRes = await axios.get(checkUrl, {
              headers: { Authorization: `Token ${paymobSecret}` },
              timeout: 6000, // مهلة استجابة قصيرة لضمان عدم تعليق الراوت
            });

            if (paymobCheckRes.data) {
              const extSuccess =
                paymobCheckRes.data.success === true &&
                paymobCheckRes.data.pending === false;
              logEngine(
                "INFO",
                "ROUTE_DETAILS_POLL_RESPONSE_RAW",
                `[Trace: ${traceId}] استجابة بوابة باي موب الحية -> Success: ${paymobCheckRes.data.success} | Pending: ${paymobCheckRes.data.pending}`,
              );

              if (extSuccess) {
                logEngine(
                  "SUCCESS",
                  "ROUTE_DETAILS_LIVE_SYNC_TRIGGER",
                  `[Trace: ${traceId}] تأكيد بنكي فوري بالنجاح! تشغيل محرك الشحن والتفعيل التلقائي المركزي فوراً لمنع الـ Lag.`,
                );

                // تفعيل الصلاحيات أو محفظة الواتساب ذرياً في قاعدة البيانات في نفس اللحظة
                const synchronizedPayment =
                  await PaymentService.processSuccessfulPayment(
                    payment.id,
                    targetCheckId,
                  );
                payment = synchronizedPayment; // تحديث الكائن المحلي لإرساله في الرد
              } else if (paymobCheckRes.data.success === false) {
                logEngine(
                  "WARN",
                  "ROUTE_DETAILS_LIVE_SYNC_FAILED",
                  `[Trace: ${traceId}] تأكيد بنكي بفشل المعاملة الخارجية. تحديث حالة الفاتورة محلياً.`,
                );
                const synchronizedFailedPayment =
                  await PaymentService.processFailedPayment(
                    payment.id,
                    targetCheckId,
                  );
                payment = synchronizedFailedPayment;
              }
            }
          } else {
            logEngine(
              "INFO",
              "ROUTE_DETAILS_POLL_SKIP_NO_DIGITS",
              `[Trace: ${traceId}] تخطي فحص خوادم باي موب لعدم توفر معرف بنكي رقمي صالح حتى الآن.`,
            );
          }
        } catch (apiErr) {
          logEngine(
            "WARN",
            "ROUTE_DETAILS_POLL_EXCEPTION_CAUGHT",
            `[Trace: ${traceId}] تنبيه: فشل استعلام فحص الحالة اللحظي الطارئ من بوابة باي موب (قد يعود بسبب قيود الشبكة): ${apiErr.message}`,
          );
        }
      }
    }

    // -------------------------------------------------------------------------
    // STEP 4: تجميع وتحليل البيانات الوصفية واللوجستية لواجهة مستخدم احترافية
    // -------------------------------------------------------------------------
    const finalMetadata = safeJsonMetadata(payment.metadata);
    const isWhatsappPayment =
      payment.plan === "WHATSAPP" || finalMetadata.isWhatsappCharge === true;

    // بناء كائن تفصيلي مخصص للرد ليناسب كلاً من الاشتراكات وشحن الواتساب
    const operationalPayload = {
      isWhatsappCharge: isWhatsappPayment,
      requestedType: isWhatsappPayment ? "WHATSAPP" : "SAAS_SUBSCRIPTION",
      billingCycle:
        payment.billingCycle || finalMetadata.billingCycle || "MONTHLY",
      durationMonths: payment.durationMonths || 1,
      basePriceBeforeAllDiscounts:
        finalMetadata.basePriceBeforeAllDiscounts ||
        payment.planPrice ||
        payment.amount,
      discountPercentApplied: finalMetadata.discountAppliedPercent || 0,
      freeMonthsConsumedFromReferrals: finalMetadata.freeMonthsConsumed || 0,
      targetCenterName: payment.center?.name || "Unknown Center",
      whatsappMessagesCredited: isWhatsappPayment
        ? finalMetadata.whatsappCount ||
          Math.floor(payment.amount / WHATSAPP_PRICE)
        : 0,
    };

    logEngine(
      "SUCCESS",
      "ROUTE_DETAILS_FINISHED_SUCCESSFULLY",
      `[Trace: ${traceId}] تم الانتهاء من تجهيز الفاتورة بنجاح وإرسال الرد المالي المتكامل للمستخدم.`,
    );

    // الرد المالي والتقني الشامل والمؤمن للفرونت إند
    return res.status(200).json({
      success: true,
      payment,
      operationalDetails: operationalPayload,
      clientSecret:
        finalMetadata?.paymobClientSecret || payment.paymobIntentionId,
      paymobPublicKey:
        finalMetadata?.paymobPublicKey || process.env.PAYMOB_PUBLIC_KEY,
      checkoutUrl:
        finalMetadata?.checkoutUrl ||
        (finalMetadata?.paymobClientSecret
          ? `https://accept.paymob.com/unifiedcheckout/?publicKey=${process.env.PAYMOB_PUBLIC_KEY}&clientSecret=${finalMetadata.paymobClientSecret}&merchant_order_id=${payment.merchantReference}`
          : null),
      metadata: finalMetadata,
      systemDiagnostics: {
        traceId,
        synchronizedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logEngine(
      "ERROR",
      "ROUTE_DETAILS_FATAL_CRASH",
      `[Trace: ${traceId}] خطأ كارثي حرج وغير متوقع داخل محرك جلب التفاصيل: ${err.message}`,
      { stack: err.stack },
    );
    return res.status(500).json({
      success: false,
      error: "خطأ داخلي حرج في خادم عمليات تفاصيل المنصة الرقمية",
    });
  }
});

// ===========================================================================
// ROUTE: Webhook Engine - النسخة الحصينة والذكية (يدعم التمييز التام بين WhatsApp و Subscriptions)
// ===========================================================================

// ===========================================================================
// ROUTE: مستقبل الإشارات المالية المركزي والويب هوك الفولاذي (The Ironclad Webhook Engine)
// حماية كاملة من الـ Race Conditions وتحديث فوري لحدود الباقات والطلاب والمستخدمين لعام 2026
// ===========================================================================
router.post("/webhook", async (req, res) => {
  // توليد معرّف تتبع فريد لتتبع رحلة طلب الويب هوك بالكامل داخل لوجات النظام الخلفية
  const webhookTraceId = `WH-TRACE-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  logEngine(
    "INFO",
    "ROUTE_WEBHOOK_RECEIVED",
    `[Trace: ${webhookTraceId}] إشارة مالية جديدة واردة من خوادم Paymob خلف الكواليس.`,
  );

  try {
    const payload = req.body;
    const hmacQuery = req.query.hmac;

    // 1️⃣ استخراج الكائن الداخلي مرن الهيكل لتغطية كافة إصدارات ومخططات Paymob (Unified & Legacy)
    const txn = payload.obj || payload.data || payload.transaction || payload;

    if (!txn || !txn.id) {
      logEngine(
        "WARN",
        "ROUTE_WEBHOOK_EMPTY_PAYLOAD",
        `[Trace: ${webhookTraceId}] تنبيه حرج: تم استلام كائن معطيات فارغ أو غير متوافق هيكلياً من بوابة الدفع.`,
      );
      return res.status(200).json({
        success: true,
        message: "Payload dropped due to empty structural identifier.",
      });
    }

    const paymobTxnId = String(txn.id);
    logEngine(
      "INFO",
      "ROUTE_WEBHOOK_PROCESSING",
      `[Trace: ${webhookTraceId}] بدء فحص الحماية الرقمية والتحقق للمعاملة الخارجية رقم: ${paymobTxnId}`,
    );

    // 2️⃣ 🛡️ الفحص الأمني الصارم: التحقق من التوقيع الرقمي لمنع الاختراقات وتزوير البيانات (HMAC Verification)
    const isSignatureValid = PaymentService.verifyPaymobHmac(txn, hmacQuery);
    if (!isSignatureValid) {
      logEngine(
        "ERROR",
        "SECURITY_ALERT_HMAC_FAIL",
        `[Trace: ${webhookTraceId}] انتهاك أمني خطير: فشل فحص مطابقة HMAC للمعاملة: ${paymobTxnId}. تم رفض المعالجة فوراً لحماية حسابات المنصة!`,
      );
      return res.status(200).json({
        success: false,
        error: "Invalid integrity signature token verification.",
      });
    }

    // =========================================================================
    // ⏳ [آلية الإنقاذ الأولى لمنع الـ Race Condition الزمني]
    // الانتظار المتعمد لثوانٍ معدودة للتأكد من انتهاء الفرونت-إند والباك-إند من كتابة الفاتورة الأصلية
    // =========================================================================
    logEngine(
      "INFO",
      "WEBHOOK_RACE_DELAY_START",
      `[Trace: ${webhookTraceId}] تطبيق فترة انتظار آمنة ومدروسة (2.5 ثانية) لمنع سباق البيانات المتزامن وتأكيد استقرار الحفظ...`,
    );
    await new Promise((resolve) => setTimeout(resolve, 2500));
    logEngine(
      "INFO",
      "WEBHOOK_RACE_DELAY_END",
      `[Trace: ${webhookTraceId}] انتهاء فترة الانتظار الآمنة بنجاح، جاري بدء فحص الاستعلام الهيكلي الذكي.`,
    );

    // 3️⃣ تجميع تراتبي لمعرّفات البحث الفريدة المتاحة بالـ Payload للوصول للفاتورة الأصلية بدقة
    const merchantOrderId =
      txn?.merchant_order_id ||
      txn?.order?.merchant_order_id ||
      txn?.merchant_reference;
    const paymobOrderId = txn?.order?.id;

    logEngine(
      "INFO",
      "WEBHOOK_SEARCH_TOKENS",
      `[Trace: ${webhookTraceId}] مؤشرات البحث المستخرجة: merchantOrderId=${merchantOrderId} | paymobOrderId=${paymobOrderId} | paymobTxnId=${paymobTxnId}`,
    );

    // 4️⃣ استدعاء الفاتورة من قاعدة البيانات باستخدام آلية البحث التراتبية والمحسنة (Multi-Level Lookup)
    let paymentRecord = null;

    // أ. البحث عن الفاتورة بمرجع التاجر الفريد الخاص بالمنصة (الخيار الأكثر دقة وأماناً)
    if (merchantOrderId) {
      paymentRecord = await prisma.payment.findFirst({
        where: { merchantReference: String(merchantOrderId) },
        include: { center: true },
      });
    }

    // ب. خيار التراجع الأول: إذا لم تُكتشف، ابحث بواسطة الرقم التعريفي البنكي المباشر للمعاملة (transactionId)
    if (!paymentRecord && paymobTxnId) {
      paymentRecord = await prisma.payment.findFirst({
        where: { transactionId: String(paymobTxnId) },
        include: { center: true },
      });
    }

    // ج. خيار التراجع الثاني والأخير: البحث بواسطة معرف الطلب الشامل لباي موب (paymobIntentionId)
    if (!paymentRecord && paymobOrderId) {
      paymentRecord = await prisma.payment.findFirst({
        where: {
          OR: [
            { paymobIntentionId: String(paymobOrderId) },
            { merchantReference: String(paymobOrderId) },
          ],
        },
        include: { center: true },
      });
    }

    // 5️⃣ 🛡️ آلية الإنقاذ وحماية الإيرادات المتقدمة (Smart Fallback Creation Pattern)
    if (!paymentRecord) {
      logEngine(
        "WARN",
        "WEBHOOK_FALLBACK_TRIGGERED",
        `[Trace: ${webhookTraceId}] لم يُعثر على سجل فاتورة مسبق للمراجع الممررة. جاري تفعيل محرك البحث المعزول والتأكد من اللحظات الأخيرة.`,
      );

      // فحص أخير وجازم بالـ transactionId الفعلي لمنع التكرار في الأجزاء من الثانية المتزامنة
      const absoluteDuplicateCheck = await prisma.payment.findFirst({
        where: { transactionId: paymobTxnId },
        include: { center: true },
      });

      if (absoluteDuplicateCheck) {
        logEngine(
          "SUCCESS",
          "WEBHOOK_RACE_CONDITION_PREVENTED",
          `[Trace: ${webhookTraceId}] تم إنقاذ الموقف في جزء الثانية الأخير! الفاتورة كانت قد أُنشئت بالفعل بـ ID داخلي: ${absoluteDuplicateCheck.id}`,
        );
        paymentRecord = absoluteDuplicateCheck;
      } else {
        // احتساب القيمة المالية الحقيقية من السنتات البنكية إلى الجنيهات المصرية المستقرة بالسيستم
        const calculatedAmount = txn.amount_cents
          ? Number(txn.amount_cents) / 100
          : 0;

        // =========================================================================
        // 🏢 محرك استخراج معرف السنتر الفولاذي المحسن (2026 Edition)
        let extractedCenterId = null;

        // 1. من metadata (الأقوى)
        if (txn.metadata?.centerId) extractedCenterId = txn.metadata.centerId;
        else if (txn.order?.metadata?.centerId)
          extractedCenterId = txn.order.metadata.centerId;

        // 2. من description أو name (اللي بنحطه في /create)
        const textSearch = JSON.stringify(txn).toLowerCase();
        const cidMatch =
          textSearch.match(/cid:(\d+)/) ||
          textSearch.match(/center[_-]?id["']?\s*[:=]\s*["']?(\d+)/);
        if (cidMatch) extractedCenterId = cidMatch[1];

        // 3. من merchant_order_id
        if (!extractedCenterId && typeof txn.merchant_order_id === "string") {
          const match = txn.merchant_order_id.match(/SENTRYK-(\d+)-/i);
          if (match) extractedCenterId = match[1];
        }

        let detectedCenterOwner = extractedCenterId
          ? parseInt(extractedCenterId, 10)
          : 0;
        let verifiedCenter = null;

        // التحقق المطلق من أهلية ووجود السنتر في الداتابيز لحماية سلامة قيود الجداول (Foreign Key Integrity)
        if (detectedCenterOwner > 0) {
          verifiedCenter = await prisma.center.findUnique({
            where: { id: detectedCenterOwner },
          });
        }

        // 🛑 [قرار سيادي]: حظر التوجيه التلقائي للسنتر الأول لمنع الهدر والخلط المالي
        if (!verifiedCenter) {
          logEngine(
            "ERROR",
            "WEBHOOK_CENTER_NOT_FOUND_FATAL",
            `[Trace: ${webhookTraceId}] خطأ كارثي ومرفوض منطقياً: الإشارة لا تطابق أي سنتر تعليمي مسجل أو نشط بنظام المنصة (المعرّف المستخرج: [${extractedCenterId}]). تم إسقاط الطلب بأمان لمنع تشويه السجلات الممالية للمراكز الأخرى!`,
          );
          return res.status(200).json({
            success: false,
            error:
              "Critical: Transaction dropped due to unidentifiable Center ID reference.",
          });
        }

        // 🧠 محرك التحليل والتعرف الذكي على نوع الخطوط والباقات الواردة عبر الـ Tokens النصية
        let finalDetectedPlan = null;
        const payloadTextTokens = [];

        if (txn.items && Array.isArray(txn.items)) {
          txn.items.forEach((item) =>
            payloadTextTokens.push(String(item.name || item.description || "")),
          );
        }
        if (txn.order?.items && Array.isArray(txn.order.items)) {
          txn.order.items.forEach((item) =>
            payloadTextTokens.push(String(item.name || item.description || "")),
          );
        }
        if (merchantOrderId) payloadTextTokens.push(String(merchantOrderId));

        const combinedPayloadText = payloadTextTokens.join(" ").toUpperCase();
        logEngine(
          "INFO",
          "WEBHOOK_PLAN_DETECTOR_SCAN",
          `[Trace: ${webhookTraceId}] نص الكشف المستخرج للتحليل البنيوي: "${combinedPayloadText}"`,
        );

        if (combinedPayloadText.includes("WHATSAPP")) {
          finalDetectedPlan = "WHATSAPP";
        } else if (combinedPayloadText.includes("ELITE")) {
          finalDetectedPlan = "ELITE";
        } else if (combinedPayloadText.includes("PREMIUM")) {
          finalDetectedPlan = "PREMIUM";
        } else if (combinedPayloadText.includes("BASIC")) {
          finalDetectedPlan = "BASIC";
        } else if (combinedPayloadText.includes("TRIAL")) {
          finalDetectedPlan = "TRIAL";
        }

        // في حال لم يكتب اسم الباقة صراحةً، نقوم بمطابقتها عبر الأسعار الرسمية المسجلة بالسيستم
        if (!finalDetectedPlan) {
          logEngine(
            "INFO",
            "WEBHOOK_PLAN_DETECTOR_BY_PRICE",
            `[Trace: ${webhookTraceId}] لم يستدل على نص الباقة، جاري المطابقة البديلة عبر السعر المدفوع: ${calculatedAmount} ج.م`,
          );
          if (calculatedAmount === PLAN_TIER_LIMITS.BASIC?.defaultPrice)
            finalDetectedPlan = "BASIC";
          else if (calculatedAmount === PLAN_TIER_LIMITS.PREMIUM?.defaultPrice)
            finalDetectedPlan = "PREMIUM";
          else if (calculatedAmount === PLAN_TIER_LIMITS.ELITE?.defaultPrice)
            finalDetectedPlan = "ELITE";
          else {
            logEngine(
              "WARN",
              "WEBHOOK_PLAN_DETECTOR_UNKNOWN_PRICE",
              `[Trace: ${webhookTraceId}] السعر المدفوع غير قياسي للباقات القائمة، سيتم تعيين الباقة PREMIUM كخيار أمان أخير لتغطية حدود السيستم والتشغيل الجاري.`,
            );
            finalDetectedPlan = "PREMIUM";
          }
        }

        const finalRequestedType =
          finalDetectedPlan === "WHATSAPP" ? "WHATSAPP" : "SUBSCRIPTION";

        // 📝 إنشاء الفاتورة الطارئة بالبيانات الدقيقة والمؤكدة للسنتر الفعلي صاحب الطلب الأصلي
        try {
          paymentRecord = await prisma.payment.create({
            data: {
              centerId: verifiedCenter.id, // السنتر الحقيقي الذي قام بالطلب!
              amount: calculatedAmount,
              plan: finalDetectedPlan,
              status: PaymentStatus.PENDING,
              paymentMethod: "PAYMOB_WEBHOOK_FALLBACK",
              transactionId: paymobTxnId,
              merchantReference: String(
                merchantOrderId || paymobOrderId || paymobTxnId,
              ),
              paymobIntentionId: String(paymobOrderId || paymobTxnId),
              planPrice: calculatedAmount,
              durationMonths: 1,
              metadata: {
                rawWebhookPayload: txn,
                createdByWebhookFallback: true,
                systemTraceId: webhookTraceId,
                isWhatsappCharge: finalDetectedPlan === "WHATSAPP",
                requestedType: finalRequestedType,
                verifiedCenterName: verifiedCenter.name,
              },
            },
            include: { center: true },
          });

          logEngine(
            "SUCCESS",
            "WEBHOOK_FALLBACK_RECORD_CREATED",
            `[Trace: ${webhookTraceId}] تم إنشاء سجل فاتورة إنقاذي وتخصيصه بنجاح للسنتر الأصلي رقم: ${verifiedCenter.id} [${verifiedCenter.name}] | خطة: ${finalDetectedPlan}`,
          );
        } catch (createErr) {
          logEngine(
            "ERROR",
            "WEBHOOK_FALLBACK_WRITE_CRASH",
            `[Trace: ${webhookTraceId}] فشل حرج أثناء كتابة سجل الفاتورة الطارئة بقاعدة البيانات: ${createErr.message}`,
          );
          return res.status(200).json({
            success: false,
            error: "Database fallback write rejected.",
          });
        }
      }
    }

    // 6️⃣ 🛡️ بوابات الحماية التكرارية الفولاذية (Idempotency Barrier Check)
    const recordMetadata =
      typeof paymentRecord.metadata === "string"
        ? JSON.parse(paymentRecord.metadata)
        : paymentRecord.metadata || {};

    if (paymentRecord.status === PaymentStatus.SUCCESS) {
      logEngine(
        "INFO",
        "ROUTE_WEBHOOK_IDEMPOTENCY_SKIP",
        `[Idempotency Guard] الفاتورة الحالية ID: ${paymentRecord.id} مستقرة مسبقاً على حالة SUCCESS مسبقاً. تم حظر إعادة تفعيل الباقة أو تكرار الشحن بنجاح تام لحماية حسابات المنصة وحمايتها 🛡️`,
      );
      return res.status(200).json({
        success: true,
        message: "Transaction already processed and settled safely.",
      });
    }

    // 7️⃣ تقييم حالة الدفع النهائية الصادرة من البنك المركزي وبوابة الدفع الخارجية
    const isPaymentApproved =
      (txn.success === true || String(txn.success) === "true") &&
      (txn.pending === false || String(txn.pending) === "false") &&
      (txn.error_occured === false || String(txn.error_occured) === "false");

    logEngine(
      "INFO",
      "ROUTE_WEBHOOK_DECISION",
      `[Trace: ${webhookTraceId}] نتيجة تقييم البنك النهائي للمعاملة رقم ${paymobTxnId}: ${isPaymentApproved ? "APPROVED ✅" : "FAILED ❌"}`,
    );

    if (isPaymentApproved) {
      const isWhatsappCharge =
        paymentRecord.plan === "WHATSAPP" ||
        recordMetadata.isWhatsappCharge === true;

      if (isWhatsappCharge) {
        // =========================================================================
        // 🛑 [المسار المحمي للواتساب]: معالجة الشحن ذرياً بداخل Transaction مغلق ومحمي بقفل البيانات
        // =========================================================================
        logEngine(
          "INFO",
          "WEBHOOK_WHATSAPP_ATOMIC_START",
          `[Trace: ${webhookTraceId}] بدء شحن محفظة الواتساب بشكل معزول ذرياً للفاتورة ID: ${paymentRecord.id}`,
        );

        await prisma.$transaction(async (tx) => {
          // إعادة قراءة حالة الفاتورة من داخل المعاملة المقفلة لضمان عدم حدوث تداخل متزامن مطلقاً
          const currentPayment = await tx.payment.findUnique({
            where: { id: paymentRecord.id },
            select: { status: true },
          });

          if (currentPayment.status === PaymentStatus.SUCCESS) {
            throw new Error("WHATSAPP_ALREADY_PROCESSED_IN_TRANSACTION");
          }

          // أ. تحديث حالة الفاتورة فوراً إلى ناجحة مع توثيق وقت الدفع لغلق الباب أمام الاستدعاءات المتزامنة
          const updatedPayment = await tx.payment.update({
            where: { id: paymentRecord.id },
            data: {
              status: PaymentStatus.SUCCESS,
              paidAt: new Date(),
              transactionId: paymobTxnId,
            },
          });

          const messagesToCredit = Math.floor(
            updatedPayment.amount / PRICE_PER_MESSAGE,
          );
          logEngine(
            "INFO",
            "WEBHOOK_WHATSAPP_INCREMENTING",
            `[Trace: ${webhookTraceId}] شحن المحفظة بـ: ${messagesToCredit} رسالة للسنتر الحقيقي: ${updatedPayment.centerId}`,
          );

          // ب. تحديث رصيد المحفظة الفعلي للسنتر بعملية increment رياضية آمنة على مستوى محرك قاعدة البيانات
          await tx.whatsAppWallet.update({
            where: { centerId: updatedPayment.centerId },
            data: {
              balance: { increment: messagesToCredit },
            },
          });

          // ج. جلب معرف المحفظة لتوثيق السجل المحاسبي والتدقيق البرمجي
          const currentWallet = await tx.whatsAppWallet.findUnique({
            where: { centerId: updatedPayment.centerId },
            select: { id: true },
          });

          // د. إدراج حركة الشحن في جدول التدقيق الصارم لمنع التلاعب بالحسابات وتوفير تقارير محاسبية دقيقة للسنتر
          await tx.whatsAppTransaction.create({
            data: {
              walletId: currentWallet.id,
              amount: messagesToCredit,
              type: "CHARGE",
              description: `شحن تلقائي للمحفظة عبر الويب هوك بقيمة ${updatedPayment.amount} ج.م مقابل ${messagesToCredit} رسالة [Trace: ${webhookTraceId}]`,
              paymentId: updatedPayment.id,
            },
          });

          logEngine(
            "SUCCESS",
            "WEBHOOK_WHATSAPP_CREDITED",
            `[Trace: ${webhookTraceId}] تم حقن عدد ${messagesToCredit} رسالة بنجاح وبشكل ذري متكامل في محفظة السنتر صاحب المعاملة ${updatedPayment.centerId}`,
          );
        });
      } else {
        // =========================================================================
        // ⚡ [المسار المحمي لباقات الـ SaaS وتحديث حدود السنتر الفورية على السيرفر]
        // =========================================================================
        logEngine(
          "INFO",
          "WEBHOOK_SAAS_ACTIVATION_START",
          `[Trace: ${webhookTraceId}] تفويض السيرفيس الموحد لتفعيل الباقة ومعالجة الأكواد الترويجية للفاتورة: ${paymentRecord.id}`,
        );

        // 1. استدعاء السيرفيس المركزي (Single Source of Truth) لتنفيذ منطق الـ Promo Codes والـ Referrals والتجديد المعتمد بالباك-إند
        const processedPayment = await PaymentService.processSuccessfulPayment(
          paymentRecord.id,
          paymobTxnId,
        );

        // 2. 🛡️ التحديث القسري والتعزيزي المباشر لتثبيت وتأكيد الحفظ (Force Enforcement Technique)
        const finalPlanName = processedPayment?.plan || paymentRecord.plan;
        const tierLimits = PLAN_TIER_LIMITS[finalPlanName];

        if (tierLimits) {
          logEngine(
            "INFO",
            "WEBHOOK_SAAS_FORCE_ENFORCEMENT",
            `[Trace: ${webhookTraceId}] جاري فرض وتأكيد قيم الباقة الحالية قسرياً في الداتابيز: ${finalPlanName} -> الطلاب القصوى: ${tierLimits.maxStudents}، المستخدمين: ${tierLimits.maxUsers}`,
          );

          await prisma.center.update({
            where: { id: paymentRecord.centerId },
            data: {
              plan: finalPlanName,
              maxStudents: tierLimits.maxStudents,
              maxUsers: tierLimits.maxUsers,
              planExpiresAt: new Date(
                Date.now() +
                  (paymentRecord.durationMonths || 1) *
                    30 *
                    24 *
                    60 *
                    60 *
                    1000,
              ),
              isActive: true,
            },
          });

          logEngine(
            "SUCCESS",
            "ROUTE_WEBHOOK_COMPLETED_WITH_FORCE",
            `[Webhook SUCCESS] تم تحديث السنتر الأصلي [${paymentRecord.centerId}] قسرياً وتعيين خطة ${finalPlanName} بنجاح تام وتصفير الثغرات نهائياً 🚀`,
          );
        } else {
          logEngine(
            "ERROR",
            "WEBHOOK_SAAS_INVALID_TIER",
            `[Trace: ${webhookTraceId}] خطأ بنيوي حرج: حدود الخطة المستهدفة غير معرفة بجدول حدود السيستم المعياري: ${finalPlanName}`,
          );
        }
      }
    } else {
      // في حالة فشل عملية الدفع بنكياً، يتم نقل الفاتورة إلى حالة FAILED لحفظ توازن الحسابات والتدقيق الرقمي
      logEngine(
        "WARN",
        "WEBHOOK_PAYMENT_FAILED_SIGNAL",
        `[Trace: ${webhookTraceId}] إشارة البنك تفيد بنقص الرصيد أو فشل السداد. جاري إغلاق السجل الداخلي كـ FAILED والمزامنة.`,
      );
      await PaymentService.processFailedPayment(paymentRecord.id, paymobTxnId);
    }

    // الرد بوضع 200 دائماً لخوادم باي موب لإعلامهم باستلام الإشارة بنجاح تصفير ومنع تكرار محاولات الإرسال المزعجة من طرفهم
    return res.status(200).json({
      success: true,
      message:
        "Webhook signal processed and system database state synchronized successfully.",
    });
  } catch (err) {
    // التقاط استثناء الحماية الذرية المفتعل بداخل المعاملة في حال حدوث سباق بيانات متوازي
    if (err.message === "WHATSAPP_ALREADY_PROCESSED_IN_TRANSACTION") {
      logEngine(
        "INFO",
        "ROUTE_WEBHOOK_RACE_PREVENTED_IN_TX",
        `[Trace: ${webhookTraceId}] منع معالجة شحن مكررة متزامنة للواتساب بداخل الـ Transaction بنجاح وحماية الأرصدة 🛡️`,
      );
      return res
        .status(200)
        .json({ success: true, message: "Transaction already handled." });
    }

    logEngine(
      "ERROR",
      "ROUTE_WEBHOOK_FATAL_EXCEPTION",
      `[Trace: ${webhookTraceId}] انهيار حرج ومفاجئ بمستقبل إشارات الويب هوك المالي: ${err.message}`,
      { stack: err.stack },
    );

    return res.status(200).json({
      success: false,
      error: "Internal critical handling pipeline caught exception safely.",
    });
  }
});
// ===========================================================================
// ROUTE [3]: راوت إنشاء الطلبات وفواتير الدفع الموحدة لعام 2026 للمراكز
// ===========================================================================
// ===========================================================================
// ROUTE: إنشاء وحساب الفواتير والاشتراكات البرمجية (The Legendary Create Engine)
// ===========================================================================
router.post(
  "/create",
  authenticateToken,
  requireCenterAccess,
  requireRole(["ADMIN"]),
  async (req, res) => {
    const debugId = buildTransactionId("REQ");

    logEngine(
      "INFO",
      "ROUTE_CREATE_START",
      `[Trace: ${debugId}] بدء صياغة وحساب قيمة فاتورة برمجية جديدة لسنتر تعليمي.`,
      { body: req.body, user: req.user },
    );

    try {
      // 1️⃣ استخراج وتطهير المعطيات القادمة من الطلب (Sanitization Layer)
      const { type, plan, whatsappCount, promoCodeStr, billingCycle } =
        req.body || {};
      const centerId = Number(req.user?.centerId);
      const userId = Number(req.user?.userId || req.user?.id || 0);

      const rawType = normalizeText(type);
      const rawPlan = normalizeText(plan);
      const cycle =
        normalizeText(billingCycle) === "YEARLY" ? "YEARLY" : "MONTHLY";

      logEngine(
        "INFO",
        "INPUT_PARSED",
        `[Trace: ${debugId}] تم تطهير البيانات وتحديد الدورة الحسابية: السنتر=${centerId}, الباقة=${rawPlan}, النوع=${rawType}, الدورة=${cycle}`,
      );

      // التحقق الأولي من سلامة المعرفات الرقمية للسنتر
      if (!centerId || Number.isNaN(centerId)) {
        logEngine(
          "ERROR",
          "INVALID_CENTER_ID",
          `[Trace: ${debugId}] معرف السنتر مفقود أو غير صالح برمجياً.`,
        );
        return res.status(400).json({
          success: false,
          error: "فشل التحقق من هوية السنتر التعليمي الممرر بالطلب.",
        });
      }

      // 2️⃣ جلب بيانات السنتر الحية بشكل معزول وآمن وقفل السجل ماليًا
      logEngine(
        "INFO",
        "FETCHING_CENTER",
        `[Trace: ${debugId}] جاري جلب السنتر [${centerId}] مع كود الخصم النشط المرتبط به...`,
      );
      let center = await prisma.center.findUnique({
        where: { id: centerId },
        include: { activePromoCode: true },
      });

      if (!center) {
        logEngine(
          "ERROR",
          "CENTER_NOT_FOUND",
          `[Trace: ${debugId}] السنتر [${centerId}] غير موجود بقاعدة البيانات.`,
        );
        return res.status(404).json({
          success: false,
          error:
            "السنتر التعليمي المستهدف غير موجود بقاعدة بيانات النظام الحالية",
        });
      }

      logEngine(
        "INFO",
        "CENTER_FETCHED_SUCCESS",
        `[Trace: ${debugId}] تم العثور على السنتر: ${center.name}, الباقة الحالية: ${center.plan}, الأشهر المجانية المتاحة: ${center.pendingFreeMonths}`,
      );

      // 3️⃣ 🔄 فحص وتطهير الأكواد المنتهية الصلاحية مسبقاً لمنع التلاعب الفتراتي
      if (center.activePromoCodeId && center.activePromoCode) {
        logEngine(
          "INFO",
          "CHECKING_ACTIVE_PROMO_VALIDITY",
          `[Trace: ${debugId}] فحص كود الخصم المثبت حالياً على السنتر [${center.activePromoCode.code}]`,
        );

        const isExpired = center.activePromoCode.expiresAt < new Date();
        const isDurationFinished =
          center.promoMonthsUsed >= center.activePromoCode.durationMonths;

        if (isExpired || isDurationFinished) {
          logEngine(
            "WARN",
            "PROMO_EXPIRED_DETECTED",
            `[Trace: ${debugId}] كود الخصم النشط منتهي الصلاحية! منتهي زمنياً=${isExpired}, مستهلك الشهور=${isDurationFinished}. بدء الإسقاط...`,
          );

          center = await prisma.center.update({
            where: { id: centerId },
            data: {
              activePromoCodeId: null,
              promoMonthsUsed: 0,
              promoAppliedAt: null,
            },
            include: { activePromoCode: true },
          });

          logEngine(
            "SUCCESS",
            "PROMO_CLEANUP_DONE",
            `[Trace: ${debugId}] تم تطهير وإسقاط الكود المنتهي من مخزن البيانات بنجاح تلقائياً.`,
          );
        } else {
          logEngine(
            "INFO",
            "PROMO_STILL_VALID",
            `[Trace: ${debugId}] كود الخصم المثبت مسبقاً ما زال سارياً ومتاحاً للاستخدام.`,
          );
        }
      }

      // 4️⃣ 🎰 مسار تفعيل الفترة التجريبية (TRIAL) بشكل معزول ومباشر
      if (rawPlan === "TRIAL") {
        logEngine(
          "INFO",
          "TRIAL_PATH_ACTIVATED",
          `[Trace: ${debugId}] السنتر يطلب تفعيل باقة تجريبية مجانية.`,
        );

        if (center.trialUsed) {
          logEngine(
            "WARN",
            "TRIAL_ALREADY_USED",
            `[Trace: ${debugId}] السنتر [${centerId}] حاول تكرار الفترة التجريبية وتم منعه.`,
          );
          return res.status(400).json({
            success: false,
            error:
              "عذراً، لقد استنفذ هذا السنتر التعليمي الفترة التجريبية المجانية المتاحة له مسبقاً بالكامل ولا يمكن تكرارها.",
          });
        }

        const trialLimits = PLAN_TIER_LIMITS.TRIAL || {
          maxStudents: 100,
          maxUsers: 3,
        };
        const calculatedTrialExpiry = calculateEndDate(null, "TRIAL");

        logEngine(
          "INFO",
          "TRIAL_TRANSACTION_START",
          `[Trace: ${debugId}] فتح معاملة ذرية ($transaction) لحقن الفترة التجريبية...`,
        );
        const trialPayment = await prisma.$transaction(async (tx) => {
          logEngine(
            "INFO",
            "TRIAL_TX_CREATE_PAYMENT",
            `[Trace: ${debugId}] 1. إنشاء سجل مالي صفرى للباقة التجريبية`,
          );
          const payment = await tx.payment.create({
            data: {
              centerId,
              amount: 0,
              plan: "TRIAL",
              status: PaymentStatus.SUCCESS,
              createdBy: userId || null,
              paymentMethod: "SYSTEM_TRIAL",
              paidAt: new Date(),
              activatedAt: new Date(),
              processedAt: new Date(),
              billingCycle: BillingCycle.MONTHLY,
              durationMonths: 1,
              planPrice: 0,
              transactionId: buildTransactionId("TRIAL"),
              metadata: {
                centerId,
                type: "SUBSCRIPTION",
                plan: "TRIAL",
                isTrial: true,
                systemTraceId: debugId,
              },
            },
          });

          logEngine(
            "INFO",
            "TRIAL_TX_UPDATE_CENTER",
            `[Trace: ${debugId}] 2. تحديث جدول السنتر بالحدود التجريبية وتاريخ الانتهاء: ${calculatedTrialExpiry.toISOString()}`,
          );
          await tx.center.update({
            where: { id: centerId },
            data: {
              trialUsed: true,
              trialStartedAt: new Date(),
              plan: "TRIAL",
              planExpiresAt: calculatedTrialExpiry,
              isActive: true,
              maxStudents: trialLimits.maxStudents,
              maxUsers: trialLimits.maxUsers,
            },
          });

          logEngine(
            "INFO",
            "TRIAL_TX_CREATE_SUB",
            `[Trace: ${debugId}] 3. إنشاء سجل اشتراك في جدول CenterSubscription`,
          );
          const sub = await tx.centerSubscription.create({
            data: {
              centerId,
              startDate: new Date(),
              endDate: calculatedTrialExpiry,
              isActive: true,
            },
          });

          logEngine(
            "INFO",
            "TRIAL_TX_LINK_SUB_PAYMENT",
            `[Trace: ${debugId}] 4. ربط الفاتورة بالاشتراك المنشأ رقم: ${sub.id}`,
          );
          return await tx.payment.update({
            where: { id: payment.id },
            data: { centerSubscriptionId: sub.id },
          });
        });

        logEngine(
          "SUCCESS",
          "TRIAL_ACTIVATION_SUCCESS",
          `[Trace: ${debugId}] تم تفعيل الباقة التجريبية بنجاح وإغلاق المعاملة الذرية.`,
        );
        return res.json({
          success: true,
          message:
            "تم تفعيل الباقة التجريبية للسنتر بنجاح وحقن الحدود الأمنية والتشغيلية للنظام بنجاح ✅",
          paymentId: trialPayment.id,
        });
      }

      // 5️⃣ 💳 حساب الوعاء المالي والأسعار المبدئية للطلب (باقات SaaS أو شحن محفظة الواتساب)
      let isWalletCharge = rawType === "WHATSAPP" || rawPlan === "WHATSAPP";
      let basePrice = 0;
      let finalAmount = 0;
      let tierConfig = null;

      logEngine(
        "INFO",
        "PRICING_ENGINE_START",
        `[Trace: ${debugId}] تشغيل محرك التسعير الاحترافي...`,
      );

      if (isWalletCharge) {
        const msgCount = toSafeInt(whatsappCount, 0);
        logEngine(
          "INFO",
          "WHATSAPP_CHARGE_DETECTED",
          `[Trace: ${debugId}] الطلب هو شحن رصيد رسائل واتساب. الكمية المطلوبة: ${msgCount}`,
        );

        if (!isValidPositiveNumber(msgCount)) {
          logEngine(
            "WARN",
            "INVALID_WHATSAPP_COUNT",
            `[Trace: ${debugId}] كمية رسائل الواتساب الممررة غير صالحة: ${whatsappCount}`,
          );
          return res.status(400).json({
            success: false,
            error:
              "يرجى تحديد كمية رسائل صالحة وموجبة تماماً لشحن محفظة المركز التعليمي",
          });
        }

        basePrice = Number((msgCount * WHATSAPP_PRICE).toFixed(2));
        finalAmount = basePrice;
        logEngine(
          "INFO",
          "WHATSAPP_PRICE_CALCULATED",
          `[Trace: ${debugId}] التكلفة المبدئية لشحن الرسائل: ${basePrice} ج.م (سعر الرسالة=${WHATSAPP_PRICE})`,
        );
      } else {
        logEngine(
          "INFO",
          "SAAS_PLAN_CHARGE_DETECTED",
          `[Trace: ${debugId}] الطلب هو اشتراك/تجديد باقة نظام SaaS القياسية.`,
        );
        tierConfig = PLAN_TIER_LIMITS[rawPlan];

        if (!tierConfig) {
          logEngine(
            "ERROR",
            "PLAN_NOT_FOUND_IN_CATALOG",
            `[Trace: ${debugId}] الباقة المطلوبة [${rawPlan}] غير معرّفة بكتالوج المنصة.`,
          );
          return res.status(400).json({
            success: false,
            error:
              "نوع الباقة المطلوبة غير مدرج بكتالوج أسعار خدمات النظام حالياً",
          });
        }

        basePrice = tierConfig.defaultPrice;
        logEngine(
          "INFO",
          "PLAN_BASE_PRICE",
          `[Trace: ${debugId}] السعر الأساسي الشهري للباقة [${rawPlan}] هو: ${basePrice} ج.م`,
        );

        if (cycle === "YEARLY") {
          basePrice = Number((basePrice * 9 * 0.85).toFixed(2));
          logEngine(
            "INFO",
            "YEARLY_DISCOUNT_APPLIED",
            `[Trace: ${debugId}] تم تطبيق خصم الدورة السنوية الحصري للمنصة. السعر السنوي الجديد المحتسب: ${basePrice} ج.م`,
          );
        }
        finalAmount = basePrice;
      }

      // 6️⃣ 🛡️ طرد وإسقاط الأكواد النشطة غير المتوافقة مع نوع دورة الطلب الحالية
      let promoCodeEvicted = false;
      let evictedCodeName = null;

      if (
        !isWalletCharge &&
        center.activePromoCodeId &&
        center.activePromoCode
      ) {
        const allowedCycle = center.activePromoCode.applicableCycle;
        logEngine(
          "INFO",
          "CHECKING_CYCLE_COMPATIBILITY",
          `[Trace: ${debugId}] فحص توافق كود السنتر النشط مع الطلب الحالي. المسموح به للكود=${allowedCycle}, المطلوب=${cycle}`,
        );

        if (
          allowedCycle !== BillingCycle.BOTH &&
          allowedCycle.toString() !== cycle
        ) {
          logEngine(
            "WARN",
            "CYCLE_MISMATCH_EVICTION_TRIGGERED",
            `[Trace: ${debugId}] عدم تطابق الدورة الحسابية! الكود مخصص لـ ${allowedCycle} والطلب الحالي ${cycle}. جاري إسقاط الكود فوراً...`,
          );

          await prisma.center.update({
            where: { id: centerId },
            data: {
              activePromoCodeId: null,
              promoMonthsUsed: 0,
              promoAppliedAt: null,
            },
          });

          promoCodeEvicted = true;
          evictedCodeName = center.activePromoCode.code;
          center.activePromoCodeId = null;
          center.activePromoCode = null;
          logEngine(
            "SUCCESS",
            "CYCLE_MISMATCH_EVICTION_DONE",
            `[Trace: ${debugId}] تم طرد وإسقاط الكود غير المتوافق [${evictedCodeName}] بنجاح منعاً للتلاعب ماليًا.`,
          );
        }
      }

      // 7️⃣ 🎁 نظام الإحالات (Referral System): حساب خصم واستهلاك الأشهر المجانية المستحقة
      let freeMonthsConsumed = 0;
      let freeMonthsDiscountAmount = 0;

      if (!isWalletCharge && center.pendingFreeMonths > 0) {
        logEngine(
          "INFO",
          "REFERRAL_FREE_MONTHS_DETECTED",
          `[Trace: ${debugId}] السنتر يمتلك رصيد أشهر مجانية معلقة بنظام الإحالات بمقدار: ${center.pendingFreeMonths} شهر.`,
        );

        if (cycle === "YEARLY") {
          freeMonthsConsumed = Math.min(center.pendingFreeMonths, 12);
          const effectiveMonthlyRate = basePrice / 12;
          freeMonthsDiscountAmount = Number(
            (effectiveMonthlyRate * freeMonthsConsumed).toFixed(2),
          );
          logEngine(
            "INFO",
            "REFERRAL_YEARLY_CALCULATION",
            `[Trace: ${debugId}] دورة سنوية: تستهلك ${freeMonthsConsumed} شهر مجاني. قيمة الخصم المقتطع: ${freeMonthsDiscountAmount} ج.م`,
          );
        } else {
          freeMonthsConsumed = 1;
          freeMonthsDiscountAmount = basePrice;
          logEngine(
            "INFO",
            "REFERRAL_MONTHLY_CALCULATION",
            `[Trace: ${debugId}] دورة شهرية: استهلاك شهر مجاني واحد بالكامل. قيمة الخصم المقتطع: ${freeMonthsDiscountAmount} ج.م`,
          );
        }

        finalAmount = Math.max(0, finalAmount - freeMonthsDiscountAmount);
        logEngine(
          "INFO",
          "PRICE_AFTER_REFERRAL",
          `[Trace: ${debugId}] المبلغ المالي المتبقي بعد اقتطاع رصيد الإحالات: ${finalAmount} ج.م`,
        );
      }

      // 8️⃣ 🧠 محرك تطبيق أكواد الخصم الجديدة أو مكافآت الإحالة الفورية
      let promoCodeId = null;
      let discountPercent = 0;
      let autoReferralDiscountApplied = false;
      let isExistingPromoAutoApplied = false;
      const isPromoPausedActive = center.isPromoPaused === true;

      logEngine(
        "INFO",
        "PROMO_ENGINE_EVALUATION",
        `[Trace: ${debugId}] بدء تقييم حقول الأكواد الترويجية والعروض الفورية. حالة إيقاف الخصم يدوياً=${isPromoPausedActive}`,
      );

      if (!isWalletCharge && finalAmount > 0 && !isPromoPausedActive) {
        const incomingCodeClean = promoCodeStr
          ? String(promoCodeStr).trim().toUpperCase()
          : null;

        if (center.activePromoCodeId && center.activePromoCode) {
          logEngine(
            "INFO",
            "APPLYING_EXISTING_ACTIVE_PROMO",
            `[Trace: ${debugId}] السنتر يحتوي على كود خصم ممتد مسبقاً [${center.activePromoCode.code}]. سيتم فرضه تلقائياً.`,
          );

          if (
            incomingCodeClean &&
            incomingCodeClean !== center.activePromoCode.code
          ) {
            logEngine(
              "WARN",
              "PROMO_COMBINATION_BLOCKED",
              `[Trace: ${debugId}] العميل حاول كتابة كود جديد [${incomingCodeClean}] مع وجود كود نشط مسبقاً. رفض المعاملة.`,
            );
            return res.status(400).json({
              success: false,
              error: `عذراً، لديك كود خصم ممتد ونشط مسبقاً بحسابك وهو [${center.activePromoCode.code}]. لا يمكنك دمج أو كتابة أكواد إضافية بنفس الوقت.`,
            });
          }

          discountPercent = center.activePromoCode.discountPercent;
          promoCodeId = center.activePromoCode.id;
          isExistingPromoAutoApplied = true;

          const discountAmount = finalAmount * (discountPercent / 100);
          finalAmount = Number((finalAmount - discountAmount).toFixed(2));
          logEngine(
            "SUCCESS",
            "EXISTING_PROMO_APPLIED",
            `[Trace: ${debugId}] تم تطبيق الكود المستمر بنجاح. نسبة الخصم: %${discountPercent}, السعر الجديد: ${finalAmount} ج.م`,
          );
        } else if (incomingCodeClean) {
          logEngine(
            "INFO",
            "VERIFYING_INCOMING_PROMO",
            `[Trace: ${debugId}] العميل كتب كود خصم جديد للتحقق منه: [${incomingCodeClean}]`,
          );

          const codeRecord = await prisma.promoCode.findUnique({
            where: { code: incomingCodeClean },
          });

          if (!codeRecord) {
            logEngine(
              "WARN",
              "PROMO_NOT_FOUND",
              `[Trace: ${debugId}] الكود المكتوب [${incomingCodeClean}] غير موجود بجدول الأكواد بالمنصة.`,
            );
            return res.status(400).json({
              success: false,
              error:
                "كود الخصم المكتوب غير موجود بكتالوج العروض أو غير مدعوم حالياً بنظام المنصة",
            });
          }
          if (codeRecord.expiresAt < new Date()) {
            logEngine(
              "WARN",
              "PROMO_EXPIRED_SYSTEM",
              `[Trace: ${debugId}] الكود المكتوب [${incomingCodeClean}] منتهي الصلاحية زمنياً بالمنصة.`,
            );
            return res.status(400).json({
              success: false,
              error:
                "عذراً، صلاحية استخدام كود الخصم المكتوب قد انتهت زمنياً بالمنصة",
            });
          }
          if (codeRecord.usedCount >= codeRecord.maxUses) {
            logEngine(
              "WARN",
              "PROMO_MAX_USES_REACHED",
              `[Trace: ${debugId}] الكود المكتوب [${incomingCodeClean}] استنفذ الحد الأقصى للاستخدام الكلي بالخادم: ${codeRecord.usedCount}/${codeRecord.maxUses}`,
            );
            return res.status(400).json({
              success: false,
              error:
                "لقد استنفذ كود الخصم هذا الحد الأقصى المسموح له من الاستخدامات الكلية على خوادم السيستم",
            });
          }

          const allowedCycle = codeRecord.applicableCycle;
          if (
            allowedCycle !== BillingCycle.BOTH &&
            allowedCycle.toString() !== cycle
          ) {
            logEngine(
              "WARN",
              "INCOMING_PROMO_CYCLE_MISMATCH",
              `[Trace: ${debugId}] الكود المكتوب مخصص لـ ${allowedCycle} والطلب الحالى ${cycle}`,
            );
            return res.status(400).json({
              success: false,
              error: `هذا الكود مخصص ومحجوز حصرياً لعمليات الاشتراك وتجديد الباقات من النوع البنائي ${allowedCycle} فقط`,
            });
          }

          discountPercent = codeRecord.discountPercent;
          promoCodeId = codeRecord.id;

          const discountAmount = finalAmount * (discountPercent / 100);
          finalAmount = Number((finalAmount - discountAmount).toFixed(2));
          logEngine(
            "SUCCESS",
            "INCOMING_PROMO_APPLIED",
            `[Trace: ${debugId}] تم توثيق وتطبيق الكود الجديد بنجاح. نسبة الخصم: %${discountPercent}, السعر الجديد: ${finalAmount} ج.م`,
          );
        } else if (center.referredById && !center.referralMilestoneAchieved) {
          logEngine(
            "INFO",
            "REFERRAL_DISCOUNT_CHECK",
            `[Trace: ${debugId}] السنتر مسجل عبر إحالة ولم يتم تحقيق الـ Milestone بعد. فحص عدد الدفعات السابقة...`,
          );

          const successfulPaymentsCount = await prisma.payment.count({
            where: {
              centerId,
              status: PaymentStatus.SUCCESS,
              NOT: { plan: "TRIAL" },
            },
          });

          if (successfulPaymentsCount < 2) {
            discountPercent = 20;
            autoReferralDiscountApplied = true;
            const discountAmount = finalAmount * (discountPercent / 100);
            finalAmount = Number((finalAmount - discountAmount).toFixed(2));
            logEngine(
              "SUCCESS",
              "AUTO_REFERRAL_DISCOUNT_APPLIED",
              `[Trace: ${debugId}] تم تطبيق خصم الإحالة التلقائي (%20) بنجاح. السنتر مسجل بدفعات ناجحة عدد: ${successfulPaymentsCount}`,
            );
          } else {
            logEngine(
              "INFO",
              "REFERRAL_DISCOUNT_SKIPPED",
              `[Trace: ${debugId}] تم تخطي خصم الإحالة التلقائي لأن السنتر تخطى حاجز أول دفعتين مسبقاً.`,
            );
          }
        }
      } else if (isPromoPausedActive) {
        logEngine(
          "WARN",
          "PROMO_PAUSED_ENFORCED_LOG",
          `[Trace: ${debugId}] تم تجاهل وتجميد تطبيق أي أكواد أو خصومات على هذا السنتر لوجود حظر نشط (isPromoPaused = true)`,
        );
      }

      // تقريب القيمة المالية النهائية وتوليد المرجع الفريد للمعاملة
      finalAmount = finalAmount <= 0 ? 0 : Math.round(finalAmount);
      const merchantReference = `SENTRYK-${centerId}-${Date.now()}`;
      logEngine(
        "INFO",
        "FINAL_AMOUNT_ROUNDED",
        `[Trace: ${debugId}] القيمة المالية النهائية المستقرة للطلب: ${finalAmount} ج.م | المرجع المالي: ${merchantReference}`,
      );

      // =========================================================================
      // 🛡️ [التفرع المباشر أ]: مسار الفواتير الصفرية وتفعيلها فورياً عبر الخادم مجاناً
      // =========================================================================
      if (finalAmount === 0) {
        logEngine(
          "INFO",
          "ZERO_AMOUNT_FLOW_TRIGGERED",
          `[Trace: ${debugId}] الفاتورة صفرية تماماً. بدء التفعيل التلقائي الفوري والمباشر داخل المعاملة الذرية لمنع الـ Race Conditions...`,
        );

        const activeSub = await prisma.centerSubscription.findFirst({
          where: { centerId, isActive: true },
          orderBy: { endDate: "desc" },
        });

        const calculatedExpiry = calculateEndDate(activeSub?.endDate, cycle);
        logEngine(
          "INFO",
          "ZERO_FLOW_SUB_EXPIRY",
          `[Trace: ${debugId}] تاريخ الانتهاء الجديد المحتسب للفاتورة الصفرية: ${calculatedExpiry.toISOString()}`,
        );

        const activatedPayment = await prisma.$transaction(async (tx) => {
          logEngine(
            "INFO",
            "ZERO_TX_CREATE_PAYMENT",
            `[Trace: ${debugId}] 1. إنشاء سجل الفاتورة بحالة SUCCESS مباشرة`,
          );
          const payment = await tx.payment.create({
            data: {
              centerId,
              amount: 0,
              plan: isWalletCharge ? "WHATSAPP" : rawPlan,
              status: PaymentStatus.SUCCESS,
              createdBy: userId || null,
              paymentMethod: "SYSTEM_FREE",
              paidAt: new Date(),
              activatedAt: new Date(),
              processedAt: new Date(),
              billingCycle: isWalletCharge
                ? null
                : cycle === "YEARLY"
                  ? BillingCycle.YEARLY
                  : BillingCycle.MONTHLY,
              durationMonths: isWalletCharge ? 1 : cycle === "YEARLY" ? 12 : 1,
              planPrice: basePrice,
              promoCodeId:
                isPromoPausedActive || promoCodeEvicted ? null : promoCodeId,
              transactionId: `FREE-${Date.now()}-${merchantReference.slice(-4)}`,
              merchantReference,
              metadata: {
                requestedType: rawType,
                billingCycle: cycle,
                basePriceBeforeAllDiscounts: basePrice,
                freeMonthsConsumed,
                freeMonthsDiscountAmount,
                discountAppliedPercent: discountPercent,
                isFreeInstantActivation: true,
                systemTraceId: debugId,
                merchantReference,
              },
            },
          });

          if (isWalletCharge) {
            const msgCount = toSafeInt(whatsappCount, 0);
            logEngine(
              "INFO",
              "ZERO_TX_WHATSAPP_BRANCH",
              `[Trace: ${debugId}] 2. شحن رصيد محفظة رسائل الواتساب بمقدار: ${msgCount}`,
            );

            const wallet = await tx.whatsAppWallet.upsert({
              where: { centerId },
              update: { balance: { increment: msgCount } },
              create: { centerId, balance: msgCount },
            });

            await tx.whatsAppTransaction.create({
              data: {
                walletId: wallet.id,
                amount: msgCount,
                type: "CHARGE",
                paymentId: payment.id,
                description: `شحن تلقائي معتمد ومجاني مالياً بمقدار ${msgCount} رسالة نتاج العروض الفورية`,
              },
            });

            await tx.center.update({
              where: { id: centerId },
              data: { whatsappBalance: { increment: msgCount } },
            });
          } else {
            logEngine(
              "INFO",
              "ZERO_TX_SAAS_BRANCH",
              `[Trace: ${debugId}] 2. تحديث صلاحيات السنتر واستهلاك أرصدة الأشهر المجانية المحتسبة مسبقاً...`,
            );

            await tx.center.update({
              where: { id: centerId },
              data: {
                plan: rawPlan,
                planExpiresAt: calculatedExpiry,
                isActive: true,
                maxStudents: tierConfig?.maxStudents || center.maxStudents,
                maxUsers: tierConfig?.maxUsers || center.maxUsers,
                pendingFreeMonths:
                  center.pendingFreeMonths > 0
                    ? center.pendingFreeMonths - freeMonthsConsumed
                    : 0,
              },
            });
          }

          let targetSubscriptionId = null;
          if (!isWalletCharge) {
            logEngine(
              "INFO",
              "ZERO_TX_MANAGE_SUBSCRIPTION",
              `[Trace: ${debugId}] 3. تحديث/إنشاء السجل في جدول الـ CenterSubscription`,
            );
            if (activeSub) {
              const updatedSub = await tx.centerSubscription.update({
                where: { id: activeSub.id },
                data: { endDate: calculatedExpiry, isActive: true },
              });
              targetSubscriptionId = updatedSub.id;
            } else {
              const createdSub = await tx.centerSubscription.create({
                data: {
                  centerId,
                  startDate: new Date(),
                  endDate: calculatedExpiry,
                  isActive: true,
                },
              });
              targetSubscriptionId = createdSub.id;
            }

            logEngine(
              "INFO",
              "ZERO_TX_LINK_SUB_BACK",
              `[Trace: ${debugId}] 4. ربط الفاتورة الصفرية بمعرف الاشتراك الجديد: ${targetSubscriptionId}`,
            );
            await tx.payment.update({
              where: { id: payment.id },
              data: { centerSubscriptionId: targetSubscriptionId },
            });
          }

          return payment;
        });

        logEngine(
          "SUCCESS",
          "ZERO_AMOUNT_ACTIVATION_COMPLETE",
          `[Trace: ${debugId}] تم تفعيل الفاتورة المجانية بالخلفية بنجاح وإرسال كائن الاستجابة السريعة ✅`,
        );
        return res.json({
          success: true,
          instantActivation: true,
          isFreeInstantActivation: true,
          paymentId: activatedPayment.id,
          amount: 0,
          message:
            "تم تفعيل الفاتورة وحقن مميزات السنتر مجاناً بنجاح للاستفادة الكاملة من رصيد الإحالة أو الخصومات المتاحة لحسابكم المالي ✅",
        });
      } else {
        // =========================================================================
        // 💳 [التفرع المباشر ب]: مسار الدفع الإلكتروني وبناء حمولة PAYMOB INTENTIONS API
        // =========================================================================
        logEngine(
          "INFO",
          "PAYMOB_FLOW_TRIGGERED",
          `[Trace: ${debugId}] الفاتورة تتطلب دفعاً مالياً خارجياً. جاري إعداد حمولة بوابة Paymob...`,
        );

        let paymobClientSecret = null;
        let paymobIntentionId = null;
        let paymobResponseData = null;
        const amountInCents = Math.round(finalAmount * 100);

        // هنا يكمن السحر الحامي ضد الضياع: حقن معرّف السنتر صراحةً في حقول الـ items المرسلة لـ Paymob لكي يقرأها الويب هوك حتماً
        const paymobPayload = {
          return_url: `${process.env.FRONTEND_URL}/checkout`,
          amount: amountInCents,
          currency: "EGP",
          payment_methods: [5589224,5603776],
          merchant_order_id: merchantReference,
          items: [
            {
              name: isWalletCharge
                ? `WhatsApp Refill | CID:${centerId}`
                : `Sentryk ${rawPlan} Sub | CID:${centerId}`,
              amount: amountInCents,
              description: isWalletCharge
                ? `شحن محفظة الواتساب لسنتر معرّف رقم: ${centerId}`
                : `تجديد باقة ${rawPlan} للسنتر معرّف رقم: ${centerId} - دورة ${cycle}`,
            },
          ],
          billing_data: {
            first_name: center.name.split(" ")[0] || "Center",
            last_name: center.name.split(" ")[1] || "Admin",
            email: req.user?.email || "billing@sentryk.com",
            phone_number: center.phone || "+201000000000",
            country: "EG",
            city: "Cairo",
            state: "Cairo",
            street: "Giza Street",
            building: "1",
            floor: "1",
            apartment: "1",
          },
          notification_url: process.env.PAYMOB_WEBHOOK_URL,
        };

        logEngine(
          "INFO",
          "SENDING_PAYMOB_API_REQUEST",
          `[Trace: ${debugId}] إرسال طلب الاتصال ببوابة الدفع (Intention API)...`,
          { payload: paymobPayload },
        );

        try {
          const paymobResponse = await axios.post(
            "https://accept.paymob.com/v1/intention/",
            paymobPayload,
            {
              headers: {
                Authorization: `Bearer ${process.env.PAYMOB_SECRET_KEY}`,
                "Content-Type": "application/json",
              },
            },
          );

          paymobResponseData = paymobResponse.data;
          paymobClientSecret = paymobResponseData.client_secret;
          paymobIntentionId = paymobResponseData.id;

          logEngine(
            "SUCCESS",
            "PAYMOB_API_RESPONSE_RECEIVED",
            `[Trace: ${debugId}] استجابة ناجحة من خوادم باي موب الخارجية. Intention ID: ${paymobIntentionId}`,
          );
        } catch (paymobErr) {
          logEngine(
            "ERROR",
            "PAYMOB_API_CALL_FAIL",
            `[Trace: ${debugId}] فشل حرج بالاتصال بـ Paymob API الخارجي: ${paymobErr.response?.data ? JSON.stringify(paymobErr.response.data) : paymobErr.message}`,
          );
          return res.status(502).json({
            success: false,
            error:
              "فشل الاتصال ببوابة الدفع الإلكتروني لباي موب، يرجى المحاولة مرة أخرى لاحقاً.",
          });
        }

        logEngine(
          "INFO",
          "CREATING_PENDING_PAYMENT_RECORD",
          `[Trace: ${debugId}] جاري تسجيل الفاتورة المعلقة (PENDING) في قاعدة البيانات الملحقة بالمنصة...`,
        );

        const pendingPayment = await prisma.payment.create({
          data: {
            centerId,
            amount: finalAmount,
            plan: isWalletCharge ? "WHATSAPP" : rawPlan,
            status: PaymentStatus.PENDING,
            createdBy: userId || null,
            promoCodeId:
              isPromoPausedActive || promoCodeEvicted ? null : promoCodeId,
            paymentMethod: "PAYMOB_FLASH",
            paymobIntentionId: paymobIntentionId, // حقل أساسي لربط الـ webhook فوراً لاحقاً بمسار الـ Intention
            transactionId: null,
            merchantReference: merchantReference, // حقل مرجعي فريد كخط دفاع كامل ومطابق لـ merchant_order_id
            billingCycle: isWalletCharge
              ? null
              : cycle === "YEARLY"
                ? BillingCycle.YEARLY
                : BillingCycle.MONTHLY,
            durationMonths: isWalletCharge ? 1 : cycle === "YEARLY" ? 12 : 1,
            planPrice: basePrice,
            metadata: {
              centerId,
              requestedType: rawType,
              isWalletCharge: isWalletCharge,
              whatsappCount: isWalletCharge ? toSafeInt(whatsappCount, 0) : 0,
              merchantReference,
              paymobIntentionId,
              paymobOrderId: paymobResponseData?.order?.id || null, // تخزينه للاحتياط فقط
              billingCycle: cycle,
              basePriceBeforeAllDiscounts: basePrice,
              freeMonthsConsumed,
              freeMonthsDiscountAmount,
              discountAppliedPercent: isPromoPausedActive ? 0 : discountPercent,
              isReferralDiscount: isPromoPausedActive
                ? false
                : autoReferralDiscountApplied,
              isExistingPromoAutoApplied: isPromoPausedActive
                ? false
                : isExistingPromoAutoApplied,
              isPromoPausedEnforced: isPromoPausedActive,
              promoCodeEvicted,
              evictedCodeName,
              systemTraceId: debugId,
              paymobClientSecret: paymobClientSecret,
              paymobPublicKey: process.env.PAYMOB_PUBLIC_KEY,
              checkoutUrl: `https://accept.paymob.com/unifiedcheckout/?publicKey=${process.env.PAYMOB_PUBLIC_KEY}&clientSecret=${paymobClientSecret}&merchant_order_id=${merchantReference}`,
            },
          },
        });

        logEngine(
          "SUCCESS",
          "ROUTE_CREATE_FINISHED_PERFECTLY",
          `[Trace: ${debugId}] تم الانتهاء من صياغة السجل وحفظه بالـ ID الداخلي للسيستم: ${pendingPayment.id}. توجيه المستخدم لصفحة الدفع...`,
        );

        return res.json({
          success: true,
          paymentId: pendingPayment.id,
          amount: finalAmount,
          clientSecret: paymobClientSecret,
          paymobIntentionId,
          walletCharge: isWalletCharge,
          promoCodeEvicted,
          freeMonthsConsumed,
          checkoutUrl: `https://accept.paymob.com/unifiedcheckout/?publicKey=${process.env.PAYMOB_PUBLIC_KEY}&clientSecret=${paymobClientSecret}&merchant_order_id=${merchantReference}`,
        });
      }
    } catch (err) {
      logEngine(
        "ERROR",
        "ROUTE_CREATE_FATAL",
        `[Trace: ${debugId}] خطأ كارثي ومفاجئ بصياغة المعاملة والطلب المالي الحرج للسيستم: ${err.message}`,
        { stack: err.stack },
      );
      return res.status(500).json({
        success: false,
        error: `فشل في صياغة الفاتورة البرمجية بالمخدم: ${err.message}`,
      });
    }
  },
);
// ===========================================================================
// ROUTE [4]: التفعيل اليدوي للمشرفين بإعادة استخدام محرك الخدمة الموحد (Manual Activation)
// ===========================================================================
router.post("/activate-manual", async (req, res) => {
  const debugId = buildTransactionId("MAN");
  logEngine(
    "INFO",
    "ROUTE_ACTIVATE_MANUAL",
    `طلب تفعيل إداري يدوي فوري للفاتورة من لوحة التحكم العليا [Trace: ${debugId}]`,
  );

  try {
    const { paymentId, adminEmail, adminPassword } = req.body || {};
    const parsedPaymentId = toSafeInt(paymentId);

    if (!parsedPaymentId || parsedPaymentId < 1) {
      return res.status(400).json({
        success: false,
        error:
          "معرّف عملية الدفع المستهدفة بالتفعيل يدوياً مفقود أو معطوب بالطلب",
      });
    }

    if (
      normalizeText(adminEmail) !== normalizeText(ADMIN_MOCK_EMAIL) ||
      String(adminPassword) !== String(ADMIN_MOCK_PASSWORD)
    ) {
      return res.status(401).json({
        success: false,
        error:
          "بيانات الإدارة العليا الممررة غير مطابقة لمعايير الأمان المالي والسيبراني للـ SaaS",
      });
    }

    const payment = await prisma.payment.findUnique({
      where: { id: parsedPaymentId },
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        error:
          "لم يتم العثور على سجل هذه الفاتورة المحددة بنظام خادم المنصة إطلاقاً",
      });
    }

    if (payment.status === PaymentStatus.SUCCESS) {
      return res.status(200).json({
        success: true,
        message:
          "هذه المعاملة مسجلة بالفعل كعملية ناجحة ومكتملة سابقاً ومحقونة الصلاحيات.",
        paymentId: payment.id,
      });
    }

    // 🚀 إعادة استخدام كود التفعيل الرئيسي والموحد لطبقة الخدمة لمنع تكرار الـ Business Logic نهائياً وبأمان تام
    const mockTxnId =
      payment.transactionId &&
      payment.transactionId !== payment.paymobIntentionId
        ? payment.transactionId
        : buildTransactionId("MAN-BYPASS");

    const updatedPayment = await PaymentService.processSuccessfulPayment(
      payment.id,
      mockTxnId,
    );

    return res.json({
      success: true,
      message:
        "تم تفعيل المعاملة الماليّة وحقن ميزات وحساب السنتر يدوياً بنجاح عبر محرك الخدمة الموحد وبأمان كامل ✅",
      paymentId: updatedPayment.id,
      status: updatedPayment.status,
    });
  } catch (err) {
    logEngine(
      "ERROR",
      "ROUTE_MANUAL_FATAL_EXCEPTION",
      `فشل التفعيل الإداري اليدوي للعملية الماليّة: ${err.message}`,
    );
    return res.status(500).json({
      success: false,
      error: `فشل حرج غير متوقع أثناء حقن وتعديل البيانات بالمخزن المالي: ${err.message}`,
    });
  }
});

// ===========================================================================
// ROUTE [5]: معاينة فنية تفصيلية للفاتورة لمنع النصب وبناء التقارير الماليّة (Preview Engine)
// ===========================================================================
router.post("/preview", async (req, res) => {
  try {
    const { paymentId, adminEmail, adminPassword } = req.body || {};
    const parsedPaymentId = toSafeInt(paymentId);

    if (!parsedPaymentId || parsedPaymentId < 1) {
      return res.status(400).json({
        success: false,
        error: "معرّف عملية الدفع المستهدفة بالمعاينة مفقود بالطلب",
      });
    }

    if (
      normalizeText(adminEmail) !== normalizeText(ADMIN_MOCK_EMAIL) ||
      String(adminPassword) !== String(ADMIN_MOCK_PASSWORD)
    ) {
      return res.status(401).json({
        success: false,
        error:
          "صلاحية مرفوضة محاسبياً: بيانات الحماية والعبور غير مطابقة للمشرفين الأدمن",
      });
    }

    const payment = await prisma.payment.findUnique({
      where: { id: parsedPaymentId },
      include: { center: true, promoCode: true },
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: "لم يتم العثور على سجل الفاتورة المحددة بالسيستم للمعاينة",
      });
    }

    const metadata = safeJsonMetadata(payment.metadata);

    return res.json({
      success: true,
      preview: {
        paymentId: payment.id,
        centerId: payment.centerId,
        centerName: payment.center.name,
        status: payment.status,
        requestedPlan: payment.plan,
        billingCycle: metadata.billingCycle || "MONTHLY",
        createdAt: payment.createdAt,
        paymobIntentionId: payment.paymobIntentionId,
        transactionId: payment.transactionId,
        merchantReference: payment.merchantReference,
        financialBreakdown: {
          basePriceBeforeAllDiscounts:
            metadata.basePriceBeforeAllDiscounts || payment.amount,
          freeMonthsConsumed: metadata.freeMonthsConsumed || 0,
          freeMonthsDiscountAmount: metadata.freeMonthsDiscountAmount || 0,
          discountAppliedPercent: metadata.discountAppliedPercent || 0,
          finalPriceSavedInDb: payment.amount,
          promoCodeEvictedInCreation: metadata.promoCodeEvicted || false,
          evictedCodeName: metadata.evictedCodeName || null,
          createdByWebhookFallback: metadata.createdByWebhookFallback || false,
        },
        promoCodeDetails: payment.promoCode
          ? {
              code: payment.promoCode.code,
              discountPercent: payment.promoCode.discountPercent,
              durationMonths: payment.promoCode.durationMonths,
            }
          : null,
      },
    });
  } catch (err) {
    logEngine(
      "ERROR",
      "ROUTE_PREVIEW_ERROR",
      `فشل نظام المعاينة الفنية العميقة للفواتير: ${err.message}`,
    );
    return res.status(500).json({
      success: false,
      error: `فشل حرج داخل نظام المعاينة الفنية المحاسبية: ${err.message}`,
    });
  }
});

// ===========================================================================
// ROUTE [6]: ربط السنتر بكود إحالة صديق مع الحماية الفولاذية من الهجمات الدائرية (Referral Binding)
// ===========================================================================
router.post(
  "/bind-referral",
  authenticateToken,
  requireCenterAccess,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { referralCode } = req.body || {};
      const centerId = Number(req.user?.centerId);

      if (!referralCode) {
        return res.status(400).json({
          success: false,
          error:
            "كود الدعوة أو الإحالة مطلوب وصارم لتنفيذ عملية الربط الحسابي بالخادم",
        });
      }

      const cleanRefCode = String(referralCode).trim();
      const currentCenter = await prisma.center.findUnique({
        where: { id: centerId },
      });

      if (!currentCenter) {
        return res.status(404).json({
          success: false,
          error: "السنتر الحالي للطلب غير مسجل أو معرف بنظام السيستم",
        });
      }

      if (currentCenter.referredById) {
        return res.status(400).json({
          success: false,
          error:
            "عذراً فادحاً، هذا السنتر التعليمي مسجل بالفعل كطرف محال ومربوط بواسطة سنتر آخر مسبقاً ولا يمكن تعديله",
        });
      }

      const targetReferrerCenter = await prisma.center.findUnique({
        where: { referralCode: cleanRefCode },
      });

      if (!targetReferrerCenter) {
        return res.status(404).json({
          success: false,
          error:
            "كود الإحالة المكتوب غير تابع لأي سنتر تعليمي مسجل أو نشط بنظام المنصة حالياً",
        });
      }

      if (targetReferrerCenter.id === centerId) {
        return res.status(400).json({
          success: false,
          error:
            "عملية مرفوضة منطقياً وحسابياً: لا يمكنك استخدام كود حسابك الشخصي لتقديم دعوة لنفسك ⛔",
        });
      }

      if (targetReferrerCenter.referredById === centerId) {
        return res.status(400).json({
          success: false,
          error:
            "خرق منطقي دائري: لا يمكن إتمام الربط التبادلي الدائري بين نفس المراكز لحماية توازن واستقرار تداولات حسابات المنصة 🔄",
        });
      }

      await prisma.center.update({
        where: { id: centerId },
        data: { referredById: targetReferrerCenter.id },
      });

      return res.json({
        success: true,
        message: `تم ربط حسابك بنجاح كمدعو رسمي بواسطة سنتر [${targetReferrerCenter.name}]، وستستمتع بمزايا ترحيبية وخصومات تلقائياً عند أول سداد فعلي للباقات ✅`,
      });
    } catch (err) {
      logEngine(
        "ERROR",
        "ROUTE_REFERRAL_BIND_ERROR",
        `فشل ربط وتوثيق كود الإحالة بمخزن البيانات: ${err.message}`,
      );
      return res.status(500).json({
        success: false,
        error: `فشل داخلي بالمخزن المحاسبي أثناء ربط كود الإحالة للسنتر: ${err.message}`,
      });
    }
  },
);

module.exports = router;
