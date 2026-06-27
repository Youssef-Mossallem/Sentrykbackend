const express = require("express");
const jwt = require("jsonwebtoken");
const { PrismaClient, BillingCycle, PaymentStatus } = require("@prisma/client");

const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// ===========================================================================
// Infrastructure Guard Config (جدار الحماية المطلق للأكواد البرمجية من الـ .env)
// ===========================================================================
const SUPER_ADMIN_KEY = process.env.SENTRYK_SUPER_ADMIN_KEY || "Sentryk_Master_Key_2026_Prod";
const SUPER_ADMIN_SECRET = process.env.SENTRYK_SUPER_ADMIN_SECRET || "SuperSecurePassphrase_For_PromoCodes_9981!!";

/**
 * ميدلوير أمني صارم لبنية الـ SaaS الفوقية (Super Admin Infrastructure Guard)
 * يقوم بفحص ترويسات الطلب (Headers) للتحقق من المفاتيح السرية للبنية التحتية للمنصة
 */
function requireInfrastructureAccess(req, res, next) {
  const clientKey = req.headers["x-sentryk-admin-key"];
  const clientSecret = req.headers["x-sentryk-admin-secret"];

  if (!clientKey || !clientSecret) {
    return res.status(401).json({
      success: false,
      error: "خرق أمني: ترويسات الحماية الكبرى للـ SaaS مفقودة من هذا الطلب 🛡️"
    });
  }

  if (String(clientKey).trim() !== String(SUPER_ADMIN_KEY).trim() || String(clientSecret).trim() !== String(SUPER_ADMIN_SECRET).trim()) {
    return res.status(403).json({
      success: false,
      error: "صلاحية مرفوضة: مفاتيح البنية التحتية السرية الممررة غير مطابقة لمعايير الأمان ⛔"
    });
  }

  next();
}

/**
 * 🔐 ميدلوير هجين ومطور لحل مشكلة تعارض الـ JWT (Dual Auth Guard)
 * يسمح بالوصول إما عن طريق توكن السوبر أدمن الخاص بالخزنة الكبرى، أو عن طريق نظام الأدمن المشفر بـ JWT_SECRET الخاص بالمنصة
 */
function authenticatePromoAction(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ success: false, error: "صلاحيات غير كافية: التوكن الأمني مفقود 🛡️" });
  }

  // 1. محاولة التحقق أولاً باستخدام سيكرت الخزنة الكبرى للسوبر أدمن
  jwt.verify(token, process.env.SUPER_ADMIN_JWT_SECRET || "SuperAdminMegaSecret2026", (err, decodedPayload) => {
    if (!err && decodedPayload && decodedPayload.isSuperAdmin) {
      req.superAdmin = decodedPayload;
      req.isSuperAdmin = true;
      return next(); // تم التوثيق بنجاح كسوبر أدمن، مرر الطلب فوراً
    }

    // 2. إذا فشل، نحاول التحقق باستخدام السيكرت العادي للمنصة (المدرسين والأدمن العادي)
    jwt.verify(token, process.env.JWT_SECRET || "NormalSentrykSecretKeyXYZ", (normalErr, normalDecoded) => {
      if (normalErr) {
        return res.status(403).json({ 
          success: false, 
          error: "❌ JWT Verification Failed: انتهت صلاحية الجلسة الأمنية أو التوكن غير شرعي" 
        });
      }
      
      req.user = normalDecoded;
      req.isSuperAdmin = false;
      next();
    });
  });
}

// ===========================================================================
// Utilities & Validation Helpers (أدوات الحماية والتطهير البرمجي)
// ===========================================================================
function cleanAndNormalizeCode(code) {
  if (!code) return "";
  return String(code).trim().toUpperCase().replace(/[^A-Z0-9]/g, ""); // تنظيف الكود وجعله أحرف كبيرة وأرقام فقط ديفاعياً
}

