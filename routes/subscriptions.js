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
// دالة مساعدة مطورة لحساب تاريخ النهاية
// =============================================
const calculateEndDate = (subscriptionType, durationInMonths = 1) => {
  const end = new Date();
  // تصفير الوقت ليكون الحساب معتمداً على الأيام فقط
  end.setHours(23, 59, 59, 999);

  switch (subscriptionType) {
    case "HALF_MONTH":
      end.setDate(end.getDate() + 15);
      break;
    case "COURSE":
      end.setMonth(end.getMonth() + (durationInMonths || 3)); // افتراضي 3 شهور للكورس ما لم يحدد غير ذلك
      break;
    case "MONTHLY":
    default:
      end.setMonth(end.getMonth() + 1);
      break;
  }
  return end;
};

// =============================================
// POST /api/subscriptions/:studentId - إنشاء/تجديد اشتراك (ذكي)
// =============================================
router.post(
  "/:studentId",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { studentId } = req.params;
      const { items } = req.body; // مصفوفة المواد الجديدة
      const { centerId, userId } = req.user;

      // 1. التحقق من وجود الطالب في السنتر
      const student = await prisma.student.findFirst({
        where: { id: Number(studentId), centerId },
        include: {
          // نجلب الاشتراكات الحالية (سواء نشطة أو منتهية) لتنظيفها
          subscriptions: {
            orderBy: { createdAt: "desc" },
            take: 1
          },
        },
      });

      if (!student) {
        return res.status(404).json({ error: "الطالب غير موجود أو لا يتبع السنتر" });
      }

      const result = await prisma.$transaction(async (tx) => {
        let subscription;
        let activeSub = student.subscriptions[0];

        // الحالة أ: تجديد نفس المواد الحالية (بدون إرسال مواد جديدة)
        if (!items || items.length === 0) {
          if (!activeSub) throw new Error("لا يوجد اشتراك سابق لتجديده، يرجى اختيار مواد.");

          const subType = activeSub.subscriptionType;
          subscription = await tx.subscription.update({
            where: { id: activeSub.id },
            data: {
              startDate: new Date(),
              endDate: calculateEndDate(subType),
              status: "ACTIVE",
              updatedAt: new Date(),
            },
            include: {
              items: { include: { subject: { select: { id: true, name: true } } } },
            },
          });
        } 
        // الحالة ب: تغيير المواد أو إنشاء اشتراك لأول مرة
        else {
          let totalPrice = 0;
          const processedItems = [];

          // التحقق من الأسعار والمواد (منع التكرار وحساب المجموع)
          const uniqueSubjectIds = [...new Set(items.map(i => Number(i.subjectId)))];
          
          for (const sId of uniqueSubjectIds) {
            const itemFromReq = items.find(i => Number(i.subjectId) === sId);
            const subType = itemFromReq.subscriptionType || "MONTHLY";

            const priceRecord = await tx.subjectPrice.findUnique({
              where: {
                subjectId_stage_subscriptionType: {
                  subjectId: sId,
                  stage: student.stage,
                  subscriptionType: subType,
                },
              },
            });

            if (!priceRecord) throw new Error(`لم يتم تحديد سعر للمادة رقم ${sId} لهذه المرحلة.`);

            totalPrice += priceRecord.price;
            processedItems.push({
              subjectId: sId,
              priceSnapshot: priceRecord.price,
            });
          }

          const globalSubType = items[0].subscriptionType || "MONTHLY";
          const newEndDate = calculateEndDate(globalSubType);

          // التنظيف: إذا كان للطالب اشتراك قديم، نقوم بمسح مواده تماماً
          if (activeSub) {
            await tx.subscriptionItem.deleteMany({ where: { subscriptionId: activeSub.id } });
            
            subscription = await tx.subscription.update({
              where: { id: activeSub.id },
              data: {
                subscriptionType: globalSubType,
                totalPrice: totalPrice,
                startDate: new Date(),
                endDate: newEndDate,
                status: "ACTIVE",
                updatedAt: new Date(),
              },
            });
          } else {
            // إنشاء اشتراك جديد كلياً
            subscription = await tx.subscription.create({
              data: {
                studentId: Number(studentId),
                startDate: new Date(),
                endDate: newEndDate,
                subscriptionType: globalSubType,
                totalPrice: totalPrice,
                status: "ACTIVE",
                createdBy: userId,
              },
            });
          }

          // إضافة المواد الجديدة النظيفة
          await tx.subscriptionItem.createMany({
            data: processedItems.map(item => ({
              subscriptionId: subscription.id,
              subjectId: item.subjectId,
              priceSnapshot: item.priceSnapshot,
            }))
          });

          // استرجاع البيانات كاملة للرد
          subscription = await tx.subscription.findUnique({
            where: { id: subscription.id },
            include: {
              items: { include: { subject: { select: { id: true, name: true } } } },
            },
          });
        }

        // إرسال الرسالة
        const smsResult = await sendAutoSms(Number(studentId), "RENEWED").catch(() => ({ success: false }));
        
        return { subscription, smsResult };
      });

      res.json({
        success: true,
        message: "تم تحديث اشتراك الطالب بنجاح ومسح المواد القديمة",
        subscription: {
          id: result.subscription.id,
          type: result.subscription.subscriptionType,
          endDate: result.subscription.endDate,
          totalPrice: result.subscription.totalPrice,
          materials: result.subscription.items.map(item => ({
            name: item.subject.name,
            price: item.priceSnapshot
          }))
        },
        smsStatus: result.smsResult.success ? "SENT" : "FAILED_OR_NO_BALANCE"
      });

    } catch (error) {
      console.error("Subscription Error:", error);
      res.status(400).json({ error: error.message });
    }
  }
);

// =============================================
// GET /api/subscriptions - عرض الاشتراكات مع الفلترة
// =============================================
router.get("/", authenticateToken, requireCenterAccess, async (req, res) => {
  try {
    const { centerId } = req.user;
    const { status } = req.query; // اختياري: لفلترة النشط فقط

    const subscriptions = await prisma.subscription.findMany({
      where: { 
        student: { centerId },
        ...(status && { status }) 
      },
      include: {
        student: { select: { name: true, phone: true } },
        items: { include: { subject: { select: { name: true } } } },
      },
      orderBy: { updatedAt: "desc" },
    });

    res.json({
      success: true,
      data: subscriptions.map((sub) => ({
        id: sub.id,
        studentName: sub.student.name,
        studentPhone: sub.student.phone,
        endDate: sub.endDate,
        totalPrice: sub.totalPrice,
        status: sub.status,
        materials: sub.items.map(i => i.subject.name),
      })),
    });
  } catch (error) {
    res.status(500).json({ error: "فشل جلب البيانات" });
  }
});

module.exports = router;