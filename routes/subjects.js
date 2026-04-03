const express = require("express");
const { PrismaClient } = require("@prisma/client");
const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
} = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// =============================================
// ميدلوير التحقق من إدخال المواد (سهل وقوي)
// =============================================
const validateSubjectsInput = (req, res, next) => {
  const { subjects } = req.body;

  if (!subjects || !Array.isArray(subjects) || subjects.length === 0) {
    return res.status(400).json({
      error: "يجب إرسال مصفوفة 'subjects' تحتوي على مادة واحدة على الأقل",
    });
  }

  for (const [index, subject] of subjects.entries()) {
    if (!subject.name?.trim()) {
      return res.status(400).json({
        error: `اسم المادة مطلوب للمادة رقم ${index + 1}`,
      });
    }

    if (
      !subject.prices ||
      !Array.isArray(subject.prices) ||
      subject.prices.length === 0
    ) {
      return res.status(400).json({
        error: `يجب تحديد أسعار للمادة "${subject.name}"`,
      });
    }

    for (const [pIndex, price] of subject.prices.entries()) {
      if (
        !price.stage ||
        !["PRIMARY", "MIDDLE", "HIGH"].includes(price.stage)
      ) {
        return res.status(400).json({
          error: `المرحلة غير صالحة في سعر رقم ${pIndex + 1} للمادة "${subject.name}"`,
        });
      }

      if (typeof price.price !== "number" || price.price <= 0) {
        return res.status(400).json({
          error: `السعر يجب أن يكون رقم موجب في سعر رقم ${pIndex + 1} للمادة "${subject.name}"`,
        });
      }

      if (
        price.subscriptionType &&
        !["MONTHLY", "COURSE"].includes(price.subscriptionType)
      ) {
        return res.status(400).json({
          error: `نوع الاشتراك غير صالح في سعر رقم ${pIndex + 1} (MONTHLY أو COURSE فقط)`,
        });
      }

      if (price.subscriptionType === "COURSE") {
        if (!price.durationInMonths || price.durationInMonths < 1) {
          return res.status(400).json({
            error: `للكورس يجب تحديد عدد الشهور (durationInMonths) في سعر رقم ${pIndex + 1} للمادة "${subject.name}"`,
          });
        }
      }
    }
  }

  next();
};

// =============================================
// POST /api/subjects - إضافة مادة/مواد (محمي)
// =============================================
router.post(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  validateSubjectsInput,
  async (req, res) => {
    try {
      const { subjects } = req.body;
      const { centerId, userId } = req.user;

      const createdSubjects = [];

      for (const sub of subjects) {
        const newSubject = await prisma.subject.create({
          data: {
            name: sub.name.trim(),
            centerId,
          },
        });

        const processedPrices = [];

        for (const price of sub.prices) {
          const subscriptionType = price.subscriptionType || "MONTHLY";
          const finalPrice = price.price;

          // 1️⃣ احفظ السعر الأصلي زي ما هو
          await prisma.subjectPrice.create({
            data: {
              subjectId: newSubject.id,
              stage: price.stage,
              subscriptionType,
              price: finalPrice,
              durationInMonths: price.durationInMonths || null,
            },
          });

          // 2️⃣ لو النوع MONTHLY → احفظ نسخة نص شهر أوتوماتيك
          if (subscriptionType === "MONTHLY") {
            await prisma.subjectPrice.create({
              data: {
                subjectId: newSubject.id,
                stage: price.stage,
                subscriptionType: "HALF_MONTH",
                price: finalPrice / 2,
                durationInMonths: price.durationInMonths || null,
              },
            });
          }

          // حفظ البيانات للرد
          processedPrices.push({
            stage: price.stage,
            subscriptionType,
            price: finalPrice,
            durationInMonths: price.durationInMonths || null,
          });
        }

        const subjectWithPrices = await prisma.subject.findUnique({
          where: { id: newSubject.id },
          include: { prices: true },
        });

        createdSubjects.push({
          ...subjectWithPrices,
          processedPrices,
        });

        // تسجيل في ActivityLog
        await prisma.activityLog.create({
          data: {
            centerId,
            userId,
            action: "CREATE_SUBJECT",
            targetType: "Subject",
            targetId: newSubject.id,
            details: JSON.stringify({
              name: newSubject.name,
              prices: processedPrices,
            }),
          },
        });
      }

      res.status(201).json({
        message: `تم إضافة ${createdSubjects.length} مادة بنجاح`,
        subjects: createdSubjects,
      });
    } catch (error) {
      console.error("خطأ في إضافة المواد:", error);
      res
        .status(500)
        .json({ error: error.message || "حصل خطأ داخلي في السيرفر" });
    }
  }
);