// ===========================================================================
// [1] إنشاء كود خصم جديد (CREATE) - لوحة تحكم السوبر أدمن أو البنية التحتية
// ===========================================================================
router.post("/create", authenticatePromoAction, async (req, res) => {
  try {
    // التأكد من أن المستدعي إما سوبر أدمن أو أدمن عادي يمتلك مفاتيح البنية التحتية الإمبراطورية في الهيدرز
    if (!req.isSuperAdmin) {
      const clientKey = req.headers["x-sentryk-admin-key"];
      const clientSecret = req.headers["x-sentryk-admin-secret"];
      if (String(clientKey).trim() !== String(SUPER_ADMIN_KEY).trim() || String(clientSecret).trim() !== String(SUPER_ADMIN_SECRET).trim()) {
        return res.status(403).json({ success: false, error: "صلاحية مرفوضة: غير مصرح لك بإنشاء أكواد الخصم الهيكلية ⛔" });
      }
    }

    const { code, discountPercent, durationMonths, applicableCycle, maxUses, expiresAt } = req.body || {};

    const cleanCode = cleanAndNormalizeCode(code);
    const parsedDiscount = Number.parseFloat(discountPercent);
    const parsedDuration = Number.parseInt(durationMonths, 10) || 1;
    const parsedMaxUses = Number.parseInt(maxUses, 10) || 100;

    // أ: التحقق الصارم من صحة البيانات الحسابية المدخلة ديفاعياً ضد قيم الـ NaN والـ Null والـ Overflows
    if (!cleanCode || cleanCode.length < 3) {
      return res.status(400).json({ success: false, error: "رمز كود الخصم غير صالح أو قصير جداً (يجب ألا يقل عن 3 رموز)" });
    }

    if (Number.isNaN(parsedDiscount) || parsedDiscount <= 0 || parsedDiscount > 100) {
      return res.status(400).json({ success: false, error: "نسبة الخصم يجب أن تكون رقماً موجباً حقيقياً بين 0.1 و 100" });
    }

    if (Number.isNaN(parsedDuration) || parsedDuration <= 0) {
      return res.status(400).json({ success: false, error: "عدد شهور صلاحية تطبيق الخصم يجب أن تكون شهراً واحداً على الأقل" });
    }

    if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) {
      return res.status(400).json({ success: false, error: "تاريخ انتهاء صلاحية الكود مفقود أو غير صحيح زمنيًا" });
    }

    if (new Date(expiresAt) <= new Date()) {
      return res.status(400).json({ success: false, error: "تاريخ الانتهاء الزمني للكود يجب أن يكون في المستقبل الحتمي" });
    }

    // ب: التحقق من توافق دورة الفاتورة مع الـ Enum المسجل بدقة في السكيما (MONTHLY, YEARLY, BOTH)
    let cycle = BillingCycle.BOTH;
    if (String(applicableCycle).toUpperCase() === "MONTHLY") cycle = BillingCycle.MONTHLY;
    if (String(applicableCycle).toUpperCase() === "YEARLY") cycle = BillingCycle.YEARLY;

    // جـ: التحقق من عدم تكرار الكود مسبقاً في داتابيز السيستم لضمان الـ Unique Constraint المتواجد في السكيما
    const existingCode = await prisma.promoCode.findUnique({ where: { code: cleanCode } });
    if (existingCode) {
      return res.status(409).json({ success: false, error: "هذا الكود مسجل بالفعل في قاعدة البيانات، اختر رمزاً فريداً آخر" });
    }

    // د: الحقن الفعلي للكود في جدول النظام مع تصفير الاستخدام الابتدائي
    const newPromo = await prisma.promoCode.create({
      data: {
        code: cleanCode,
        discountPercent: parsedDiscount,
        durationMonths: parsedDuration,
        applicableCycle: cycle,
        maxUses: parsedMaxUses,
        expiresAt: new Date(expiresAt),
        usedCount: 0
      }
    });

    return res.status(201).json({
      success: true,
      message: `تم توليد وحقن كود الخصم [${cleanCode}] في نظام الـ SaaS بنجاح واقتدار ✅`,
      promoCode: newPromo
    });

  } catch (err) {
    console.error("❌ [PROMO CODE CREATE FATAL ERROR]:", err);
    return res.status(500).json({ success: false, error: `فشل داخلي بالخادم أثناء المعالجة: ${err.message}` });
  }
});

