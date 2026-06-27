const express = require("express");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription, // 🚀 تم استدعاء ميدلوير فحص الاشتراك لحقن حدود الخطة تلقائياً
} = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// ميدلوير بسيط ومنظم للتحقق من الإدخال (بدون centerId)
const validateUserInput = (req, res, next) => {
  const { name, email, password, role, isActive } = req.body;

  // للـ POST: الحقول الإجبارية (بدون centerId)
  if (req.method === "POST") {
    if (
      !name?.trim() ||
      !email?.includes("@") ||
      !password ||
      password.length < 8 ||
      !role
    ) {
      return res.status(400).json({
        error:
          "كل الحقول مطلوبة لإضافة مستخدم جديد (name, email, password ≥ 8, role)",
      });
    }

    if (!["ADMIN", "SECRETARY"].includes(role)) {
      return res.status(400).json({
        error: "الدور غير صالح (ADMIN أو SECRETARY فقط)",
      });
    }
  }

  // للـ PUT: الحقول اختيارية، بس لو موجودة تكون صحيحة
  if (req.method === "PUT") {
    if (password && password.length < 8) {
      return res.status(400).json({
        error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل إذا تم إرسالها",
      });
    }

    if (role && !["ADMIN", "SECRETARY"].includes(role)) {
      return res.status(400).json({
        error: "الدور غير صالح (ADMIN أو SECRETARY فقط)",
      });
    }

    // لو مفيش أي حقل للتعديل
    if (
      !name?.trim() &&
      !email &&
      !password &&
      !role &&
      typeof isActive !== "boolean"
    ) {
      return res.status(400).json({ error: "لا توجد بيانات لتعديلها" });
    }
  }

  next();
};

// POST /api/users - إضافة مستخدم جديد (centerId من التوكن + فحص السعة الاستيعابية للباقة)
router.post(
  "/",
  authenticateToken,
  requireRole(["ADMIN"]),
  requireActiveSubscription, // 🔐 حماية الطبقة السحابية لضمان حقن كائن req.planLimits
  validateUserInput,
  async (req, res) => {
    try {
      const { name, email, password, role } = req.body;
      const { centerId, userId } = req.user; // ← centerId من التوكن تلقائيًا

      // ======================================================================
      // 🛑 نظام الفحص الذكي للحد الأقصى للمستشارين والمساعدين (Users Limit Enforcer)
      // ======================================================================
      const plan = req.planLimits?.plan || "TRIAL";
      
      // 📊 خريطة التكوين الافتراضية لعدد المستخدمين الإضافيين المسموح بهم لكل باقة
      const USER_PLAN_LIMITS = {
        TRIAL: 2,      // باقة تجريبية: يتيح مساعدين اثنين فقط بجانب صاحب الحساب
        BASIC: 5,      // الباقة الأساسية: تتيح 5 مساعدين
        PRO: 15,       // الباقة الاحترافية: تتيح 15 مساعداً
        ELITE: 999     // الباقة المفتوحة
      };

      // اعتماد الحدود المخصصة من قاعدة البيانات إن وجدت، وإلا العودة للحدود الافتراضية للباقة
      const maxAllowedUsers = req.planLimits?.maxUsersCustom || USER_PLAN_LIMITS[plan] || 2;

      // 🔍 العثور على المستخدم الأول والأقدم في السنتر (صاحب الحساب الأصلي / المالك الرئيسي)
      const firstUser = await prisma.user.findFirst({
        where: { centerId },
        orderBy: { id: "asc" }, // جلب صاحب أقل ID وهو أول حساب تم إنشاؤه للسنتر
      });

      // 🧮 حساب عدد المستخدمين الحاليين مع استثناء المالك الرئيسي تماماً من الحسبة
      const currentUsersCount = await prisma.user.count({
        where: {
          centerId,
          id: firstUser ? { not: firstUser.id } : undefined, // 💡 المالك الرئيسي خارج الحسبة ولا يُحتسب في العدد
        },
      });

      // 🚨 التحقق من تخطي السعة القصوى للباقة الحالية
      if (currentUsersCount >= maxAllowedUsers) {
        return res.status(403).json({
          error: `⚠️ عذراً، لقد استنفذت الحد الأقصى المسموح به للمساعدين والمشرفين في خطتك الحالية [${plan}] وهو (${maxAllowedUsers} مستخدمين إضافيين).`,
          limitExceeded: true,
          resource: "users",
          maxAllowed: maxAllowedUsers,
          currentCount: currentUsersCount,
          suggestion: "يرجى ترقية باقة السنتر الحالية لزيادة سعة الطاقم الإداري والمساعدين المتاحين 🚀",
        });
      }
      // ======================================================================

      // فحص الإيميل الفريد
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        return res.status(409).json({ error: "الإيميل مستخدم من قبل" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = await prisma.user.create({
        data: {
          name: name.trim(),
          email,
          password: hashedPassword,
          role,
          centerId, // ← من التوكن (مش من body)
          isActive: true,
        },
      });

      // تسجيل في ActivityLog باستخدام التوكن
      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "CREATE_USER",
          targetType: "User",
          targetId: newUser.id,
          details: JSON.stringify({
            name: newUser.name,
            email: newUser.email,
            role,
          }),
        },
      });

      res.status(201).json({
        message: "تم إضافة المستخدم بنجاح",
        user: {
          id: newUser.id,
          name: newUser.name,
          email: newUser.email,
          role: newUser.role,
          centerId: newUser.centerId,
          isActive: newUser.isActive,
        },
      });
    } catch (error) {
      console.error("خطأ في إضافة مستخدم:", error);
      if (error.code === "P2002") {
        return res.status(409).json({ error: "الإيميل مستخدم من قبل" });
      }
      res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
    }
  },
);

