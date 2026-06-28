const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// استدعاء الميدلويرز المتاحة والمؤمنة للسنتر
const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
} = require("../middleware/auth");

// تجميعة الحراس الأساسية لتأمين كافة مسارات المدرسين على مستوى نظام الـ SaaS
const commonGuards = [
  authenticateToken,
  requireCenterAccess,
  requireActiveSubscription,
];

// =============================================
// ميدلوير التحقق الشامل والدقيق من مدخلات المدرس وحزم الأسعار
// =============================================
const validateTeacherInput = (req, res, next) => {
  const { name, subject, priceConfigs } = req.body;

  if (!name || !name.trim()) {
    return res
      .status(400)
      .json({ error: "اسم المدرس مطلوب ولا يمكن تركه فارغاً" });
  }
  if (!subject || !subject.trim()) {
    return res.status(400).json({ error: "المادة التي يدرسها المدرس مطلوبة" });
  }

  // التحقق من الأسعار (مطلوبة إجبارياً في الـ POST، واختيارية في الـ PUT لتحديث البيانات الأساسية فقط إن لم تُرسل)
  if (req.method === "POST" || (req.method === "PUT" && priceConfigs)) {
    if (
      !priceConfigs ||
      !Array.isArray(priceConfigs) ||
      priceConfigs.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "يجب تحديد حزمة أسعار واحدة على الأقل للمدرس" });
    }

    for (const [index, config] of priceConfigs.entries()) {
      const packageNum = index + 1;

      // 1. التحقق من المرحلة الدراسية
      if (
        !config.stage ||
        !["PRIMARY", "MIDDLE", "HIGH"].includes(config.stage)
      ) {
        return res
          .status(400)
          .json({
            error: `المرحلة الدراسية غير صالحة في الحزمة رقم ${packageNum}`,
          });
      }

      // 2. التحقق من السنوات الدراسية داخل المرحلة
      if (
        !config.grades ||
        !Array.isArray(config.grades) ||
        config.grades.length === 0
      ) {
        return res
          .status(400)
          .json({
            error: `يجب تحديد سنة دراسية واحدة على الأقل (grades) في الحزمة رقم ${packageNum}`,
          });
      }

      for (const grade of config.grades) {
        if (typeof grade !== "number" || grade < 1) {
          return res
            .status(400)
            .json({
              error: `السنوات الدراسية يجب أن تكون أرقاماً صحيحة داخل الحزمة رقم ${packageNum}`,
            });
        }
      }

      // 3. التحقق من قيمة السعر نفسه
      if (typeof config.price !== "number" || config.price < 0) {
        return res
          .status(400)
          .json({
            error: `السعر يجب أن يكون رقماً موجباً في الحزمة رقم ${packageNum}`,
          });
      }

      // 4. التحقق من نوع الاشتراك المعتمد بالـ Schema
      if (
        !config.subscriptionType ||
        !["PER_SESSION", "MONTHLY", "HALF_MONTH", "COURSE"].includes(
          config.subscriptionType,
        )
      ) {
        return res
          .status(400)
          .json({ error: `نوع الاشتراك غير صالح في الحزمة رقم ${packageNum}` });
      }

      // ✨ الهندسة الذكية الجديدة: التحقق من حقول المدد المضافة حديثاً لـ "COURSE" و "PER_SESSION"
      if (config.subscriptionType === "COURSE") {
        if (
          config.durationMonths === undefined ||
          config.durationMonths === null ||
          typeof config.durationMonths !== "number" ||
          config.durationMonths < 1
        ) {
          return res
            .status(400)
            .json({
              error: `يا هندسة، حزمة الكورس رقم ${packageNum} تتطلب تحديد مدة الكورس بالشهور (durationMonths) بشكل صحيح ولا تقل عن شهر واحد`,
            });
        }
      }

      // التحقق الاختياري أو الإجباري من عدد الحصص الافتراضي إن وُجد
      if (config.totalSessions !== undefined && config.totalSessions !== null) {
        if (
          typeof config.totalSessions !== "number" ||
          config.totalSessions < 1
        ) {
          return res
            .status(400)
            .json({
              error: `عدد الحصص الإجمالي (totalSessions) يجب أن يكون رقماً صحيحاً موجباً في الحزمة رقم ${packageNum}`,
            });
        }
      }
    }
  }

  next();
};