// ===========================================================================
// [2] جلب جميع أكواد الخصم مع التحليلات المالية لكل كود (READ LIST + ANALYTICS)
// ===========================================================================
router.get("/list", authenticatePromoAction, async (req, res) => {
  try {
    // جلب الأكواد مضافاً إليها جميع المدفوعات الناجحة والمراكز المرتبطة بها لحساب العائد المالي والنشاط الحالي بدقة
    const promoCodes = await prisma.promoCode.findMany({
      include: {
        payments: {
          where: { status: PaymentStatus.SUCCESS },
          select: { amount: true, centerId: true }
        },
        activeCenters: {
          select: { id: true, name: true, isPromoPaused: true }
        }
      },
      orderBy: { createdAt: "desc" }
    });

    // معالجة البيانات وبناء مصفوفة تحليلات ذكية (Analytics Transformer)
    const enrichedPromoCodes = promoCodes.map(promo => {
      const totalRevenueGenerated = promo.payments.reduce((sum, p) => sum + p.amount, 0);
      const uniqueCentersUsed = [...new Set(promo.payments.map(p => p.centerId))].length;
      const now = new Date();
      const isExpired = new Date(promo.expiresAt) < now;
      const isLimitReached = promo.usedCount >= promo.maxUses;

      return {
        id: promo.id,
        code: promo.code,
        discountPercent: promo.discountPercent,
        durationMonths: promo.durationMonths,
        applicableCycle: promo.applicableCycle,
        maxUses: promo.maxUses,
        usedCount: promo.usedCount,
        expiresAt: promo.expiresAt,
        createdAt: promo.createdAt,
        isExpired: isExpired,
        isLimitReached: isLimitReached,
        status: (isExpired || isLimitReached) ? "INACTIVE" : "ACTIVE",
        activeCentersCount: promo.activeCenters.length,
        pausedInCentersCount: promo.activeCenters.filter(c => c.isPromoPaused).length, // حساب كم سنتر قام بتجميد هذا الكود مؤقتاً
        analytics: {
          totalRevenue: Number(totalRevenueGenerated.toFixed(2)), // إجمالي المبالغ الفعلية المحصلة بسببه بالمليم
          uniqueCentersCount: uniqueCentersUsed, // عدد المراكز الفريدة التي استخدمته تاريخياً في الفواتير المدفوعة
          remainingUses: Math.max(0, promo.maxUses - promo.usedCount) // الاستخدامات المتبقية قبل إغلاقه تلقائياً برمجياً
        }
      };
    });

    return res.json({
      success: true,
      count: enrichedPromoCodes.length,
      promoCodes: enrichedPromoCodes
    });

  } catch (err) {
    console.error("❌ [PROMO CODE LIST FATAL ERROR]:", err);
    return res.status(500).json({ success: false, error: `فشل استخراج تقارير الأكواد المعتمدة: ${err.message}` });
  }
});

// ===========================================================================
// [3] لوحة تحكم وإحصائيات عامة شاملة للأكواد (GLOBAL SaaS METRICS)
// ===========================================================================
router.get("/dashboard-stats", authenticatePromoAction, async (req, res) => {
  try {
    const totalPromoCodesCount = await prisma.promoCode.count();
    
    // جلب البيانات الهامة لحساب المجاميع الكلية دون إجهاد السيرفر بـ Over-fetching
    const allPromos = await prisma.promoCode.findMany({
      select: {
        usedCount: true,
        discountPercent: true,
        payments: {
          where: { status: PaymentStatus.SUCCESS },
          select: { amount: true }
        }
      }
    });

    let totalSaaSRevenueFromPromos = 0;
    let totalGlobalUses = 0;

    allPromos.forEach(p => {
      totalGlobalUses += p.usedCount;
      const revenue = p.payments.reduce((sum, pay) => sum + pay.amount, 0);
      totalSaaSRevenueFromPromos += revenue;
    });

    return res.json({
      success: true,
      metrics: {
        totalGeneratedCodes: totalPromoCodesCount,
        totalGlobalUses: totalGlobalUses,
        totalRevenueGenerated: Number(totalSaaSRevenueFromPromos.toFixed(2)),
        averageDiscountPercent: allPromos.length > 0 
          ? Number((allPromos.reduce((sum, p) => sum + p.discountPercent, 0) / allPromos.length).toFixed(1)) 
          : 0
      }
    });
  } catch (err) {
    console.error("❌ [PROMO GLOBAL STATS CRITICAL ERROR]:", err);
    return res.status(500).json({ success: false, error: `فشل معالجة الإحصائيات الهيكلية للمنصة: ${err.message}` });
  }
});

