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

// ===========================================================================
// الإعدادات والثوابت التشغيلية للمنصة
// ===========================================================================
const ADMIN_MOCK_EMAIL = process.env.ADMIN_MOCK_EMAIL || "ymslm120@gmail.com";
const ADMIN_MOCK_PASSWORD = process.env.ADMIN_MOCK_PASSWORD || "Youssef2011";
const WHATSAPP_PRICE = Number.parseFloat(
  process.env.CHARGE_WHATSAPP_PRICE_PER_MESSAGE || "0.40",
);
const DEBUG_PAYMENTS = process.env.DEBUG_PAYMENTS !== "false";

// جدول إعدادات باقات الـ SaaS والحدود الأمنية الصارمة لكل فئة
const PLAN_TIER_LIMITS = {
  TRIAL: { maxStudents: 100, maxUsers: 3, defaultPrice: 0 },
  BASIC: { maxStudents: 250, maxUsers: 4, defaultPrice: 499 },
  PREMIUM: { maxStudents: 1000, maxUsers: 10, defaultPrice: 999 },
  ELITE: { maxStudents: 3000000, maxUsers: 25000, defaultPrice: 1499 },
};

function logEngine(...args) {
  if (DEBUG_PAYMENTS) {
    console.log("⚡ [PLANS-BILLING-ENGINE]", ...args);
  }
}

// ===========================================================================
// أدوات المساعدة والتحقق والتطهير البرمجي (Helpers)
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

