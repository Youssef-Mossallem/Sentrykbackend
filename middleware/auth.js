const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// 1. التحقق من التوكن (كما هو)
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res
      .status(401)
      .json({ error: "التوكن مطلوب للوصول إلى هذا الراوت" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: "التوكن غير صالح أو منتهي" });
  }
};

// 2. التحقق من الصلاحيات (كما هو)
const requireRole = (allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ error: "ليس لديك صلاحية لهذه العملية" });
  }
  next();
};

// 3. التحقق من الانتماء لسنتر (كما هو)
const requireCenterAccess = (req, res, next) => {
  if (!req.user || !req.user.centerId) {
    return res.status(403).json({ error: "ليس لديك سنتر مرتبط" });
  }
  next();
};

// 4. الميدلوير المطور للتحقق من الاشتراك (Trial + Paid)
const requireActiveSubscription = async (req, res, next) => {
  try {
    const centerId = req.user?.centerId;
    if (!centerId)
      return res.status(401).json({ error: "لم يتم التحقق من السنتر" });

    // بنجيب بيانات السنتر عشان نعرف هو في خطة إيه وهل الـ Trial لسه شغال؟
    const center = await prisma.center.findUnique({
      where: { id: centerId },
      include: {
        subscriptions: {
          where: {
            isActive: true,
            endDate: { gte: new Date() }, // الاشتراك لازم يكون تاريخ نهايته لسه مجاش
          },
          take: 1,
        },
      },
    });

    if (!center) return res.status(404).json({ error: "السنتر غير موجود" });

    // الحالة الأولى: السنتر عنده اشتراك نشط (سواء Trial دافع أو PRO دافع)
    const activeSub = center.subscriptions[0];

    if (activeSub) {
      // لو اشتراك نشط، نعدي الطلب بسلام
      return next();
    }

    // الحالة الثانية: لو مفيش اشتراك مسجل في الـ Subscriptions بس السنتر مكتوب عليه TRIAL
    // دي حماية إضافية لو الـ Webhook متأخر أو كـ fallback
    if (center.plan === "TRIAL" && center.trialStartedAt) {
      const trialEndDate = new Date(center.trialStartedAt);
      trialEndDate.setDate(trialEndDate.getDate() + 14); // مدة الـ 14 يوم

      if (trialEndDate > new Date()) {
        return next(); // لسه في الـ 14 يوم، نعديه
      }
    }

    // لو مفيش أي شرط من اللي فوق تحقق
    return res.status(403).json({
      error:
        "الاشتراك منتهي أو الفترة التجريبية انتهت. يرجى التجديد للاستمرار.",
      plan: center.plan,
      isExpired: true,
    });
  } catch (err) {
    console.error("خطأ في التحقق من الاشتراك:", err);
    return res
      .status(500)
      .json({ error: "حصل خطأ داخلي أثناء التحقق من الاشتراك" });
  }
};

module.exports = {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
};