// =============================================
// 1. إضافة مدرس جديد مع حزم الأسعار المتكاملة (ADMIN, SECRETARY)
// =============================================
router.post(
  "/",
  commonGuards,
  requireRole(["ADMIN", "SECRETARY"]),
  validateTeacherInput,
  async (req, res) => {
    try {
      const { name, subject, phone, priceConfigs } = req.body;
      const { centerId, userId } = req.user;

      // منع تكرار اسم المدرس في نفس السنتر منعاً للارتباك في التقارير
      const existingTeacher = await prisma.teacher.findFirst({
        where: { name: name.trim(), centerId },
      });

      if (existingTeacher) {
        return res
          .status(400)
          .json({ error: "هذا المدرس مسجل بالفعل في السنتر الحالي" });
      }

      // استخدام الـ Database Transaction لضمان استقرار وحفظ البيانات دفعة واحدة دون شوائب
      const result = await prisma.$transaction(async (tx) => {
        // أ) إنشاء المدرس الأساسي
        const newTeacher = await tx.teacher.create({
          data: {
            name: name.trim(),
            subject: subject.trim(),
            phone: phone ? phone.trim() : null,
            centerId,
          },
        });

        // ب) إدخال حزم الأسعار بالتفاصيل الجديدة
        for (const config of priceConfigs) {
          const finalPrice = Math.round(config.price);

          await tx.priceConfiguration.create({
            data: {
              teacherId: newTeacher.id,
              stage: config.stage,
              grades: config.grades,
              subscriptionType: config.subscriptionType,
              price: finalPrice,
              durationMonths:
                config.subscriptionType === "COURSE"
                  ? config.durationMonths
                  : null,
              totalSessions: config.totalSessions || null,
            },
          });

          // ج) التوليد التلقائي الذكي لنصف الشهر لو السعر المكتوب هو شهري (MONTHLY) تخفيفاً على يد الإدخال
          if (config.subscriptionType === "MONTHLY") {
            await tx.priceConfiguration.create({
              data: {
                teacherId: newTeacher.id,
                stage: config.stage,
                grades: config.grades,
                subscriptionType: "HALF_MONTH",
                price: Math.round(finalPrice / 2),
                durationMonths: null,
                totalSessions: config.totalSessions
                  ? Math.round(config.totalSessions / 2)
                  : null,
              },
            });
          }
        }

        // جلب المدرس بكامل بياناته ليعود للاستجابة فوراً جاهز ومكتمل
        return await tx.teacher.findUnique({
          where: { id: newTeacher.id },
          include: { priceConfigs: true },
        });
      });

      // تسجيل العملية في الـ Activity Logs للتتبع الإداري الصارم
      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "CREATE_TEACHER",
          targetType: "Teacher",
          targetId: result.id,
          details: JSON.stringify({
            name: result.name,
            subject: result.subject,
            packagesCount: result.priceConfigs.length,
          }),
        },
      });

      res.status(201).json({
        success: true,
        message: "تم تسجيل المدرس وإعداد الحزم السعرية المحدثة بنجاح 👨‍🏫",
        teacher: result,
      });
    } catch (error) {
      console.error("❌ Error adding teacher with detailed prices:", error);
      res
        .status(500)
        .json({ error: "حدث خطأ داخلي أثناء إضافة المدرس والمدد المرتبطة به" });
    }
  },
);

