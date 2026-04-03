const express = require("express");
const { PrismaClient } = require("@prisma/client");
const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
} = require("../middleware/auth");

const { sendAutoSms } = require("../utils/smsUtils");

const router = express.Router();
const prisma = new PrismaClient();

// =============================================
// ميدلوير التحقق من الإدخال
// =============================================
const validateStudentInput = (req, res, next) => {
  const { name, phone, stage, subscriptions } = req.body;

  if (!name?.trim() || !phone?.trim()) {
    return res.status(400).json({ error: "اسم الطالب ورقم التليفون مطلوبين" });
  }

  if (!stage || !["PRIMARY", "MIDDLE", "HIGH"].includes(stage)) {
    return res
      .status(400)
      .json({ error: "المرحلة غير صالحة (PRIMARY, MIDDLE, HIGH فقط)" });
  }

  if (subscriptions && !Array.isArray(subscriptions)) {
    return res.status(400).json({ error: "subscriptions يجب أن تكون مصفوفة" });
  }

  next();
};

// دالة مساعدة لحساب تاريخ النهاية تلقائيًا (تم تعديلها لضبط نهاية اليوم)
const calculateEndDate = (subscriptionType, durationInMonths = 1) => {
  const end = new Date();
  // ضبط الوقت ليكون نهاية اليوم 23:59:59 لضمان الاستفادة من اليوم كاملاً
  end.setHours(23, 59, 59, 999);

  if (subscriptionType === "MONTHLY") end.setMonth(end.getMonth() + 1);
  else if (subscriptionType === "HALF_MONTH") end.setDate(end.getDate() + 15);
  else if (subscriptionType === "COURSE")
    end.setMonth(end.getMonth() + durationInMonths);
  return end;
};

// دالة لمعالجة حالة الطالب برمجياً (The Magic Part)
const mapStudentStatus = (student) => {
  const now = new Date();

  // تحديث حالة كل اشتراك بناءً على التاريخ الحالي
  const updatedSubscriptions = student.subscriptions.map((sub) => {
    const isExpired = new Date(sub.endDate) < now;
    return {
      ...sub,
      status: isExpired ? "EXPIRED" : sub.status, // تحويل الحالة لحظياً لو الوقت انتهى
    };
  });

  // الطالب يعتبر نشط فقط لو عنده اشتراك واحد على الأقل مش منتهي
  const hasActiveSub = updatedSubscriptions.some(
    (sub) => sub.status === "ACTIVE",
  );

  return {
    ...student,
    subscriptions: updatedSubscriptions,
    computedStatus: hasActiveSub ? "ACTIVE" : "EXPIRED",
  };
};

