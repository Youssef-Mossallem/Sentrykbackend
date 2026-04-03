const express = require("express");
const { PrismaClient } = require("@prisma/client");

const {
  authenticateToken,
  requireCenterAccess,
} = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// جلب سعر الرسالة من الإعدادات
const PRICE_PER_MESSAGE =
  parseFloat(process.env.CHARGE_SMS_PRICE_PER_MESSAGE) || 0.23;

// =============================================
// GET /api/dashboard - الإحصائيات الشاملة (النسخة الذكية)
// =============================================
router.get("/", authenticateToken, requireCenterAccess, async (req, res) => {
  try {
    const { centerId } = req.user;

    const now = new Date();
    // بداية الشهر الحالي
    const firstDayThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    // بداية الشهر السابق
    const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    
    // تعريف "قرب الانتهاء" (مثلاً خلال 3 أيام من الآن)
    const threeDaysFromNow = new Date(now);
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

    const [
      totalStudents,
      activeStudentsCount,
      expiredStudentsCount,
      nearExpiryStudentsCount,
      currentMonthRevenue,
      previousMonthRevenue,
      smsWallet,
      smsSentThisMonth,
      recentActivity,
      totalSubjects,
      totalGroups,
    ] = await Promise.all([
      // 1. إجمالي الطلاب في السنتر
      prisma.student.count({ where: { centerId } }),

      // 2. الطلاب النشطين (بناءً على التاريخ: endDate أكبر من الآن والحالة ACTIVE)
      prisma.student.count({
        where: {
          centerId,
          subscriptions: {
            some: {
              status: "ACTIVE",
              endDate: { gt: now },
            },
          },
        },
      }),

      // 3. الطلاب المنتهي اشتراكهم (بناءً على التاريخ: endDate أصغر من الآن)
      // نعتبر الطالب منتهي لو كل اشتراكاته تاريخها عدى أو حالتها EXPIRED
      prisma.student.count({
        where: {
          centerId,
          subscriptions: {
            every: {
              OR: [
                { endDate: { lt: now } },
                { status: "EXPIRED" }
              ]
            },
          },
        },
      }),

      // 4. الطلاب الذين سينتهي اشتراكهم قريباً (بين "الآن" و "بعد 3 أيام")
      prisma.student.count({
        where: {
          centerId,
          subscriptions: {
            some: {
              status: "ACTIVE",
              endDate: {
                gte: now,
                lte: threeDaysFromNow,
              },
            },
          },
        },
      }),

      // 5. إيرادات الشهر الحالي
      prisma.subscription.aggregate({
        where: {
          student: { centerId },
          createdAt: { gte: firstDayThisMonth },
        },
        _sum: { totalPrice: true },
      }),

      // 6. إيرادات الشهر السابق
      prisma.subscription.aggregate({
        where: {
          student: { centerId },
          createdAt: { gte: firstDayLastMonth, lt: firstDayThisMonth },
        },
        _sum: { totalPrice: true },
      }),

      // 7. محفظة الرسائل
      prisma.smsWallet.findUnique({
        where: { centerId },
      }),

      // 8. إجمالي الرسائل المرسلة هذا الشهر
      prisma.smsTransaction.aggregate({
        where: {
          wallet: { centerId },
          type: "SEND",
          createdAt: { gte: firstDayThisMonth },
        },
        _sum: { amount: true },
      }),

      // 9. آخر 10 نشاطات
      prisma.activityLog.findMany({
        where: { centerId },
        take: 10,
        orderBy: { createdAt: "desc" },
        include: { user: { select: { name: true } } },
      }),

      // 10. إجمالي المواد
      prisma.subject.count({ where: { centerId } }),

      // 11. إجمالي المجموعات
      prisma.group.count({ where: { centerId } }),
    ]);

    // معالجة المبالغ المالية
    const revenueThisMonth = currentMonthRevenue._sum.totalPrice || 0;
    const revenueLastMonth = previousMonthRevenue._sum.totalPrice || 0;
    const revenueDifference = revenueThisMonth - revenueLastMonth;

    // معالجة بيانات الرسائل
    const currentMessagesCount = smsWallet?.balance || 0;
    const sentCount = Math.abs(smsSentThisMonth._sum.amount || 0);

    res.json({
      success: true,
      stats: {
        students: {
          total: totalStudents,
          active: activeStudentsCount,
          expired: expiredStudentsCount,
          nearExpiry: nearExpiryStudentsCount,
        },
        revenue: {
          thisMonth: revenueThisMonth,
          lastMonth: revenueLastMonth,
          difference: revenueDifference,
          trend: revenueDifference >= 0 ? "up" : "down",
        },
        sms: {
          messages: currentMessagesCount,
          balanceInMoney: (currentMessagesCount * PRICE_PER_MESSAGE).toFixed(2),
          pricePerMessage: PRICE_PER_MESSAGE,
          sentThisMonth: sentCount,
        },
        content: {
          subjects: totalSubjects,
          groups: totalGroups,
        },
        recentActivity: recentActivity.map((log) => ({
          id: log.id,
          time: log.createdAt.toLocaleString("ar-EG"),
          user: log.user?.name || "النظام",
          action: log.action,
          details: log.details ? JSON.parse(log.details) : null,
          target: log.targetType ? `${log.targetType} (${log.targetId})` : null,
        })),
      },
    });
  } catch (error) {
    console.error("Dashboard Error:", error);
    res.status(500).json({ error: "حدث خطأ أثناء جلب بيانات الداشبورد" });
  }
});

module.exports = router;