// =============================================
// باقي الراوت زي ما هو تمام
// =============================================
router.get(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId } = req.user;

      const subjects = await prisma.subject.findMany({
        where: { centerId },
        include: {
          prices: {
            select: {
              id: true,
              stage: true,
              subscriptionType: true,
              price: true,
              activeFrom: true,
            },
          },
        },
        orderBy: { name: "asc" },
      });

      res.json({
        success: true,
        count: subjects.length,
        data: subjects,
      });
    } catch (error) {
      console.error("خطأ في عرض المواد:", error);
      res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
    }
  }
);

router.get(
  "/:id",
  authenticateToken,
  requireActiveSubscription,
  requireCenterAccess,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { centerId } = req.user;

      const subject = await prisma.subject.findFirst({
        where: { id: Number(id), centerId },
        include: { prices: true },
      });

      if (!subject) {
        return res
          .status(404)
          .json({ error: "المادة غير موجودة أو لا تتبع سنترك" });
      }

      res.json({ success: true, subject });
    } catch (error) {
      console.error("خطأ في عرض مادة:", error);
      res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
    }
  }
);

// PUT /api/subjects/:id - تعديل مادة
router.put(
  "/:id",
    authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  validateSubjectsInput,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { name, prices } = req.body;
      const { centerId, userId } = req.user;

      const subject = await prisma.subject.findFirst({
        where: { id: Number(id), centerId },
      });

      if (!subject) {
        return res
          .status(404)
          .json({ error: "المادة غير موجودة أو لا تتبع سنترك" });
      }

      const dataToUpdate = {};
      if (name?.trim()) dataToUpdate.name = name.trim();

      const updatedSubject = await prisma.subject.update({
        where: { id: Number(id) },
        data: dataToUpdate,
      });

      if (prices && Array.isArray(prices)) {
        await prisma.subjectPrice.deleteMany({
          where: { subjectId: Number(id) },
        });

        for (const price of prices) {
          const subscriptionType = price.subscriptionType || "MONTHLY";
          let finalPrice = price.price;

          if (subscriptionType === "HALF_MONTH") finalPrice = price.price / 2;

          await prisma.subjectPrice.create({
            data: {
              subjectId: Number(id),
              stage: price.stage,
              subscriptionType,
              price: finalPrice,
            },
          });
        }
      }

      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "UPDATE_SUBJECT",
          targetType: "Subject",
          targetId: updatedSubject.id,
          details: JSON.stringify({
            updatedFields: Object.keys(dataToUpdate),
            newPrices: prices,
          }),
        },
      });

      const subjectWithPrices = await prisma.subject.findUnique({
        where: { id: Number(id) },
        include: { prices: true },
      });

      res.json({
        message: "تم تعديل المادة بنجاح",
        subject: subjectWithPrices,
      });
    } catch (error) {
      console.error("خطأ في تعديل مادة:", error);
      res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
    }
  },
);

// DELETE /api/subjects/:id - حذف مادة (مع حذف كل ما يرتبط بها)
router.delete(
  "/:id",
    authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const subjectId = Number(id);
      const { centerId, userId } = req.user;

      const subject = await prisma.subject.findFirst({
        where: { id: subjectId, centerId },
      });

      if (!subject) {
        return res
          .status(404)
          .json({ error: "المادة غير موجودة أو لا تتبع سنترك" });
      }

      await prisma.subscriptionItem.deleteMany({ where: { subjectId } });
      await prisma.subjectPrice.deleteMany({ where: { subjectId } });
      await prisma.subject.delete({ where: { id: subjectId } });

      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "DELETE_SUBJECT",
          targetType: "Subject",
          targetId: subjectId,
          details: JSON.stringify({ name: subject.name }),
        },
      });

      res.json({
        message: "تم حذف المادة وكل الاشتراكات والأسعار المرتبطة بها بنجاح",
      });
    } catch (error) {
      console.error("خطأ في حذف مادة:", error);
      if (error.code === "P2003" || error.message.includes("foreign key")) {
        return res.status(400).json({
          error: "لا يمكن حذف المادة لوجود بيانات مرتبطة (تم محاولة حذفها)",
        });
      }
      res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
    }
  },
);

module.exports = router;