// =============================================
// POST /api/students - إضافة طالب + اشتراكات
// =============================================
router.post(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  validateStudentInput,
  async (req, res) => {
    try {
      const { name, phone, stage, groupId, subscriptions } = req.body;
      const { centerId, userId } = req.user;

      const result = await prisma.$transaction(async (tx) => {
        const newStudent = await tx.student.create({
          data: {
            name: name.trim(),
            phone: phone.trim(),
            stage,
            groupId: groupId ? Number(groupId) : null,
            centerId,
          },
        });

        let createdSubscriptions = [];

        if (subscriptions?.length > 0) {
          for (const sub of subscriptions) {
            const subscriptionType = sub.subscriptionType;

            // جلب مدة الكورس لو النوع كورس
            let durationInMonths = 1;
            if (subscriptionType === "COURSE") {
              const coursePrice = await tx.subjectPrice.findFirst({
                where: {
                  subjectId: Number(sub.items[0].subjectId),
                  stage,
                  subscriptionType: "COURSE",
                },
              });
              durationInMonths = coursePrice?.durationInMonths || 1;
            }

            const startDate = new Date();
            const endDate = calculateEndDate(
              subscriptionType,
              durationInMonths,
            );

            // حساب السعر الإجمالي وتجهيز المواد
            let totalPrice = 0;
            const itemsToCreate = [];

            for (const item of sub.items) {
              const priceRecord = await tx.subjectPrice.findUnique({
                where: {
                  subjectId_stage_subscriptionType: {
                    subjectId: Number(item.subjectId),
                    stage,
                    subscriptionType,
                  },
                },
              });

              let finalPrice = priceRecord?.price || 0;

              // Fallback لنصف الشهر
              if (!priceRecord && subscriptionType === "HALF_MONTH") {
                const monthly = await tx.subjectPrice.findUnique({
                  where: {
                    subjectId_stage_subscriptionType: {
                      subjectId: Number(item.subjectId),
                      stage,
                      subscriptionType: "MONTHLY",
                    },
                  },
                });
                if (monthly) finalPrice = monthly.price / 2;
              }

              totalPrice += finalPrice;
              itemsToCreate.push({
                subjectId: Number(item.subjectId),
                priceSnapshot: finalPrice,
              });
            }

            const newSub = await tx.subscription.create({
              data: {
                studentId: newStudent.id,
                startDate,
                endDate,
                subscriptionType,
                totalPrice,
                status: "ACTIVE",
                createdBy: userId,
                items: {
                  create: itemsToCreate,
                },
              },
            });
            createdSubscriptions.push(newSub);
          }
        }
        return { newStudent, createdSubscriptions };
      });

      await sendAutoSms(result.newStudent.id, "FIRST_SUB");

      res.status(201).json({
        message: "تم إضافة الطالب بنجاح",
        student: result.newStudent,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// =============================================
// GET /api/students - عرض الطلاب (مع تحديث الحالة اللحظي)
// =============================================
router.get(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId } = req.user;
      const { name, stage, page = 1, limit = 20 } = req.query;

      const where = { centerId };
      if (name) where.name = { contains: name.trim(), mode: "insensitive" };
      if (stage) where.stage = stage;

      const [students, total] = await Promise.all([
        prisma.student.findMany({
          where,
          include: {
            group: { select: { name: true } },
            subscriptions: {
              include: {
                items: { include: { subject: { select: { name: true } } } },
              },
            },
          },
          orderBy: { name: "asc" },
          skip: (Number(page) - 1) * Number(limit),
          take: Number(limit),
        }),
        prisma.student.count({ where }),
      ]);

      // تطبيق منطق فحص انتهاء التاريخ على كل طالب
      const processedData = students.map((student) =>
        mapStudentStatus(student),
      );

      res.json({
        success: true,
        pagination: {
          total,
          page: Number(page),
          totalPages: Math.ceil(total / limit),
        },
        data: processedData,
      });
    } catch (error) {
      res.status(500).json({ error: "حصل خطأ داخلي" });
    }
  },
);

// =============================================
// GET /api/students/:id (مع تحديث الحالة اللحظي)
// =============================================
router.get(
  "/:id",
  authenticateToken,
  requireActiveSubscription,
  requireCenterAccess,
  async (req, res) => {
    try {
      const student = await prisma.student.findFirst({
        where: { id: Number(req.params.id), centerId: req.user.centerId },
        include: {
          group: true,
          subscriptions: { include: { items: { include: { subject: true } } } },
        },
      });

      if (!student) return res.status(404).json({ error: "الطالب غير موجود" });

      res.json({ success: true, student: mapStudentStatus(student) });
    } catch (error) {
      res.status(500).json({ error: "خطأ في السيرفر" });
    }
  },
);
// =============================================
// PUT /api/students/:id - تعديل طالب
// =============================================
router.put(
  "/:id",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  validateStudentInput,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { name, phone, stage, groupId } = req.body;
      const { centerId, userId } = req.user;

      const student = await prisma.student.findFirst({
        where: { id: Number(id), centerId },
      });
      if (!student)
        return res
          .status(404)
          .json({ error: "الطالب غير موجود أو لا يتبع سنترك" });

      const dataToUpdate = {};
      if (name?.trim()) dataToUpdate.name = name.trim();
      if (phone?.trim()) dataToUpdate.phone = phone.trim();
      if (stage) dataToUpdate.stage = stage;
      if (groupId !== undefined)
        dataToUpdate.groupId = groupId ? Number(groupId) : null;

      if (Object.keys(dataToUpdate).length === 0)
        return res.status(400).json({ error: "لا توجد بيانات لتعديلها" });

      const updatedStudent = await prisma.student.update({
        where: { id: Number(id) },
        data: dataToUpdate,
      });

      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "UPDATE_STUDENT",
          targetType: "Student",
          targetId: updatedStudent.id,
          details: JSON.stringify({ updatedFields: Object.keys(dataToUpdate) }),
        },
      });

      res.json({ message: "تم تعديل الطالب بنجاح", student: updatedStudent });
    } catch (error) {
      console.error("خطأ في تعديل طالب:", error);
      res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
    }
  },
);

// =============================================
// DELETE /api/students/:id - حذف طالب مع اشتراكاته
// =============================================
router.delete(
  "/:id",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { centerId, userId } = req.user;
      const studentId = Number(id);

      // التأكد من وجود الطالب وتبعينه للسنتر
      const student = await prisma.student.findFirst({
        where: { id: studentId, centerId },
      });

      if (!student) {
        return res
          .status(404)
          .json({ error: "الطالب غير موجود أو لا يتبع سنترك" });
      }

      // تنفيذ الحذف في Transaction لضمان مسح كل المتعلقات معاً
      await prisma.$transaction(async (tx) => {
        // 1. جلب معرفات الاشتراكات التابعة للطالب
        const subs = await tx.subscription.findMany({
          where: { studentId: studentId },
          select: { id: true },
        });
        const subIds = subs.map((s) => s.id);

        // 2. حذف تفاصيل المواد داخل الاشتراكات (Items)
        if (subIds.length > 0) {
          await tx.subscriptionItem.deleteMany({
            where: { subscriptionId: { in: subIds } },
          });
        }

        // 3. حذف الاشتراكات نفسها
        await tx.subscription.deleteMany({
          where: { studentId: studentId },
        });

        // 4. حذف الطالب نهائياً
        await tx.student.delete({
          where: { id: studentId },
        });

        // 5. تسجيل العملية في سجل النشاطات
        await tx.activityLog.create({
          data: {
            centerId,
            userId,
            action: "DELETE_STUDENT",
            targetType: "Student",
            targetId: studentId,
            details: JSON.stringify({
              name: student.name,
              deletedSubscriptionsCount: subIds.length,
            }),
          },
        });
      });

      res.json({ message: "تم حذف الطالب وجميع متعلقاته بنجاح" });
    } catch (error) {
      console.error("خطأ في حذف طالب:", error);
      res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
    }
  },
);

module.exports = router;
