const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// استدعاء الميدلويرز المتاحة فعليًا من ملف auth
const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
} = require("../middleware/auth");

// تجميعة الحراس الأساسية لتأمين كافة مسارات المدرسين
const commonGuards = [
  authenticateToken,
  requireCenterAccess,
  requireActiveSubscription,
];

// =============================================
// ميدلوير التحقق من مدخلات المدرس والأسعار (صحيح ودقيق 100%)
// =============================================
const validateTeacherInput = (req, res, next) => {
  const { name, subject, priceConfigs } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "اسم المدرس مطلوب ولا يمكن تركه فارغاً" });
  }
  if (!subject || !subject.trim()) {
    return res.status(400).json({ error: "المادة التي يدرسها المدرس مطلوبة" });
  }

  // التحقق من الأسعار في حالة إرسالها (مطلوبة في الـ POST، واختيارية في الـ PUT)
  if (req.method === "POST" || (req.method === "PUT" && priceConfigs)) {
    if (!priceConfigs || !Array.isArray(priceConfigs) || priceConfigs.length === 0) {
      return res.status(400).json({ error: "يجب تحديد حزمة أسعار واحدة على الأقل للمدرس" });
    }

    for (const [index, config] of priceConfigs.entries()) {
      if (!config.stage || !["PRIMARY", "MIDDLE", "HIGH"].includes(config.stage)) {
        return res.status(400).json({ error: `المرحلة الدراسية غير صالحة في الحزمة رقم ${index + 1}` });
      }

      if (!config.grades || !Array.isArray(config.grades) || config.grades.length === 0) {
        return res.status(400).json({ error: `يجب تحديد سنة دراسية واحدة على الأقل (grades) في الحزمة رقم ${index + 1}` });
      }

      // التأكد أن السنوات أرقام صحيحة
      for (const grade of config.grades) {
        if (typeof grade !== "number" || grade < 1) {
          return res.status(400).json({ error: `السنوات الدراسية يجب أن تكون أرقاماً صحيحة داخل الحزمة رقم ${index + 1}` });
        }
      }

      if (typeof config.price !== "number" || config.price < 0) {
        return res.status(400).json({ error: `السعر يجب أن يكون رقماً موجباً في الحزمة رقم ${index + 1}` });
      }

      if (!config.subscriptionType || !["PER_SESSION", "MONTHLY", "HALF_MONTH", "COURSE"].includes(config.subscriptionType)) {
        return res.status(400).json({ error: `نوع الاشتراك غير صالح في الحزمة رقم ${index + 1}` });
      }
    }
  }

  next();
};

// =============================================
// 1. إضافة مدرس جديد مع حزم الأسعار (ADMIN, SECRETARY)
// =============================================
router.post("/", commonGuards, requireRole(["ADMIN", "SECRETARY"]), validateTeacherInput, async (req, res) => {
  try {
    const { name, subject, phone, priceConfigs } = req.body;
    const { centerId, userId } = req.user;

    // منع تكرار اسم المدرس في نفس السنتر منعاً للارتباك
    const existingTeacher = await prisma.teacher.findFirst({
      where: { name: name.trim(), centerId }
    });

    if (existingTeacher) {
      return res.status(400).json({ error: "هذا المدرس مسجل بالفعل في السنتر" });
    }

    // إنشاء المدرس والأسعار في خطوة واحدة
    const newTeacher = await prisma.teacher.create({
      data: {
        name: name.trim(),
        subject: subject.trim(),
        phone: phone ? phone.trim() : null,
        centerId
      }
    });

    // معالجة وإدخال الأسعار
    for (const config of priceConfigs) {
      const finalPrice = Math.round(config.price);

      // أ) حفظ السعر الأساسي المكتوب
      await prisma.priceConfiguration.create({
        data: {
          teacherId: newTeacher.id,
          stage: config.stage,
          grades: config.grades,
          subscriptionType: config.subscriptionType,
          price: finalPrice
        }
      });

      // ب) التوليد التلقائي لنصف الشهر لو السعر المكتوب هو شهري (MONTHLY) تيسيراً على المستخدم
      if (config.subscriptionType === "MONTHLY") {
        await prisma.priceConfiguration.create({
          data: {
            teacherId: newTeacher.id,
            stage: config.stage,
            grades: config.grades,
            subscriptionType: "HALF_MONTH",
            price: Math.round(finalPrice / 2)
          }
        });
      }
    }

    // جلب المدرس بكامل بياناته لعرضها
    const result = await prisma.teacher.findUnique({
      where: { id: newTeacher.id },
      include: { priceConfigs: true }
    });

    // تسجيل العملية في الـ Activity Logs
    await prisma.activityLog.create({
      data: {
        centerId,
        userId,
        action: "CREATE_TEACHER",
        targetType: "Teacher",
        targetId: newTeacher.id,
        details: JSON.stringify({ name: result.name, subject: result.subject })
      }
    });

    res.status(201).json({
      success: true,
      message: "تم تسجيل المدرس وإعداد الحزم السعرية بنجاح 👨‍🏫",
      teacher: result
    });

  } catch (error) {
    console.error("❌ Error adding teacher:", error);
    res.status(500).json({ error: "حدث خطأ داخلي أثناء إضافة المدرس" });
  }
});

