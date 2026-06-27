const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// ============================================================================
// 1) إعدادات وتكوينات حدود الخطط السحابية المحدثة (SaaS Plans Gatekeeper)
// ============================================================================
// تم تحديث الأرقام والحدود بناءً على مواصفات باقات Sentryk الجديدة الخاصة بك
const PLAN_CONFIG = Object.freeze({
  TRIAL: {
    maxStudents: 100,
    maxUsers: 3,
    maxSessions: 1000,          // حد أقصى افتراضي للمجموعات في الفترة التجريبية
    allowWhatsApp: true,
    allowOfflineSync: true,
  },
  BASIC: {
    maxStudents: 250,
    maxUsers: 4,
    maxSessions: 3000,          // حد أقصى مرن للمجموعات
    allowWhatsApp: true,
    allowOfflineSync: true,
  },
  PREMIUM: {
    maxStudents: 1000,
    maxUsers: 10,
    maxSessions: 12000,
    allowWhatsApp: true,
    allowOfflineSync: true,
  },
  ELITE: {
    maxStudents: 3000000,
    maxUsers: 25000,
    maxSessions: 999999,      // سعة شبه لا نهائية للباقة الإليت
    allowWhatsApp: true,
    allowOfflineSync: true,
  },
});

const PLAN_ALIASES = Object.freeze({
  MONTHLY: "BASIC",
  YEARLY: "BASIC",
  HALF_MONTH: "BASIC",
  COURSE: "BASIC",
});

function normalizePlan(plan) {
  const raw = String(plan || "").trim().toUpperCase();
  if (PLAN_CONFIG[raw]) return raw;
  if (PLAN_ALIASES[raw]) return PLAN_ALIASES[raw];
  return "TRIAL";
}

function getTrialExpiry(trialStartedAt) {
  if (!trialStartedAt) return null;
  const started = new Date(trialStartedAt);
  if (Number.isNaN(started.getTime())) return null;

  const expiry = new Date(started);
  expiry.setDate(expiry.getDate() + 14); // 14 يوماً فترة تجريبية
  return expiry;
}

// ============================================================================
// 2) التحقق من التوكن وفك التشفير (Authentication Layer)
// ============================================================================
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res
      .status(401)
      .json({ error: "🔑 التوكن مطلوب وصارم للوصول إلى هذه النقطة البرمجية" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("❌ JWT Verification Failed:", err.message);
    return res
      .status(403)
      .json({ error: "⚠️ التوكن غير صالح، تالف، أو منتهي الصلاحية" });
  }
};

// ============================================================================
// 3) التحقق من الأدوار والصلاحيات (Role-Based Access Control)
// ============================================================================
const requireRole = (allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res
      .status(403)
      .json({ error: "🚫 ليس لديك الصلاحية الإدارية الكافية لتنفيذ هذا الإجراء" });
  }
  next();
};

// ============================================================================
// 4) التحقق من الانتماء لسنتر تعليمي نشط (Center Context Guard)
// ============================================================================
const requireCenterAccess = (req, res, next) => {
  if (!req.user || !req.user.centerId) {
    return res
      .status(403)
      .json({ error: "🏫 يرجى ربط الحساب الحالي بسنتر تعليمي أولاً للعبور" });
  }
  next();
};