// ===========================================================================
// [4] فحص تفصيلي معمق لكود واحد وتحليل الفواتير والمراكز (READ SINGLE)
// ===========================================================================
router.get("/single/:id", authenticatePromoAction, async (req, res) => {
  try {
    const promoId = Number.parseInt(req.params.id, 10);
    if (Number.isNaN(promoId)) return res.status(400).json({ success: false, error: "المعرف الممرر غير صالح برمجياً" });

    const promo = await prisma.promoCode.findUnique({
      where: { id: promoId },
      include: {
        activeCenters: {
          select: { id: true, name: true, phone: true, plan: true, isPromoPaused: true, promoMonthsUsed: true }
        },
        payments: {
          include: {
            center: { select: { id: true, name: true, phone: true } }
          },
          orderBy: { createdAt: "desc" }
        }
      }
    });

    if (!promo) {
      return res.status(404).json({ success: false, error: "كود الخصم المطلوب غير مسجل بالنظام" });
    }

    // حسابات مالية مخصصة ومتقدمة للكود المحدد وفصل أنواع المدفوعات التابعة له طبقاً للـ Enum المحدث
    const successPayments = promo.payments.filter(p => p.status === PaymentStatus.SUCCESS);
    const failedPayments = promo.payments.filter(p => p.status === PaymentStatus.FAILED);
    const refundedPayments = promo.payments.filter(p => p.status === PaymentStatus.REFUNDED);
    
    const totalRevenue = successPayments.reduce((sum, p) => sum + p.amount, 0);

    return res.json({ 
      success: true, 
      promoCode: {
        ...promo,
        calculatedAnalytics: {
          totalSuccessPaymentsCount: successPayments.length,
          totalFailedPaymentsCount: failedPayments.length,
          totalRefundedPaymentsCount: refundedPayments.length,
          totalRevenueGenerated: Number(totalRevenue.toFixed(2))
        }
      } 
    });
  } catch (err) {
    console.error("❌ [PROMO CODE SINGLE FATAL ERROR]:", err);
    return res.status(500).json({ success: false, error: `فشل جلب مستند الكود وتفصيلاته الهيكلية: ${err.message}` });
  }
});