// =============================================
// 2. جلب جميع المدرسين في السنتر مع إحصائيات حية ممتازة (ADMIN, SECRETARY)
// =============================================
router.get("/", commonGuards, requireRole(["ADMIN", "SECRETARY"]), async (req, res) => {
  try {
    const { centerId } = req.user;

    // جلب المدرسين وتضمين السيشنز والاشتراكات النشطة بداخلها فوراً للاحتساب الذكي
    const teachers = await prisma.teacher.findMany({
      where: { centerId },
      include: { 
        priceConfigs: true,
        sessions: {
          include: {
            subscriptionItems: {
              where: {
                subscription: { status: "ACTIVE" }
              }
            }
          }
        }
      },
      orderBy: { name: "asc" }
    });

    // معالجة البيانات لإظهار قوة ومستوى الداشبورد (لوحة تحكم إدارية أسطورية)
    const processedTeachers = teachers.map(teacher => {
      let totalActiveStudentsCount = 0;
      let totalEstimatedRevenue = 0;

      teacher.sessions.forEach(session => {
        totalActiveStudentsCount += session.subscriptionItems.length;
        totalEstimatedRevenue += session.subscriptionItems.reduce((sum, item) => sum + item.priceSnapshot, 0);
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
          totalEstimatedRevenue
        }
      };
    });

    res.json({ success: true, count: processedTeachers.length, teachers: processedTeachers });
  } catch (error) {
    console.error("❌ Error fetching teachers:", error);
    res.status(500).json({ error: "حدث خطأ أثناء جلب المدرسين" });
  }
});

// =============================================
// 3. تعديل بيانات وحزم أسعار مدرس (ADMIN فقط 🔒)
// =============================================
router.put("/:id", commonGuards, requireRole(["ADMIN"]), validateTeacherInput, async (req, res) => {
  try {
    const teacherId = parseInt(req.params.id);
    const { centerId, userId } = req.user;
    const { name, subject, phone, priceConfigs } = req.body;

    if (isNaN(teacherId)) return res.status(400).json({ error: "معرف المدرس غير صحيح" });

    // التأكد أن المدرس يخص هذا السنتر
    const teacher = await prisma.teacher.findFirst({
      where: { id: teacherId, centerId }
    });

    if (!teacher) {
      return res.status(404).json({ error: "المدرس غير موجود أو لا تملك صلاحية تعديله" });
    }

    // تحديث البيانات الأساسية
    const updatedTeacher = await prisma.teacher.update({
      where: { id: teacherId },
      data: {
        name: name ? name.trim() : teacher.name,
        subject: subject ? subject.trim() : teacher.subject,
        phone: phone !== undefined ? phone : teacher.phone
      }
    });

    // تحديث الأسعار إن وجدت (مسح القديم وبناء الجديد لضمان المزامنة التامة)
    if (priceConfigs) {
      await prisma.priceConfiguration.deleteMany({
        where: { teacherId }
      });

      for (const config of priceConfigs) {
        const finalPrice = Math.round(config.price);

        await prisma.priceConfiguration.create({
          data: {
            teacherId,
            stage: config.stage,
            grades: config.grades,
            subscriptionType: config.subscriptionType,
            price: finalPrice
          }
        });

        if (config.subscriptionType === "MONTHLY") {
          await prisma.priceConfiguration.create({
            data: {
              teacherId,
              stage: config.stage,
              grades: config.grades,
              subscriptionType: "HALF_MONTH",
              price: Math.round(finalPrice / 2)
            }
          });
        }
      }
    }

    const result = await prisma.teacher.findUnique({
      where: { id: teacherId },
      include: { priceConfigs: true }
    });

    await prisma.activityLog.create({
      data: {
        centerId,
        userId,
        action: "UPDATE_TEACHER",
        targetType: "Teacher",
        targetId: teacherId,
        details: JSON.stringify({ name: result.name })
      }
    });

    res.json({ success: true, message: "تم تعديل بيانات المدرس وحزم الأسعار بنجاح ✅", teacher: result });

  } catch (error) {
    console.error("❌ Error updating teacher:", error);
    res.status(500).json({ error: "حدث خطأ أثناء تعديل بيانات المدرس" });
  }
});