// ===========================================================================
// 🚀 [1] راوت إنشاء الطلبات وفواتير الدفع والخصومات (Invoice & Checkout Generator)
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
          payment_methods: [5589224],
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
// 🛠️ [2] التفعيل المالي وحقن المكافآت اليدوي بواسطة الإدارة (Manual Super-Admin Override)
// ===========================================================================
router.post("/activate-manual", async (req, res) => {
  const debugId = buildTransactionId("ACT");
  console.log(
    `\n=================== [START MANUAL OVERRIDE ACTIVATION: ${debugId}] ===================`,
  );

  try {
    const { paymentId, adminEmail, adminPassword } = req.body || {};
    const parsedPaymentId = toSafeInt(paymentId);

    console.log(
      `[STAGE 1: EVALUATION] Target Payment ID: ${parsedPaymentId}, Invoking Auth Claim Email: ${adminEmail}`,
    );

    if (!parsedPaymentId || parsedPaymentId < 1) {
      console.warn(`⚠️ [STAGE 1: BLOCKED] Invalid target payment ID format.`);
      return res
        .status(400)
        .json({
          success: false,
          error: "معرّف عملية الدفع المستهدفة مفقود أو معطوب",
        });
    }

    if (
      normalizeText(adminEmail) !== normalizeText(ADMIN_MOCK_EMAIL) ||
      String(adminPassword) !== String(ADMIN_MOCK_PASSWORD)
    ) {
      console.error(
        `🚨 [STAGE 1: SECURITY ALERT] Unauthorized manual override breach attempt.`,
      );
      return res
        .status(401)
        .json({
          success: false,
          error:
            "بيانات الإدارة العليا الممررة غير مطابقة لمعايير الأمان للـ SaaS",
        });
    }

    console.log(
      `[STAGE 2: DB LOOKUP] Loading raw ledger context for Payment ID: ${parsedPaymentId}`,
    );
    const payment = await prisma.payment.findUnique({
      where: { id: parsedPaymentId },
      include: { center: true, promoCode: true },
    });

    if (!payment) {
      console.error(`❌ [STAGE 2: NOT FOUND] No payment entry discovered.`);
      return res
        .status(404)
        .json({
          success: false,
          error: "لم يتم العثور على الفاتورة المحددة بنظام المخدّم",
        });
    }

    if (payment.status === PaymentStatus.SUCCESS) {
      console.log(
        `ℹ️ [STAGE 2: IDEMPOTENT] Target record is already successful. Squelching duplicate process.`,
      );
      return res
        .status(200)
        .json({
          success: true,
          message: "هذه العملية مسجلة بالفعل كعملية ناجحة ومكتملة سابقاً",
          paymentId: payment.id,
        });
    }

    const metadata = safeJsonMetadata(payment.metadata);
    const planName = normalizeText(payment.plan);
    const isWhatsappCharge =
      planName === "WHATSAPP" ||
      normalizeText(metadata.requestedType) === "WHATSAPP";

    console.log(
      `[STAGE 3: PARSING MATRIX] Plan Type: ${planName}, isWhatsappCharge: ${isWhatsappCharge}`,
    );

    const transactionSummary = await prisma.$transaction(async (tx) => {
      console.log(
        `[TX-OVERRIDE: INITIALIZED] Running atomic schema transformations.`,
      );

      if (
        payment.promoCodeId &&
        !metadata.isExistingPromoAutoApplied &&
        !metadata.isPromoPausedEnforced
      ) {
        console.log(
          `[TX-OVERRIDE: PROMO COUNTER] Scaling promo usage metrics upwards.`,
        );
        await tx.promoCode.update({
          where: { id: payment.promoCodeId },
          data: { usedCount: { increment: 1 } },
        });
      }

      if (metadata.freeMonthsConsumed && metadata.freeMonthsConsumed > 0) {
        console.log(
          `[TX-OVERRIDE: REFERRAL DEBIT] Deducting promotional free balances.`,
        );
        await tx.center.update({
          where: { id: payment.centerId },
          data: {
            pendingFreeMonths: { decrement: metadata.freeMonthsConsumed },
          },
        });
      }

      if (isWhatsappCharge) {
        console.log(
          `[TX-OVERRIDE: WHATSAPP FLAVOR] Syncing infrastructure wallet metrics.`,
        );
        let messageCount = toSafeInt(metadata.whatsappCount, 0);
        if (
          messageCount <= 0 &&
          isValidPositiveNumber(payment.amount) &&
          isValidPositiveNumber(WHATSAPP_PRICE)
        ) {
          messageCount = Math.max(
            1,
            Math.round(payment.amount / WHATSAPP_PRICE),
          );
        }

        const wallet = await tx.whatsappWallet.upsert({
          where: { centerId: payment.centerId },
          update: { balance: { increment: messageCount } },
          create: { centerId: payment.centerId, balance: messageCount },
        });

        await tx.whatsAppTransaction.create({
          data: {
            walletId: wallet.id,
            amount: messageCount,
            type: "CHARGE",
            paymentId: payment.id,
            description: `شحن محفظة الواتساب بمقدار ${messageCount} رسالة يدويّاً`,
          },
        });

        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.SUCCESS,
            paidAt: new Date(),
            transactionId:
              payment.transactionId || buildTransactionId("MAN-WA"),
          },
        });

        return {
          type: "WHATSAPP",
          messagesCharged: messageCount,
          targetCenter: payment.centerId,
        };
      } else {
        console.log(
          `[TX-OVERRIDE: SUBSCRIPTION FLAVOR] Calculating structural time parameters.`,
        );
        const tierLimits = PLAN_TIER_LIMITS[planName] || PLAN_TIER_LIMITS.BASIC;

        const activeSub = await tx.centerSubscription.findFirst({
          where: { centerId: payment.centerId, isActive: true },
          orderBy: { endDate: "desc" },
        });

        const calculatedExpiry = calculateEndDate(
          activeSub?.endDate,
          metadata.billingCycle || "MONTHLY",
        );
        console.log(
          `[TX-OVERRIDE: TIME BOUNDS] Existing Sub End: ${activeSub?.endDate || "None"}, New Bound: ${calculatedExpiry}`,
        );

        let targetSubscriptionId;
        if (activeSub) {
          console.log(
            `[TX-OVERRIDE: SUB MUTATION] Extending active contract schema row.`,
          );
          const updatedSub = await tx.centerSubscription.update({
            where: { id: activeSub.id },
            data: { endDate: calculatedExpiry, isActive: true },
          });
          targetSubscriptionId = updatedSub.id;
        } else {
          console.log(
            `[TX-OVERRIDE: SUB MUTATION] Spawning baseline contract track.`,
          );
          const createdSub = await tx.centerSubscription.create({
            data: {
              centerId: payment.centerId,
              startDate: new Date(),
              endDate: calculatedExpiry,
              isActive: true,
            },
          });
          targetSubscriptionId = createdSub.id;
        }

        await tx.center.update({
          where: { id: payment.centerId },
          data: {
            plan: planName,
            maxStudents: tierLimits.maxStudents,
            maxUsers: tierLimits.maxUsers,
          },
        });

        // [لوجيك الخصم المعقد 6]: تتبع وحقن الحالات الخاصة بالأكواد الترويجية متعددة الأشهر الممتدة
        if (
          payment.promoCodeId &&
          payment.promoCode &&
          !metadata.isPromoPausedEnforced
        ) {
          const duration = payment.promoCode.durationMonths;
          console.log(
            `[TX-OVERRIDE: PROMO CYCLE STEP] Processing extended rules code: ${payment.promoCode.code}, Max Length: ${duration}`,
          );

          if (payment.center.activePromoCodeId === payment.promoCodeId) {
            const nextMonthsUsed = payment.center.promoMonthsUsed + 1;
            if (nextMonthsUsed >= duration) {
              console.log(
                `[TX-OVERRIDE: PROMO EXHAUSTED] Multi-month cap reached. Purging promo lock.`,
              );
              await tx.center.update({
                where: { id: payment.centerId },
                data: {
                  activePromoCodeId: null,
                  promoMonthsUsed: 0,
                  promoAppliedAt: null,
                },
              });
            } else {
              console.log(
                `[TX-OVERRIDE: PROMO STEP ADVANCED] Incrementing tenure count to ${nextMonthsUsed}`,
              );
              await tx.center.update({
                where: { id: payment.centerId },
                data: { promoMonthsUsed: nextMonthsUsed },
              });
            }
          } else if (duration > 1) {
            console.log(
              `[TX-OVERRIDE: PROMO INCEPTION] Binding multi-month promo blueprint to center row.`,
            );
            await tx.center.update({
              where: { id: payment.centerId },
              data: {
                activePromoCodeId: payment.promoCodeId,
                promoMonthsUsed: 1,
                promoAppliedAt: new Date(),
              },
            });
          }
        }

        // [لوجيك الخصم المعقد 7]: معالجة مكافآت نظام الإحالة (Referral System) للسنتر الداعي
        let referralTriggered = false;
        let referrerCenterId = payment.center.referredById;

        if (
          referrerCenterId &&
          !payment.center.referralMilestoneAchieved &&
          !metadata.isPromoPausedEnforced
        ) {
          console.log(
            `[TX-OVERRIDE: REFERRAL SYSTEM EVAL] Center was referred by Parent Center ID: ${referrerCenterId}. Checking historical conversions.`,
          );
          const successfulPaymentsCount = await tx.payment.count({
            where: {
              centerId: payment.centerId,
              status: PaymentStatus.SUCCESS,
              NOT: { plan: "TRIAL" },
            },
          });

          if (successfulPaymentsCount === 0) {
            referralTriggered = true;
            console.log(
              `[TX-OVERRIDE: REFERRAL MILESTONE VALIDATED] Awarding 1 free month voucher to Parent Center.`,
            );
            await tx.center.update({
              where: { id: payment.centerId },
              data: { referralMilestoneAchieved: true },
            });
            await tx.center.update({
              where: { id: referrerCenterId },
              data: {
                referralCount: { increment: 1 },
                pendingFreeMonths: { increment: 1 },
              },
            });
          }
        }

        console.log(
          `[TX-OVERRIDE: COMPLETED] Resolving payment record row fields.`,
        );
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.SUCCESS,
            paidAt: new Date(),
            centerSubscriptionId: targetSubscriptionId,
            transactionId:
              payment.transactionId || buildTransactionId("MAN-SUB"),
          },
        });

        return {
          type: "SUBSCRIPTION",
          plan: planName,
          maxStudents: tierLimits.maxStudents,
          maxUsers: tierLimits.maxUsers,
          expiryDate: calculatedExpiry,
          referralTriggered,
        };
      }
    });

    console.log(
      `✅ [MANUAL OVERRIDE TRANSACTION DISPATCH SUCCESS] System State Mutated.`,
    );
    return res.json({
      success: true,
      message: "تم تفعيل المعاملة المالية وحقن الميزات يدوياً بنجاح ✅",
      data: transactionSummary,
    });
  } catch (err) {
    console.error(`❌ [MANUAL OVERRIDE SYSTEM CRITICAL FAULT]:`, err);
    return res
      .status(500)
      .json({
        success: false,
        error: `فشل حرج أثناء حقن البيانات بالمخزن المالي: ${err.message}`,
      });
  } finally {
    console.log(
      `=================== [END MANUAL OVERRIDE ACTIVATION: ${debugId}] ===================\n`,
    );
  }
});