// ===========================================================================
// [5] تحديث معايير وصلاحية كود الخصم (UPDATE)
// ===========================================================================
router.put("/update/:id", authenticatePromoAction, async (req, res) => {
  try {
    const promoId = Number.parseInt(req.params.id, 10);
    if (Number.isNaN(promoId)) return res.status(400).json({ success: false, error: "المعرف الممرر غير صالح برمجياً" });

    const { discountPercent, durationMonths, applicableCycle, maxUses, expiresAt } = req.body || {};

    // التأكد من وجود الكود قبل التحديث تجنباً للـ Prisma RecordNotFound Exceptions المفاجئة
    const targetPromo = await prisma.promoCode.findUnique({ where: { id: promoId } });
    if (!targetPromo) {
      return res.status(404).json({ success: false, error: "عذراً، كود الخصم المستهدف للتحديث غير موجود بقاعدة البيانات" });
    }

    const updateData = {};

    if (discountPercent !== undefined) {
      const parsedDiscount = Number.parseFloat(discountPercent);
      if (Number.isNaN(parsedDiscount) || parsedDiscount <= 0 || parsedDiscount > 100) {
        return res.status(400).json({ success: false, error: "نسبة الخصم المحدثة غير صالحة حسابياً" });
      }
      updateData.discountPercent = parsedDiscount;
    }

    if (durationMonths !== undefined) {
      const parsedDuration = Number.parseInt(durationMonths, 10);
      if (Number.isNaN(parsedDuration) || parsedDuration <= 0) {
        return res.status(400).json({ success: false, error: "عدد شهور تطبيق الخصم المحدثة غير صالحة" });
      }
      updateData.durationMonths = parsedDuration;
    }
    
    if (maxUses !== undefined) {
      const parsedMaxUses = Number.parseInt(maxUses, 10);
      if (Number.isNaN(parsedMaxUses) || parsedMaxUses < 0) {
        return res.status(400).json({ success: false, error: "الحد الأقصى المحدث للاستخدام يجب أن يكون رقماً موجباً صفرياً أو أعلى" });
      }
      updateData.maxUses = parsedMaxUses;
    }
    
    if (expiresAt !== undefined) {
      if (Number.isNaN(Date.parse(expiresAt))) {
        return res.status(400).json({ success: false, error: "تاريخ الانتهاء الزمني الممرر غير صالح برمجياً" });
      }
      updateData.expiresAt = new Date(expiresAt);
    }

    if (applicableCycle !== undefined) {
      let cycle = BillingCycle.BOTH;
      const upperCycle = String(applicableCycle).toUpperCase();
      if (upperCycle === "MONTHLY") cycle = BillingCycle.MONTHLY;
      if (upperCycle === "YEARLY") cycle = BillingCycle.YEARLY;
      updateData.applicableCycle = cycle;
    }

    const updatedPromo = await prisma.promoCode.update({
      where: { id: promoId },
      data: updateData
    });

    return res.json({
      success: true,
      message: "تم تحديث إعدادات وحدود كود الخصم الجارية بنجاح تام في الداتابيز ⚙️",
      promoCode: updatedPromo
    });

  } catch (err) {
    console.error("❌ [PROMO CODE UPDATE CRITICAL ERROR]:", err);
    return res.status(500).json({ success: false, error: `فشل تحديث كود الخصم بالمخدم الداخلي: ${err.message}` });
  }
});

// ===========================================================================
// [6] حذف كود الخصم نهائياً من الكتالوج (DELETE)
// ===========================================================================
router.delete("/delete/:id", authenticatePromoAction, async (req, res) => {
  try {
    const promoId = Number.parseInt(req.params.id, 10);
    if (Number.isNaN(promoId)) return res.status(400).json({ success: false, error: "المعرف الممرر غير صالح لمعالجة طلب الحذف" });

    const checkExist = await prisma.promoCode.findUnique({ where: { id: promoId } });
    if (!checkExist) {
      return res.status(404).json({ success: false, error: "الكود المطلوب حذفه غير مدرج بالنظام بالأساس" });
    }

    // حذف الكود نهائياً؛ ونظراً لوجود onDelete: SetNull في السكيما للعلاقات مع الـ Center والـ Payment فسيتم تصفير الربط بأمان تماماً دون كسر القيود الهيكلية
    await prisma.promoCode.delete({ where: { id: promoId } });

    return res.json({
      success: true,
      message: `تم سحق وحذف كود الخصم [${checkExist.code}] بنجاح، وتم تأمين وحماية الفواتير التاريخية والمراكز المرتبطة به 💥`
    });

  } catch (err) {
    console.error("❌ [PROMO CODE DELETE CRITICAL ERROR]:", err);
    return res.status(500).json({ success: false, error: `فشل إنهاء وحذف الكود برمجياً من السيرفر: ${err.message}` });
  }
});