// GET /api/users - عرض يوزرز السنتر ده بس (محمي)
router.get("/", authenticateToken, requireCenterAccess, async (req, res) => {
  try {
    const { centerId } = req.user;

    const users = await prisma.user.findMany({
      where: { centerId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        centerId: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      success: true,
      count: users.length,
      data: users,
    });
  } catch (error) {
    console.error("خطأ في عرض المستخدمين:", error);
    res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
  }
});

// GET /api/users/:id - عرض يوزر معين (فقط لو تابع للسنتر)
router.get("/:id", authenticateToken, requireCenterAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { centerId } = req.user;

    const user = await prisma.user.findFirst({
      where: {
        id: Number(id),
        centerId,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        centerId: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        error: "المستخدم غير موجود أو لا يتبع سنترك",
      });
    }

    res.json({ success: true, user });
  } catch (error) {
    console.error("خطأ في عرض مستخدم:", error);
    res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
  }
});

// PUT /api/users/:id - تعديل مستخدم
router.put(
  "/:id",
  authenticateToken,
  requireRole(["ADMIN"]),
  validateUserInput,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { name, role, isActive, password } = req.body;
      const { centerId, userId } = req.user;

      const targetUser = await prisma.user.findFirst({
        where: {
          id: Number(id),
          centerId,
        },
      });

      if (!targetUser) {
        return res.status(404).json({
          error: "المستخدم غير موجود أو لا يتبع سنترك",
        });
      }

      // منع تعديل الأدمن الرئيسي (اختياري)
      if (targetUser.id === 1 && targetUser.role === "ADMIN") {
        return res.status(403).json({ error: "لا يمكن تعديل الأدمن الرئيسي" });
      }

      const dataToUpdate = {};
      if (name?.trim()) dataToUpdate.name = name.trim();
      if (role && ["ADMIN", "SECRETARY"].includes(role))
        dataToUpdate.role = role;
      if (typeof isActive === "boolean") dataToUpdate.isActive = isActive;
      if (password) dataToUpdate.password = await bcrypt.hash(password, 10);

      if (Object.keys(dataToUpdate).length === 0) {
        return res.status(400).json({ error: "لا توجد بيانات لتعديلها" });
      }

      const updatedUser = await prisma.user.update({
        where: { id: Number(id) },
        data: dataToUpdate,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
        },
      });

      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "UPDATE_USER",
          targetType: "User",
          targetId: updatedUser.id,
          details: JSON.stringify({
            updatedFields: Object.keys(dataToUpdate),
            newValues: dataToUpdate,
          }),
        },
      });

      res.json({
        message: "تم تعديل المستخدم بنجاح",
        user: updatedUser,
      });
    } catch (error) {
      console.error("خطأ في تعديل مستخدم:", error);
      res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
    }
  },
);

// DELETE /api/users/:id - حذف مستخدم
router.delete(
  "/:id",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const userId = Number(id);
      const { centerId, userId: currentUserId } = req.user;

      const targetUser = await prisma.user.findFirst({
        where: {
          id: userId,
          centerId,
        },
      });

      if (!targetUser) {
        return res.status(404).json({
          error: "المستخدم غير موجود أو لا يتبع سنترك",
        });
      }

      if (targetUser.role === "ADMIN" && targetUser.id === 1) {
        return res.status(403).json({ error: "لا يمكن حذف الأدمن الرئيسي" });
      }

      await prisma.activityLog.deleteMany({
        where: { userId },
      });

      await prisma.user.delete({
        where: { id: userId },
      });

      res.json({ message: "تم حذف المستخدم وسجلات نشاطه بنجاح" });
    } catch (error) {
      console.error("خطأ في حذف مستخدم:", error);
      if (error.code === "P2003" || error.message.includes("foreign key")) {
        return res.status(400).json({
          error: "لا يمكن حذف المستخدم لوجود بيانات مرتبطة أخرى",
        });
      }
      res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
    }
  },
);

module.exports = router;