// ============================================================================
// 5) الميدلوير الشامل للتحقق من الاشتراك والحدود (Subscription & SaaS Limits Core)
// ============================================================================
const requireActiveSubscription = async (req, res, next) => {
  try {
    const centerId = Number(req.user?.centerId);

    if (!centerId) {
      return res
        .status(401)
        .json({ error: "لم يتم التعرف على الهوية المؤسسية للسنتر" });
    }

    const center = await prisma.center.findUnique({
      where: { id: centerId },
      include: {
        subscriptions: {
          where: {
            isActive: true,
            endDate: { gte: new Date() },
          },
          orderBy: { endDate: "desc" },
          take: 1,
        },
      },
    });

    if (!center) {
      return res
        .status(404)
        .json({ error: "السنتر المستهدف غير مسجل بقواعد البيانات الحالية" });
    }

    const activeSub = center.subscriptions?.[0] || null;
    let currentPlan = normalizePlan(center.plan);
    let isExpired = false;

    const trialExpiry = getTrialExpiry(center.trialStartedAt);

    // التحقق من حالة الفترة التجريبية أو الاشتراك
    if (!activeSub) {
      if (currentPlan === "TRIAL" && trialExpiry) {
        if (trialExpiry <= new Date()) {
          isExpired = true;
        }
      } else if (currentPlan === "TRIAL" && !trialExpiry) {
        isExpired = true;
      } else {
        isExpired = true;
      }
    }

    if (isExpired) {
      return res.status(403).json({
        error: "🚨 الاشتراك منتهي أو الفترة التجريبية انتهت تماماً. يرجى التجديد أو الترقية للاستمرار.",
        plan: currentPlan,
        isExpired: true,
      });
    }

    const baseLimits = PLAN_CONFIG[currentPlan] || PLAN_CONFIG.TRIAL;

    // حقن كائن الموارد ذكياً داخل الـ Request ليكون جاهزاً للميدلوير التالي والراوتات
    req.planLimits = {
      plan: currentPlan,
      // لو السنتر محدد له كاستم maxStudents في الداتابيز أكبر من 0 نستخدمه، وإلا نأخذ افتراضي الباقة
      maxStudents:
        Number.isFinite(Number(center.maxStudents)) && Number(center.maxStudents) > 0
          ? Number(center.maxStudents)
          : baseLimits.maxStudents,
      maxUsers: center.maxUsers > 1 ? center.maxUsers : baseLimits.maxUsers,
      maxSessions: baseLimits.maxSessions,
      allowWhatsApp: baseLimits.allowWhatsApp,
      allowOfflineSync: baseLimits.allowOfflineSync,
      coupon: null,
      subscriptionId: activeSub?.id || null,
      expiresAt: activeSub?.endDate || trialExpiry || null,
      trialUsed: Boolean(center.trialUsed),
      trialStartedAt: center.trialStartedAt || null,
    };

    next();
  } catch (err) {
    console.error("❌ Critical Error In Subscription Middleware:", err);
    return res.status(500).json({
      error: "حصل خطأ داخلي غير متوقع أثناء فحص أمن المعاملات المالية وحدود الخطة السحابية",
    });
  }
};

// ============================================================================
// 6) الميدلوير الأسطوري المطور للتحقق اللحظي من تخطي حدود الموارد (Dynamic & Safe Enforcer)
// ============================================================================
/**
 * يحمي الموارد من التخطي ويقبل الاستدعاء المباشر أو المخصص:
 * طريقة 1 (موصى بها): checkMaxLimit("students")
 * طريقة 2 (حمائية ومباشرة): checkMaxLimit
 */
const checkMaxLimit = (resourceTypeOrReq, res, next) => {
  // الحالة الأولى: إذا تم استدعاؤه كمصنع مخصص مثل: checkMaxLimit("students")
  if (typeof resourceTypeOrReq === "string") {
    const resourceType = resourceTypeOrReq;
    return async (req, res, next) => {
      return executeLimitVerification(req, res, next, resourceType);
    };
  }

  // الحالة الثانية: إذا تم وضعه مباشرة في الراوت بالخطأ مثل: router.post("/", checkMaxLimit)
  // هنا المعامل الأول هو الـ req الفعلي والـ res والـ next جايين في المعاملات التالية للـ Express
  const req = resourceTypeOrReq;
  const actualRes = res;
  const actualNext = next;

  // استنتاج نوع المورد تلقائياً من مسار طلب الـ API للحماية التامة
  let detectedResource = "students"; 
  const currentUrl = req.originalUrl || req.url || "";
  if (currentUrl.includes("session")) {
    detectedResource = "sessions";
  }

  return executeLimitVerification(req, actualRes, actualNext, detectedResource);
};

