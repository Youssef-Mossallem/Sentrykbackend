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
// GET /api/centers - عرض بيانات السنتر الحالي
// =============================================
router.get(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId } = req.user;

      const center = await prisma.center.findUnique({
        where: { id: centerId },
        select: {
          id: true,
          name: true,
          phone: true,
          plan: true,
          referralCode: true,
          referralCount: true,
          createdAt: true,
          updatedAt: true,
          students: { select: { id: true, name: true }, take: 5 },
        },
      });

      if (!center) return res.status(404).json({ error: "السنتر غير موجود" });

      res.json({ success: true, center });
    } catch (error) {
      console.error("خطأ في عرض السنتر:", error);
      res.status(500).json({ error: "حصل خطأ داخلي" });
    }
  }
);

// =============================================
// PUT /api/centers - تعديل بيانات السنتر الحالي
// =============================================
router.put(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId, userId } = req.user;
      const { name, phone, plan } = req.body;

      const center = await prisma.center.findUnique({ where: { id: centerId } });
      if (!center) return res.status(404).json({ error: "السنتر غير موجود" });

      const updatedCenter = await prisma.center.update({
        where: { id: centerId },
        data: {
          name: name?.trim() || center.name,
          phone: phone?.trim() || center.phone,
          plan: plan || center.plan,
        },
      });

      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "UPDATE_CENTER",
          targetType: "Center",
          targetId: centerId,
          details: JSON.stringify({
            updatedFields: Object.keys(req.body),
            newValues: { name, phone, plan },
          }),
        },
      });

      res.json({ success: true, message: "تم تعديل بيانات السنتر بنجاح", center: updatedCenter });
    } catch (error) {
      console.error("خطأ في تعديل السنتر:", error);
      res.status(500).json({ error: "حصل خطأ داخلي" });
    }
  }
);

// =============================================
// DELETE /api/centers - حذف السنتر نهائياً (مصحح)
// =============================================
router.delete(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  async (req, res) => {
    const { centerId, userId } = req.user;

    try {
      // 1. التأكد من وجود السنتر
      const center = await prisma.center.findUnique({ where: { id: centerId } });
      if (!center) return res.status(404).json({ error: "السنتر غير موجود بالفعل" });

      // [أولاً] جلب المعرفات اللازمة للحذف المرتبط
      const students = await prisma.student.findMany({ where: { centerId }, select: { id: true } });
      const studentIds = students.map(s => s.id);

      const subjects = await prisma.subject.findMany({ where: { centerId }, select: { id: true } });
      const subjectIds = subjects.map(s => s.id);

      // [ثانياً] حذف بنود الاشتراكات (SubscriptionItem) باستخدام المعرفات
      if (studentIds.length > 0 || subjectIds.length > 0) {
        await prisma.subscriptionItem.deleteMany({
          where: {
            OR: [
              { studentId: { in: studentIds } },
              { subjectId: { in: subjectIds } }
            ]
          }
        });
      }

      // [ثالثاً] حذف متعلقات الـ SMS
      const wallet = await prisma.smsWallet.findUnique({ where: { centerId } });
      if (wallet) {
        await prisma.smsTransaction.deleteMany({ where: { walletId: wallet.id } });
        await prisma.smsWallet.delete({ where: { centerId } });
      }

      // [رابعاً] حذف السجلات المالية والنشاطات (مهم جداً قبل حذف المستخدمين)
      await prisma.payment.deleteMany({ where: { centerId } });
      await prisma.activityLog.deleteMany({ where: { centerId } });

      // [خامساً] حذف المجموعات والمواد والطلاب
      await prisma.group.deleteMany({ where: { centerId } });
      await prisma.subject.deleteMany({ where: { centerId } });
      await prisma.student.deleteMany({ where: { centerId } });

      // [سادساً] حذف الاشتراكات الخاصة بالسنتر
      await prisma.centerSubscription.deleteMany({ where: { centerId } });

      // [سابعاً] حذف المستخدمين
      await prisma.user.deleteMany({ where: { centerId } });

      // [ثامناً] الحذف النهائي للسنتر
      await prisma.center.delete({ where: { id: centerId } });

      res.json({ success: true, message: "تم حذف السنتر وكل البيانات التابعة له نهائياً بنجاح" });
    } catch (error) {
      console.error("خطأ كارثي في حذف السنتر:", error);
      res.status(500).json({
        error: "فشل في عملية الحذف الشاملة.",
        details: error.message,
      });
    }
  }
);

module.exports = router;