// =============================================
// 2. جلب المدرسين مع لوحة إحصائيات حية جبارة (ADMIN, SECRETARY)
// =============================================
router.get(
  "/",
  commonGuards,
  requireRole(["ADMIN", "SECRETARY"]),
  async (req, res) => {
    try {
      const { centerId } = req.user;

      // جلب المدرسين وتضمين المجموعات والاشتراكات النشطة بداخلها فوراً للاحتساب الذكي
      const teachers = await prisma.teacher.findMany({
        where: { centerId },
        include: {
          priceConfigs: true,
          sessions: {
            include: {
              subscriptionItems: {
                where: {
                  subscription: { status: "ACTIVE" },
                },
              },
            },
          },
        },
        orderBy: { name: "asc" },
      });

      // معالجة البيانات لإظهار قوة ومستوى الداشبورد (لوحة تحكم إدارية متكاملة)
      const processedTeachers = teachers.map((teacher) => {
        let totalActiveStudentsCount = 0;
        let totalEstimatedRevenue = 0;

        teacher.sessions.forEach((session) => {
          totalActiveStudentsCount += session.subscriptionItems.length;
          totalEstimatedRevenue += session.subscriptionItems.reduce(
            (sum, item) => sum + item.priceSnapshot,
            0,
          );
        });

        return {
          id: teacher.id,
          name: teacher.name,
          subject: teacher.subject,
          phone: teacher.phone,
          createdAt: teacher.createdAt,
          priceConfigs: teacher.priceConfigs,
          stats: {
            totalSessionsCount: teacher.sessions.length,
            totalActiveStudentsCount,
            totalEstimatedRevenue,
          },
        };
      });

      res.json({
        success: true,
        count: processedTeachers.length,
        teachers: processedTeachers,
      });
    } catch (error) {
      console.error("❌ Error fetching teachers:", error);
      res.status(500).json({ error: "حدث خطأ أثناء جلب المدرسين والإحصائيات" });
    }
  },
);

// =============================================
// 3. تعديل بيانات وحزم أسعار المدرس بالكامل (ADMIN فقط 🔒)
// =============================================
router.put(
  "/:id",
  commonGuards,
  requireRole(["ADMIN"]),
  validateTeacherInput,
  async (req, res) => {
    try {
      const teacherId = parseInt(req.params.id);
      const { centerId, userId } = req.user;
      const { name, subject, phone, priceConfigs } = req.body;

      if (isNaN(teacherId))
        return res.status(400).json({ error: "معرف المدرس غير صحيح" });

      // التأكد التام أن المدرس يخص هذا السنتر من أجل حماية البيانات
      const teacher = await prisma.teacher.findFirst({
        where: { id: teacherId, centerId },
      });

      if (!teacher) {
        return res
          .status(404)
          .json({ error: "المدرس غير موجود أو لا تملك صلاحية تعديله" });
      }

      const updatedResult = await prisma.$transaction(async (tx) => {
        // أ) تحديث البيانات الأساسية للمدرس
        await tx.teacher.update({
          where: { id: teacherId },
          data: {
            name: name ? name.trim() : teacher.name,
            subject: subject ? subject.trim() : teacher.subject,
            phone: phone !== undefined ? phone : teacher.phone,
          },
        });

        // ب) تحديث الأسعار والمدد إن وجدت (نظام المسح الإحلالي لضمان تماسك البيانات ومزامنتها)
        if (priceConfigs) {
          await tx.priceConfiguration.deleteMany({
            where: { teacherId },
          });

          for (const config of priceConfigs) {
            const finalPrice = Math.round(config.price);

            await tx.priceConfiguration.create({
              data: {
                teacherId,
                stage: config.stage,
                grades: config.grades,
                subscriptionType: config.subscriptionType,
                price: finalPrice,
                durationMonths:
                  config.subscriptionType === "COURSE"
                    ? config.durationMonths
                    : null,
                totalSessions: config.totalSessions || null,
              },
            });

            // إعادة بناء العرض التلقائي لنصف الشهر لو الحزمة المعدلة شهرية
            if (config.subscriptionType === "MONTHLY") {
              await tx.priceConfiguration.create({
                data: {
                  teacherId,
                  stage: config.stage,
                  grades: config.grades,
                  subscriptionType: "HALF_MONTH",
                  price: Math.round(finalPrice / 2),
                  durationMonths: null,
                  totalSessions: config.totalSessions
                    ? Math.round(config.totalSessions / 2)
                    : null,
                },
              });
            }
          }
        }

        return await tx.teacher.findUnique({
          where: { id: teacherId },
          include: { priceConfigs: true },
        });
      });

      // تسجيل تحديث المدرس في الـ Logs
      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "UPDATE_TEACHER",
          targetType: "Teacher",
          targetId: teacherId,
          details: JSON.stringify({
            name: updatedResult.name,
            subject: updatedResult.subject,
          }),
        },
      });

      res.json({
        success: true,
        message: "تم تعديل بيانات المدرس وحزم المدد والأسعار بنجاح ✅",
        teacher: updatedResult,
      });
    } catch (error) {
      console.error("❌ Error updating teacher:", error);
      res.status(500).json({ error: "حدث خطأ أثناء تعديل بيانات وحزم المدرس" });
    }
  },
);