// المحرك الداخلي الفعلي لفحص استهلاك الموارد بقاعدة البيانات
async function executeLimitVerification(req, res, next, resourceType) {
  try {
    const centerId = Number(req.user?.centerId);
    const limits = req.planLimits;

    if (!centerId || !limits) {
      console.error("❌ [checkMaxLimit Error]: لم يتم العثور على req.planLimits بالطلب. تأكد من وضع requireActiveSubscription قبله في الراوت.");
      return res.status(400).json({
        error: "فشل فحص الموارد نظراً لعدم حقن أو توفر كائن فحص حدود الخطة بالطلب الحالي",
      });
    }

    // ─── أ) فحص حد الطلاب ───
    if (resourceType === "students") {
      const currentStudentsCount = await prisma.student.count({
        where: { centerId },
      });

      console.log(`⚙️ [Guard Limits]: فحص الطلاب للسنتر [${centerId}] -> الحالي: ${currentStudentsCount} | الأقصى: ${limits.maxStudents}`);

      if (currentStudentsCount >= limits.maxStudents) {
        console.warn(`⚠️ [Limit Blocked]: سنتر رقم [${centerId}] حاول تخطي باقة [${limits.plan}] في إضافة الطلاب.`);
        return res.status(403).json({
          error: `⚠️ عذراً، لقد استنفذت الحد الأقصى المسموح به للطلاب في خطتك الحالية [${limits.plan}] وهو (${limits.maxStudents} طالب).`,
          limitExceeded: true,
          resource: "students",
          maxAllowed: limits.maxStudents,
          currentCount: currentStudentsCount,
          suggestion: "يرجى ترقية باقة السنتر الحالية للاستمتاع بسعة استيعابية أكبر وتوسيع السحابية 🚀",
        });
      }
    }

    // ─── ب) فحص حد المجموعات التعليمية (Sessions) ───
    if (resourceType === "sessions") {
      const currentSessionsCount = await prisma.session.count({
        where: {
          room: {
            centerId,
          },
        },
      });

      console.log(`⚙️ [Guard Limits]: فحص المجموعات للسنتر [${centerId}] -> الحالي: ${currentSessionsCount} | الأقصى: ${limits.maxSessions}`);

      if (currentSessionsCount >= limits.maxSessions) {
        console.warn(`⚠️ [Limit Blocked]: سنتر رقم [${centerId}] حاول تخطي باقة [${limits.plan}] في إضافة المجموعات.`);
        return res.status(403).json({
          error: `⚠️ تم الوصول للحد الأقصى للمجموعات التعليمية المتاحة لسنترك بالباقة الحالية وهو (${limits.maxSessions} مجموعة).`,
          limitExceeded: true,
          resource: "sessions",
          maxAllowed: limits.maxSessions,
          currentCount: currentSessionsCount,
          suggestion: "قم بالترقية للباقة الأعلى لفتح المزيد من الحصص والمجموعات الإدارية 🔓",
        });
      }
    }

    // كل شيء سليم وضمن النطاق؟ مرر الطلب فوراً بكل سلاسة!
    console.log(`✅ [Limit Passed]: المورد [${resourceType}] سليم وضمن حدود باقة [${limits.plan}]. جاري التمرير...`);
    return next();
  } catch (err) {
    console.error(`❌ Error Enforcing Plan Limits For ${resourceType}:`, err);
    return res.status(500).json({
      error: "فشل الخادم في فحص وتأكيد الحصص والحدود الاستيعابية للمورد البنيوي",
    });
  }
}

// ============================================================================
// 7) تصدير الموديولات المعمارية الموحدة للمنصة بالكامل
// ============================================================================
module.exports = {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
  checkMaxLimit,
  PLAN_CONFIG,
};