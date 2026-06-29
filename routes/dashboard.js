const express = require("express");
const { PrismaClient } = require("@prisma/client");

const {
  authenticateToken,
  requireCenterAccess,
} = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// جلب سعر رسالة الواتساب الافتراضي من البيئة المحيطة أو استخدام القيمة القياسية 0.40 ج.م
const PRICE_PER_MESSAGE =
  Number(process.env.CHARGE_WHATSAPP_PRICE_PER_MESSAGE) || 0.4;

// ===========================================================================
// GET /api/dashboard - الإحصائيات الشاملة والمحدثة هندسياً وسيايداً للـ SaaS
// ===========================================================================
router.get("/", authenticateToken, requireCenterAccess, async (req, res) => {
  try {
    const centerId = req.user?.centerId;

    if (!centerId) {
      return res.status(400).json({
        success: false,
        error: "معرف السنتر مطلوب للوصول للبيانات",
      });
    }

    // --- إدارة التوقيت الذكي (America/Tijuana) لضمان دقة التقارير اليومية والشهرية ---
    const now = new Date();

    // تحويل التوقيت الحالي لتواريخ دقيقة ببداية ونهاية اليوم الحالي
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
      0,
    );
    const endOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999,
    );

    // تواريخ أول يوم في الشهر الحالي والشهر السابق للمقارنات المالية والإحالات
    const firstDayThisMonth = new Date(
      now.getFullYear(),
      now.getMonth(),
      1,
      0,
      0,
      0,
      0,
    );
    const firstDayLastMonth = new Date(
      now.getFullYear(),
      now.getMonth() - 1,
      1,
      0,
      0,
      0,
      0,
    );

    // تعريف "قرب انتهاء الاشتراك" (الاشتراكات الفعالة التي تنتهي خلال الـ 3 أيام القادمة)
    const threeDaysFromNow = new Date(now);
    threeDaysFromNow.setDate(now.getDate() + 3);

    // --- الاستعلام السريع والمتوازي باستخدام Promise.all لصعق قاعدة البيانات ---
    const [
      totalStudents,
      activeStudents,
      expiredStudents,
      nearExpiryStudents,

      revenueThisMonth,
      revenueLastMonth,

      whatsappWallet,
      whatsappSentThisMonth,

      recentActivity,

      totalTeachers,
      totalSessions,

      todayScansCount,

      // جلب بيانات حدود السنتر وكود الإحالة من قاعدة البيانات مباشرة
      centerSaaSData,
      referralsThisMonthCount,
    ] = await Promise.all([
      // 1. إجمالي الطلاب المسجلين بالسنتر
      prisma.student.count({
        where: { centerId },
      }),

      // 2. الطلاب المشتركين حالياً (لديهم اشتراك فعال وتاريخ نهايته أكبر من الآن)
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

      // 3. الطلاب الذين انتهت اشتراكاتهم بالكامل ولم يجددوا
      prisma.student.count({
        where: {
          centerId,
          subscriptions: {
            some: { status: "EXPIRED" },
            none: {
              status: "ACTIVE",
              endDate: { gt: now },
            },
          },
        },
      }),

      // 4. الطلاب الذين أوشكت اشتراكاتهم على الانتهاء (خلال 3 أيام) للتنبيه الذكي
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

      // 5. الأرباح والإيرادات المالية للشهر الحالي
      prisma.subscription.aggregate({
        where: {
          student: { centerId },
          createdAt: { gte: firstDayThisMonth },
        },
        _sum: { totalPrice: true },
      }),

      // 6. الأرباح والإيرادات المالية للشهر الماضي (لتحليل منحنى النمو)
      prisma.subscription.aggregate({
        where: {
          student: { centerId },
          createdAt: {
            gte: firstDayLastMonth,
            lt: firstDayThisMonth,
          },
        },
        _sum: { totalPrice: true },
      }),

      // 7. محفظة الواتساب الحالية للسنتر
      prisma.whatsAppWallet.findUnique({
        where: { centerId },
      }),

      // 8. إجمالي عدد رسائل الواتساب المرسلة خلال الشهر الحالي
      prisma.whatsAppTransaction.aggregate({
        where: {
          type: "SEND",
          createdAt: { gte: firstDayThisMonth },
          wallet: { centerId },
        },
        _sum: { amount: true },
      }),

      // 9. سجل آخر 10 عمليات تمت بالنظام للمراقبة الفورية (Activity Logs)
      prisma.activityLog.findMany({
        where: { centerId },
        take: 10,
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { name: true } },
        },
      }),

      // 10. إجمالي عدد المدرسين بالسنتر
      prisma.teacher.count({
        where: { centerId },
      }),

      // 11. إجمالي المجموعات/الحصص الفعالة (الربط عن طريق المعلم)
      prisma.session.count({
        where: {
          teacher: { centerId },
        },
      }),

      // 12. إجمالي عمليات مسح الكروت (Scans) التي تمت اليوم بالسنتر لقارئ الـ QR
      prisma.attendanceScan.count({
        where: {
          centerId,
          scannedAt: {
            gte: startOfToday,
            lte: endOfToday,
          },
        },
      }),

      // 13. جلب الحدود السيادية للسنتر (الحد الأقصى، كود الإحالة، العداد الكلي)
      prisma.center.findUnique({
        where: { id: centerId },
        select: {
          maxStudents: true,
          referralCode: true,
          referralCount: true,
        },
      }),

      // 14. حساب عدد السناتر الجديدة التي استخدمت الكود وسجلت في "الشهر الحالي"
      prisma.center.count({
        where: {
          referredById: centerId,
          createdAt: { gte: firstDayThisMonth },
        },
      }),
    ]);

    // --- معالجة البيانات وتجهيز الحسابات الصافية (Data Clean-up) ---
    const revenue1 = revenueThisMonth?._sum?.totalPrice || 0;
    const revenue2 = revenueLastMonth?._sum?.totalPrice || 0;

    const whatsappBalance = whatsappWallet?.balance || 0;
    const sentWhatsapp = Math.abs(whatsappSentThisMonth?._sum?.amount || 0);

    // الحسابات الهندسية للحدود وسعة الطلاب
    const maxStudentsLimit = centerSaaSData?.maxStudents || 0;
    const currentStudentsCount = totalStudents || 0;
    const remainingSeats = maxStudentsLimit - currentStudentsCount;

    // الحسابات الذكية لنظام الإحالة والمكافآت الزمنية للـ SaaS
    const totalReferralsAllTime = centerSaaSData?.referralCount || 0;
    const currentMonthReferrals = referralsThisMonthCount || 0;

    // 🛠️ [التعديل الإستراتيجي]: حقن عدد الأشهر المجانية مباشرة في متغير الأيام لحماية استقرار الفرونت إند بدون تعديل
    const bonusDaysThisMonth = currentMonthReferrals; 

    return res.json({
      success: true,
      stats: {
        // كائن حدود السعة الاستيعابية المحدث للفرونت إند 📊
        saasLimits: {
          maxStudents: maxStudentsLimit,
          currentStudents: currentStudentsCount,
          remainingSeats: remainingSeats > 0 ? remainingSeats : 0,
        },

        // كائن نظام الإحالة والمكافآت المجانية المحدث 🎁
        referralSystem: {
          code: centerSaaSData?.referralCode || null,
          totalReferralsAllTime: totalReferralsAllTime, // كم واحد ضافه من أول ما بدأ
          referralsThisMonth: currentMonthReferrals, // الأشخاص اللي استخدموا الكود هذا الشهر
          bonusDaysEarnedThisMonth: bonusDaysThisMonth, // 🔥 يعود الآن بعدد الأشهر المجانية المكتسبة هذا الشهر لحماية الفرونت إند
          bonusMonthsEarnedThisMonth: currentMonthReferrals,
        },

        students: {
          total: currentStudentsCount,
          active: activeStudents || 0,
          expired: expiredStudents || 0,
          nearExpiry: nearExpiryStudents || 0,
        },

        revenue: {
          thisMonth: revenue1,
          lastMonth: revenue2,
          difference: revenue1 - revenue2,
          trend: revenue1 >= revenue2 ? "up" : "down",
        },

        whatsapp: {
          messages: whatsappBalance,
          balanceInMoney: (whatsappBalance * PRICE_PER_MESSAGE).toFixed(2),
          pricePerMessage: PRICE_PER_MESSAGE,
          sentThisMonth: sentWhatsapp,
        },

        sms: {
          messages: whatsappBalance,
          balanceInMoney: (whatsappBalance * PRICE_PER_MESSAGE).toFixed(2),
          pricePerMessage: PRICE_PER_MESSAGE,
          sentThisMonth: sentWhatsapp,
        },

        content: {
          teachers: totalTeachers || 0,
          sessions: totalSessions || 0,
        },

        attendance: {
          todayScans: todayScansCount || 0,
        },

        recentActivity: recentActivity.map((log) => ({
          id: log.id,
          time: log.createdAt
            ? new Date(log.createdAt).toLocaleString("ar-EG", {
                timeZone: "Africa/Cairo",
              })
            : null,
          user: log.user?.name || "النظام الآلي",
          action: log.action,
          target: log.targetType
            ? `${log.targetType}${log.targetId ? ` (${log.targetId})` : ""}`
            : null,
          details: log.details ? safeJson(log.details) : null,
        })),
      },
    });
  } catch (error) {
    console.error("❌ Dashboard Engineering Error:", error);

    return res.status(500).json({
      success: false,
      error: "حدث خطأ غير متوقع أثناء تجميع بيانات الداشبورد",
      message: error?.message,
    });
  }
});

/**
 * دالة معالجة الجيسون الآمنة لمنع انهيار السيرفر أثناء عمل ماب لسجلات الأنشطة
 * @param {string|object} value
 */
function safeJson(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return { raw: value };
  }
}

module.exports = router;
