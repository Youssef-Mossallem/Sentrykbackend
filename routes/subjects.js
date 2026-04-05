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
  const { subjects, name, prices } = req.body;

  // التحقق في حالة الـ POST (مصفوفة) أو الـ PUT (كائن واحد)
  const subjectsToValidate = subjects || [{ name, prices }];

  if (!subjectsToValidate[0].name?.trim()) {
    return res.status(400).json({ error: "اسم المادة مطلوب" });
  }

  const pricesArray = subjectsToValidate[0].prices;
  if (!pricesArray || !Array.isArray(pricesArray) || pricesArray.length === 0) {
    return res.status(400).json({ error: "يجب تحديد أسعار للمادة" });
  }

  for (const [pIndex, price] of pricesArray.entries()) {
    if (!price.stage || !["PRIMARY", "MIDDLE", "HIGH"].includes(price.stage)) {
      return res.status(400).json({ error: `المرحلة غير صالحة في سعر رقم ${pIndex + 1}` });
    }

    if (typeof price.price !== "number" || price.price <= 0) {
      return res.status(400).json({ error: `السعر يجب أن يكون رقم موجب في سعر رقم ${pIndex + 1}` });
    }

    if (price.subscriptionType && !["MONTHLY", "COURSE", "HALF_MONTH"].includes(price.subscriptionType)) {
      return res.status(400).json({ error: `نوع الاشتراك غير صالح في سعر رقم ${pIndex + 1}` });
    }
  }

  next();
};

// =============================================
// POST /api/subjects - إضافة مادة/مواد
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
          // استخدام Math.round لتجنب مشكلة الـ 119 بدل 120
          const finalPrice = Math.round(price.price);

          // 1️⃣ حفظ السعر الأصلي
          await prisma.subjectPrice.create({
            data: {
              subjectId: newSubject.id,
              stage: price.stage,
              subscriptionType,
              price: finalPrice,
              durationInMonths: price.durationInMonths || null,
            },
          });

          // 2️⃣ لو النوع MONTHLY -> إنشاء نسخة نص شهر تلقائياً
          if (subscriptionType === "MONTHLY") {
            await prisma.subjectPrice.create({
              data: {
                subjectId: newSubject.id,
                stage: price.stage,
                subscriptionType: "HALF_MONTH",
                price: Math.round(finalPrice / 2),
                durationInMonths: null,
              },
            });
          }

          processedPrices.push({ ...price, price: finalPrice });
        }

        const subjectWithPrices = await prisma.subject.findUnique({
          where: { id: newSubject.id },
          include: { prices: true },
        });

        createdSubjects.push(subjectWithPrices);

        await prisma.activityLog.create({
          data: {
            centerId,
            userId,
            action: "CREATE_SUBJECT",
            targetType: "Subject",
            targetId: newSubject.id,
            details: JSON.stringify({ name: newSubject.name, prices: processedPrices }),
          },
        });
      }

      res.status(201).json({
        message: `تم إضافة ${createdSubjects.length} مادة بنجاح`,
        subjects: createdSubjects,
      });
    } catch (error) {
      console.error("خطأ في إضافة المواد:", error);
      res.status(500).json({ error: error.message || "حصل خطأ داخلي في السيرفر" });
    }
  }
);

// =============================================
// GET /api/subjects - عرض كل المواد
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
        include: { prices: { orderBy: { stage: "asc" } } },
        orderBy: { name: "asc" },
      });

      res.json({ success: true, count: subjects.length, data: subjects });
    } catch (error) {
      res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
    }
  }
);

// =============================================
// PUT /api/subjects/:id - تعديل مادة (التصحيح الأسطوري هنا)
// =============================================
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
        return res.status(404).json({ error: "المادة غير موجودة أو لا تتبع سنترك" });
      }

      // 1. تحديث اسم المادة
      const updatedSubject = await prisma.subject.update({
        where: { id: Number(id) },
        data: { name: name.trim() },
      });

      // 2. مسح الأسعار القديمة لإعادة بنائها (نفس لوجيك الـ POST)
      if (prices && Array.isArray(prices)) {
        await prisma.subjectPrice.deleteMany({
          where: { subjectId: Number(id) },
        });

        for (const price of prices) {
          const subscriptionType = price.subscriptionType || "MONTHLY";
          const finalPrice = Math.round(price.price);

          // حفظ السعر الأساسي (التعديل يحترم التقريب الآن)
          await prisma.subjectPrice.create({
            data: {
              subjectId: Number(id),
              stage: price.stage,
              subscriptionType,
              price: finalPrice,
              durationInMonths: price.durationInMonths || null,
            },
          });

          // إضافة "نص الشهر" تلقائياً لو النوع شهر
          if (subscriptionType === "MONTHLY") {
            await prisma.subjectPrice.create({
              data: {
                subjectId: Number(id),
                stage: price.stage,
                subscriptionType: "HALF_MONTH",
                price: Math.round(finalPrice / 2),
              },
            });
          }
        }
      }

      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "UPDATE_SUBJECT",
          targetType: "Subject",
          targetId: updatedSubject.id,
          details: JSON.stringify({ name: updatedSubject.name, prices }),
        },
      });

      const result = await prisma.subject.findUnique({
        where: { id: Number(id) },
        include: { prices: true },
      });

      res.json({ message: "تم تعديل المادة بنجاح", subject: result });
    } catch (error) {
      console.error("خطأ في تعديل مادة:", error);
      res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
    }
  }
);

// =============================================
// DELETE /api/subjects/:id - حذف مادة
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

      const subject = await prisma.subject.findFirst({
        where: { id: Number(id), centerId },
      });

      if (!subject) {
        return res.status(404).json({ error: "المادة غير موجودة" });
      }

      // استخدام transaction للحذف النظيف
      await prisma.$transaction([
        prisma.subscriptionItem.deleteMany({ where: { subjectId: Number(id) } }),
        prisma.subjectPrice.deleteMany({ where: { subjectId: Number(id) } }),
        prisma.subject.delete({ where: { id: Number(id) } }),
      ]);

      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "DELETE_SUBJECT",
          targetType: "Subject",
          targetId: Number(id),
          details: JSON.stringify({ name: subject.name }),
        },
      });

      res.json({ message: "تم حذف المادة والبيانات المرتبطة بها بنجاح" });
    } catch (error) {
      res.status(500).json({ error: "حصل خطأ في الحذف، قد تكون المادة مرتبطة بسجلات أخرى" });
    }
  }
);

module.exports = router;