// =============================================
// 4. حذف مدرس نهائياً بحماية متبادلة صارمة (ADMIN فقط 🔒)
// =============================================
router.delete(
  "/:id",
  commonGuards,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const teacherId = parseInt(req.params.id);
      const { centerId, userId } = req.user;

      if (isNaN(teacherId))
        return res.status(400).json({ error: "معرف المدرس غير صحيح" });

      // 1. التأكد أن المدرس يخص السنتر وجلب إحصائيات التبعية لسلامة النظام الإداري والمالي
      const teacher = await prisma.teacher.findFirst({
        where: { id: teacherId, centerId },
        include: {
          sessions: {
            include: {
              _count: {
                select: { subscriptionItems: true, attendance: true },
              },
            },
          },
        },
      });

      if (!teacher) {
        return res.status(404).json({ error: "المدرس غير موجود لحذفه" });
      }

      // 2. هندسة التحقق الذكي 🧠: تجميع كافة المجموعات النشطة لمنع حذف كتل البيانات الحيوية
      let totalEnrolledStudents = 0;
      let totalAttendanceLogs = 0;

      teacher.sessions.forEach((session) => {
        totalEnrolledStudents += session._count.subscriptionItems;
        totalAttendanceLogs += session._count.attendance;
      });

      // جدار أمان السيستم المستقر والمانع للغلطات الكارثية:
      if (totalEnrolledStudents > 0 || totalAttendanceLogs > 0) {
        return res.status(400).json({
          error: `عذراً يا هندسة، لا يمكن حذف هذا المدرس لوجود مجموعات نشطة تابعة له تحتوي على عدد (${totalEnrolledStudents}) طالب مشترك، أو لوجود عدد (${totalAttendanceLogs}) سجل حضور وغياب محفوظ باسمه. يرجى نقل الطلاب وحذف مجموعات المدرس أولاً لتصفية حسابه بالأمان الكامل.`,
        });
      }

      // 3. مسح آمن وشامل بـ DB Transaction لكل البيانات الفارغة الباقية للمدرس (الأسعار، المجموعات الخالية، والمدرس نفسه)
      await prisma.$transaction([
        prisma.priceConfiguration.deleteMany({ where: { teacherId } }),
        prisma.session.deleteMany({ where: { teacherId } }),
        prisma.teacher.delete({ where: { id: teacherId } }),
      ]);

      // تسجيل الحذف النهائي في الـ Logs
      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "DELETE_TEACHER",
          targetType: "Teacher",
          targetId: teacherId,
          details: JSON.stringify({ name: teacher.name }),
        },
      });

      res.json({
        success: true,
        message:
          "تم حذف المدرس وكافة المجموعات والأسعار الفارغة المرتبطة به بنجاح 🗑️",
      });
    } catch (error) {
      console.error("❌ Error deleting teacher:", error);
      res.status(500).json({ error: "حدث خطأ داخلي أثناء محاولة حذف المدرس" });
    }
  },
);

module.exports = router;