// =============================================
// 4. حذف مدرس نهائياً بحماية متبادلة صارمة (ADMIN فقط 🔒)
// =============================================
router.delete("/:id", commonGuards, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const teacherId = parseInt(req.params.id);
    const { centerId, userId } = req.user;

    if (isNaN(teacherId)) return res.status(400).json({ error: "معرف المدرس غير صحيح" });

    // 1. التأكد أن المدرس يخص السنتر وجلب إحصائيات التبعية
    const teacher = await prisma.teacher.findFirst({
      where: { id: teacherId, centerId },
      include: {
        sessions: {
          include: {
            _count: {
              select: { subscriptionItems: true, attendance: true }
            }
          }
        }
      }
    });

    if (!teacher) {
      return res.status(404).json({ error: "المدرس غير موجود لحذفه" });
    }

    // 2. هندسة التحقق الذكي 🧠: تجميع كل المعلقات لمنع الكارثة التعليمية والمالية
    let totalEnrolledStudents = 0;
    let totalAttendanceLogs = 0;
    const sessionIds = [];

    teacher.sessions.forEach(session => {
      sessionIds.push(session.id);
      totalEnrolledStudents += session._count.subscriptionItems;
      totalAttendanceLogs += session._count.attendance;
    });

    // جدار أمان السيستم المستقر:
    if (totalEnrolledStudents > 0 || totalAttendanceLogs > 0) {
      return res.status(400).json({
        error: `عذراً يا هندسة، لا يمكن حذف هذا المدرس لوجود مجموعات نشطة تابعة له تحتوي على عدد (${totalEnrolledStudents}) طالب مشترك، أو لوجود عدد (${totalAttendanceLogs}) سجل حضور وغياب محفوظ باسمه. يرجى نقل الطلاب وحذف مجموعات المدرس أولاً لتصفية حسابه بالأمان الكامل.`
      });
    }

    // 3. مسح آمن بـ DB Transaction لكل البيانات الفارغة الباقية للمدرس (الأسعار، الحصص الفاضية، والمدرس نفسه)
    await prisma.$transaction([
      prisma.priceConfiguration.deleteMany({ where: { teacherId } }),
      prisma.session.deleteMany({ where: { teacherId } }),
      prisma.teacher.delete({ where: { id: teacherId } })
    ]);

    await prisma.activityLog.create({
      data: {
        centerId,
        userId,
        action: "DELETE_TEACHER",
        targetType: "Teacher",
        targetId: teacherId,
        details: JSON.stringify({ name: teacher.name })
      }
    });

    res.json({ success: true, message: "تم حذف المدرس وكافة الجداول والأسعار الفارغة المرتبطة به بنجاح 🗑️" });

  } catch (error) {
    console.error("❌ Error deleting teacher:", error);
    res.status(500).json({ error: "حدث خطأ داخلي أثناء محاولة حذف المدرس" });
  }
});

module.exports = router;