// ===========================================================================
// 🛡️ [3] معاينة تفصيلية لبيانات وتخفيضات الفاتورة (Anti-Fraud Preview Engine)
// ===========================================================================
router.post("/preview", async (req, res) => {
  console.log(
    `\n=================== [INBOUND PREVIEW AUDIT REQUEST] ===================`,
  );
  try {
    const { paymentId, adminEmail, adminPassword } = req.body || {};
    const parsedPaymentId = toSafeInt(paymentId);

    console.log(
      `[PREVIEW AUDIT] Fetching diagnostic fields for Payment: ${parsedPaymentId}`,
    );

    if (!parsedPaymentId || parsedPaymentId < 1) {
      return res
        .status(400)
        .json({ success: false, error: "معرّف عملية الدفع المستهدفة مفقود" });
    }

    if (
      normalizeText(adminEmail) !== normalizeText(ADMIN_MOCK_EMAIL) ||
      String(adminPassword) !== String(ADMIN_MOCK_PASSWORD)
    ) {
      console.error(`🚨 [PREVIEW AUDIT: BLOCKED] Credentials bad handshake.`);
      return res
        .status(401)
        .json({
          success: false,
          error: "صلاحية مرفوضة: بيانات الحماية غير مطابقة",
        });
    }

    const payment = await prisma.payment.findUnique({
      where: { id: parsedPaymentId },
      include: { center: true, promoCode: true },
    });

    if (!payment) {
      console.error(`❌ [PREVIEW AUDIT: FAILED] Reference record absent.`);
      return res
        .status(404)
        .json({ success: false, error: "لم يتم العثور على الفاتورة المحددة" });
    }

    const metadata = safeJsonMetadata(payment.metadata);
    console.log(
      `🚀 [PREVIEW AUDIT: SUCCESS] Extracted full structural analytics object.`,
    );

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
    console.error("❌ [PREVIEW ENGINE FAULT]:", err);
    return res
      .status(500)
      .json({
        success: false,
        error: `فشل نظام المعاينة الفنية: ${err.message}`,
      });
  } finally {
    console.log(
      `=================== [END PREVIEW AUDIT REQUEST] ===================\n`,
    );
  }
});