// ===========================================================================
// [7] مسار التحقق السريع والمفتوح للمراكز (PRE-CHECK / VALIDATE) - تم دمج منطق الـ isPromoPaused الجديد
// ===========================================================================
router.post("/validate", authenticateToken, async (req, res) => {
  try {
    const { code, billingCycle } = req.body || {};
    const cleanCode = cleanAndNormalizeCode(code);
    const cycle = String(billingCycle || "").trim().toUpperCase();

    if (!cleanCode) {
      return res.status(400).json({ success: false, valid: false, error: "يرجى كتابة رمز الكود أولاً ليتم التحقق منه" });
    }

    if (!billingCycle) {
      return res.status(400).json({ success: false, valid: false, error: "نوع الدورة الفاتورية (billingCycle) مطلوب للتحقق من أهلية الكود" });
    }

    // جلب الكود والتحقق من وجوده الفعلي بالنظام
    const promo = await prisma.promoCode.findUnique({ where: { code: cleanCode } });

    if (!promo) {
      return res.status(404).json({ success: false, valid: false, error: "كود الخصم المكتوب غير موجود أو غير مدعوم حالياً في المنصة" });
    }

    // أ: التحقق الزمني المطلق ضد انتهاء الصلاحية
    if (new Date(promo.expiresAt) < new Date()) {
      return res.status(400).json({ success: false, valid: false, error: "عذراً، صلاحية كود الخصم هذا قد انتهت زمنياً بالكامل" });
    }

    // ب: التحقق من كسر الحد الأقصى للاستخدام الكلي المسموح به في الـ SaaS
    if (promo.usedCount >= promo.maxUses) {
      return res.status(400).json({ success: false, valid: false, error: "لقد وصل كود الخصم للحد الأقصى المسموح به من الاستخدامات الكلية للمنصة" });
    }

    // جـ: التحقق من توافق نوع الدورة الفاتورية الممررة من العميل مع الكود المتاح بالسكيما (MONTHLY, YEARLY, BOTH)
    if (promo.applicableCycle !== BillingCycle.BOTH && promo.applicableCycle.toString() !== cycle) {
      let friendlyCycleName = promo.applicableCycle === BillingCycle.MONTHLY ? "الشهري" : "السنوي";
      return res.status(400).json({ 
        success: false, 
        valid: false, 
        error: `هذا الكود مخصص لعمليات الدفع والاشتراك من النوع ${friendlyCycleName} فقط` 
      });
    }

    // د: طبقة الحماية السيادية الكبرى وفحص تجميد الخصومات لـ (Center Intelligent Guard) طبقاً للميزة الجديدة بالسكيما
    if (req.user && req.user.centerId) {
      const currentCenter = await prisma.center.findUnique({
        where: { id: req.user.centerId },
        select: { 
          activePromoCodeId: true,
          isPromoPaused: true // الحقل الرسمي المباشر في السكيما الجديدة لوقف وتجميد خصم السنتر
        }
      });

      if (!currentCenter) {
        return res.status(404).json({
          success: false,
          valid: false,
          error: "عذراً، لم يتم العثور على بيانات السنتر المرتبطة بحسابك الحالي في النظام 🛡️"
        });
      }

      // 🛑 الفحص الإمبراطوري الحاسم: منع تفعيل أو استخدام الأكواد إذا تم تفعيل ميزة إيقاف الخصم مؤقتاً لهذا السنتر (isPromoPaused)
      if (currentCenter.isPromoPaused === true) {
        return res.status(403).json({
          success: false,
          valid: false,
          error: "عذراً، لقد تم تعليق وتجميد ميزة تطبيق الخصومات والأكواد الترويجية لهذا السنتر مؤقتاً بقرار سيادي من الإدارة العليا ⛔"
        });
      }

      // منع العميل من إعادة تطبيق نفس كود الخصم النشط والفعال عليه حالياً لمنع الهدر والاستنزاف المالي المكرر
      if (currentCenter.activePromoCodeId === promo.id) {
        return res.status(400).json({
          success: false,
          valid: false,
          error: "هذا الخصم مفعّل ونشط بالفعل على حساب السنتر الخاص بك حالياً للاستفادة الجارية"
        });
      }
    }

    // إذا تخطى كل العقبات الأهلية الصارمة، نعلن نجاح التحقق وصلاحية التطبيق
    return res.json({
      success: true,
      valid: true,
      message: `كود خصم صالح ومؤهل للاستخدام! يمنحك خصماً بقيمة ${promo.discountPercent}% ✨`,
      discountPercent: promo.discountPercent,
      durationMonths: promo.durationMonths,
      applicableCycle: promo.applicableCycle
    });

  } catch (err) {
    console.error("❌ [PROMO CODE PUBLIC VALIDATION ERROR]:", err);
    return res.status(500).json({ success: false, error: `خطأ نظام داخلي أثناء فحص وتأكيد الكود: ${err.message}` });
  }
});

module.exports = router;