// ===========================================================================
// 🔄 [4] ربط السنتر بكود إحالة صديق مع الحماية الصارمة من الهجمات الدائرية والتبادلية
// ===========================================================================
router.post(
  "/bind-referral",
  authenticateToken,
  requireCenterAccess,
  requireRole(["ADMIN"]),
  async (req, res) => {
    console.log(
      `\n=================== [INBOUND REFERRAL LINKING ATTEMPT] ===================`,
    );
    try {
      const { referralCode } = req.body || {};
      const centerId = Number(req.user?.centerId);

      console.log(
        `[REFERRAL BIND: ARGS] Center: ${centerId}, Input Referral Token String: "${referralCode}"`,
      );

      if (!referralCode) {
        return res
          .status(400)
          .json({
            success: false,
            error: "كود الدعوة أو الإحالة مطلوب لتنفيذ عملية الربط",
          });
      }

      const cleanRefCode = String(referralCode).trim();

      const currentCenter = await prisma.center.findUnique({
        where: { id: centerId },
      });
      if (!currentCenter) {
        console.error(
          `❌ [REFERRAL BIND: FAULT] Active node consumer missing.`,
        );
        return res
          .status(404)
          .json({ success: false, error: "السنتر الحالي غير مسجل بالنظام" });
      }

      if (currentCenter.referredById) {
        console.warn(
          `⚠️ [REFERRAL BIND: BLOCKED] Node has already been linked to a referral source.`,
        );
        return res
          .status(400)
          .json({
            success: false,
            error:
              "عذراً، هذا السنتر مسجل بالفعل كطرف محال بواسطة سنتر آخر مسبقاً",
          });
      }

      const targetReferrerCenter = await prisma.center.findUnique({
        where: { referralCode: cleanRefCode },
      });
      if (!targetReferrerCenter) {
        console.warn(
          `⚠️ [REFERRAL BIND: BLOCKED] External code doesn't match any registered center.`,
        );
        return res
          .status(404)
          .json({
            success: false,
            error: "كود الإحالة المكتوب غير تابع لأي سنتر مسجل بالنظام حالياً",
          });
      }

      if (targetReferrerCenter.id === centerId) {
        console.error(
          `🚨 [REFERRAL BIND: FRAUD DETECTION] Self-referral loops are prohibited.`,
        );
        return res
          .status(400)
          .json({
            success: false,
            error:
              "عملية مرفوضة منطقياً: لا يمكنك استخدام كود حسابك لتقديم دعوة لنفسك ⛔",
          });
      }

      if (targetReferrerCenter.referredById === centerId) {
        console.error(
          `🚨 [REFERRAL BIND: FRAUD DETECTION] Mutual circular back-scratching referral links intercepted.`,
        );
        return res
          .status(400)
          .json({
            success: false,
            error:
              "خرق منطقي: لا يمكن إتمام الربط التبادلي الدائري بين نفس المراكز لحماية توازن المنصة 🔄",
          });
      }

      console.log(
        `[REFERRAL BIND: PERSISTING] Writing parent pointer reference mapping.`,
      );
      await prisma.center.update({
        where: { id: centerId },
        data: { referredById: targetReferrerCenter.id },
      });

      console.log(
        `✅ [REFERRAL BIND: COMPLETE SUCCESS] Center ${centerId} linked to Parent Center ${targetReferrerCenter.id}`,
      );
      return res.json({
        success: true,
        message: `تم ربط حسابك بنجاح كمدعو بواسطة [${targetReferrerCenter.name}]، وستستمتع بمزايا ترحيبية تلقائياً عند أول سداد للباقات ✅`,
      });
    } catch (err) {
      console.error("❌ [REFERRAL PIPELINE FATAL ERROR]:", err);
      return res
        .status(500)
        .json({
          success: false,
          error: `فشل داخلي بالمخزن أثناء ربط كود الإحالة: ${err.message}`,
        });
    } finally {
      console.log(
        `=================== [END REFERRAL LINKING ATTEMPT] ===================\n`,
      );
    }
  },
);

module.exports = router;
