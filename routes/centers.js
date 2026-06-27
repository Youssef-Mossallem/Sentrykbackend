const express = require("express");
const { PrismaClient } = require("@prisma/client");
const crypto = require("crypto"); // محرك توليد الأكواد العشوائية الآمنة

const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
} = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// ===========================================================================
// GET /api/centers - جلب بيانات السنتر الشاملة مع لوحة إحصائيات الإحالة والاشتراكات الأسطورية
// ===========================================================================
router.get(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId } = req.user;

      // استعلام عميق وقوي يجلب السنتر وروافده ونظام الإحالة والاشتراكات كاملاً
      const center = await prisma.center.findUnique({
        where: { id: centerId },
        include: {
          students: { select: { id: true, name: true, stage: true } },
          teachers: { select: { id: true, name: true, subject: true } },
          rooms: true,
          whatsappWallet: true,
          // 1. جلب الاشتراكات الخاصة بالسنتر في منصة الـ SaaS لمعرفة تاريخ الانتهاء
          subscriptions: {
            orderBy: { endDate: "desc" },
          },
          // 2. استدعاء السناتر التي اشتركت بسبب هذا السنتر (نظام الإحالة المباشر)
          referredCenters: {
            select: {
              id: true,
              name: true,
              phone: true,
              plan: true,
              createdAt: true,
              referralMilestoneAchieved: true, // هل دفع أول اشتراك فعلي؟
            },
            orderBy: {
              createdAt: "desc",
            },
          },
          // 3. جلب بيانات السنتر الداعي (الذي قام بدعوة هذا السنتر إن وجد)
          referredBy: {
            select: {
              id: true,
              name: true,
            },
          },
          // 4. جلب كود الخصم النشط المربوط بالسنتر حالياً
          activePromoCode: true,
        },
      });

      if (!center) {
        return res.status(404).json({ 
          success: false, 
          error: "السنتر المستهدف غير موجود بنظام الحفظ المركزي" 
        });
      }

      // 📅 تحليل وحساب وضع الاشتراك الحالي وفترة الصلاحية
      const activeSub = center.subscriptions.find(sub => sub.isActive === true) || center.subscriptions[0];
      let subscriptionDetails = {
        hasSubscription: false,
        status: "لا يوجد اشتراك نشط",
        startDate: null,
        endDate: null,
        daysRemaining: 0,
        isExpired: true
      };

      if (activeSub) {
        const now = new Date();
        const endDate = new Date(activeSub.endDate);
        const timeDiff = endDate.getTime() - now.getTime();
        const daysRemaining = Math.max(0, Math.ceil(timeDiff / (1000 * 60 * 60 * 24)));

        subscriptionDetails = {
          hasSubscription: true,
          status: activeSub.isActive && endDate > now ? "نشط آمن ✅" : "منتهي الصلاحية ⚠️",
          startDate: activeSub.startDate,
          endDate: activeSub.endDate,
          daysRemaining: daysRemaining,
          isExpired: endDate <= now
        };
      }

      // 📊 بناء لوحة الإحصائيات التحليلية للنظام التسويقي ومكافآت الإحالة (Referral & Rewards Analytics)
      const totalInvitedCount = center.referredCenters.length; // عدد السناتر المسجلة فعلياً بسببه
      const successfulReferralsCount = center.referredCenters.filter(c => c.referralMilestoneAchieved).length; // السناتر الفعالة بالدفع
      const pendingReferralsCount = totalInvitedCount - successfulReferralsCount; // في فترة التجربة أو لم تدفع بعد

      // قانون المنصة: كل إحالة ناجحة (حققت الهدف المالي) تمنح السنتر شهراً مجانياً مكافأة
      const freeMonthsEarnedFromReferrals = successfulReferralsCount * 1; 

      // تجميع البيانات في كائن استجابة منظم واحترافي للفرونت إند
      const responseData = {
        id: center.id,
        name: center.name,
        phone: center.phone,
        plan: center.plan,
        maxStudents: center.maxStudents,
        maxUsers: center.maxUsers,
        isActive: center.isActive,
        createdAt: center.createdAt,
        whatsappWallet: center.whatsappWallet,
        metrics: {
          studentsCount: center.students.length,
          teachersCount: center.teachers.length,
          roomsCount: center.rooms.length,
        },
        // 🔒 هيكل بيانات الصلاحية والاشتراك الكبرى لقفل/فتح الميزات للعميل
        subscriptionSystem: subscriptionDetails,
        // 🎁 هيكل بيانات نظام التسويق والإحالات الفريد
        referralSystem: {
          referralCode: center.referralCode || "لم يتم توليده بعد",
          referralCountInDb: center.referralCount, // العداد الرقمي المباشر بالـ DB
          stats: {
            totalInvited: totalInvitedCount,                 // إجمالي السناتر التي استخدمت الكود عند التسجيل
            successfulReferrals: successfulReferralsCount,   // السناتر الفعالة التي أتمت الدفع الأول بنجاح
            pendingReferrals: pendingReferralsCount,         // السناتر المعلقة قيد المراجعة أو التجربة
          },
          rewards: {
            totalFreeMonthsEarned: freeMonthsEarnedFromReferrals, // إجمالي الشهور المجانية المكتسبة كعائد تسويقي
            promoMonthsUsed: center.promoMonthsUsed,             // عدد الشهور التي استهلكها من أكواد الخصم العادية
            isPromoPaused: center.isPromoPaused,                 // وضع تجميد الخصومات السيادي من الإدارة العليا
            activePromoDetails: center.activePromoCode ? {
              code: center.activePromoCode.code,
              discountPercent: center.activePromoCode.discountPercent,
            } : null,
          },
          invitedCentersList: center.referredCenters, // القائمة التفصيلية للسناتر المدعوة وهل حققت المايلستون أم لا
          invitedBy: center.referredBy ? { id: center.referredBy.id, name: center.referredBy.name } : null,
        }
      };

      return res.json({ 
        success: true, 
        message: "تم استرجاع الهيكلية المعمارية الشاملة للسنتر مع لوحة الاشتراكات بنجاح سيادي 🚀",
        center: responseData 
      });

    } catch (error) {
      console.error("❌ Error Fetching Center Legendary Data:", error);
      return res.status(500).json({ 
        success: false, 
        error: "حدث خطأ داخلي مجهول أثناء معالجة واستخراج بيانات السنتر التحليلية العظمى" 
      });
    }
  }
);

// ===========================================================================
// PUT /api/centers - تحديث معلومات السنتر والمزامنة الفورية + حماية وتأصيل كود الإحالة
// ===========================================================================
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

      // التحقق الفوري من الوجود المسبق بالـ DB
      const center = await prisma.center.findUnique({
        where: { id: centerId },
      });

      if (!center) {
        return res.status(404).json({ 
          success: false, 
          error: "السنتر المستهدف غير موجود بالقائمة التشغيلية الحالية" 
        });
      }

      // ⚙️ ميزة الحماية والتهيئة التلقائية: إذا كان السنتر لا يمتلك كود إحالة فريد، نقوم بإنشائه فوراً وتأمينه
      let assignedReferralCode = center.referralCode;
      if (!assignedReferralCode) {
        const cleanName = (name || center.name).trim().replace(/\s+/g, "").substring(0, 3).toUpperCase();
        const randomHex = crypto.randomBytes(3).toString("hex").toUpperCase();
        assignedReferralCode = `${cleanName}-${randomHex}`; // مثال: MAT-A4B9F2
      }

      // تنفيذ التحديث الآمن داخل قاعدة البيانات
      const updatedCenter = await prisma.center.update({
        where: { id: centerId },
        data: {
          name: name?.trim() || center.name,
          phone: phone?.trim() || center.phone,
          plan: plan || center.plan,
          referralCode: assignedReferralCode,
        },
      });

      // توثيق العملية الحركية في سجلات النظام (Logs) حماية للمنشأة
      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "UPDATE_CENTER",
          targetType: "Center",
          targetId: centerId,
          details: JSON.stringify({
            updatedFields: Object.keys(req.body).filter(key => req.body[key] !== undefined),
            newValues: { name, phone, plan, referralCode: assignedReferralCode },
          }),
        },
      });

      return res.json({
        success: true,
        message: "تم تحديث بيانات السنتر، وتأمين وتأصيل كود الإحالة التسويقي بنجاح تام ✅",
        center: updatedCenter,
      });
    } catch (error) {
      console.error("❌ Error Updating Center Data:", error);
      return res.status(500).json({ 
        success: false, 
        error: "فشلت عملية تحديث البيانات الهيكلية، خطأ داخلي في الخادم المحرك للـ SaaS" 
      });
    }
  }
);

// ===========================================================================
// POST /api/centers/generate-code - توليد أو إعادة بناء كود الإحالة يدوياً بطلب من الأدمن
// ===========================================================================
router.post(
  "/generate-code",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId, userId } = req.user;

      const center = await prisma.center.findUnique({ where: { id: centerId } });
      if (!center) return res.status(404).json({ success: false, error: "السنتر غير موجود بالنظام الحركي" });

      // بناء كود فريد ومميز مستوحى من اسم السنتر لتسهيل حفظه ونشره تسويقياً
      const cleanPrefix = center.name.trim().replace(/\s+/g, "").substring(0, 4).toUpperCase();
      const uniqueSlug = crypto.randomBytes(3).toString("hex").toUpperCase();
      const finalCode = `${cleanPrefix}_${uniqueSlug}`; // مثال: ACAD_F32B

      // التحقق الصارم لمنع التكرار النادر جداً في النظام
      const codeExists = await prisma.center.findUnique({ where: { referralCode: finalCode } });
      if (codeExists) return res.status(499).json({ success: false, error: "حدث تضارب عشوائي في توليد الرموز، يرجى إعادة المحاولة فوراً" });

      const updated = await prisma.center.update({
        where: { id: centerId },
        data: { referralCode: finalCode },
      });

      // تسجيل العملية في نظام الـ Auditing
      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "GENERATE_REFERRAL_CODE",
          targetType: "Center",
          targetId: centerId,
          details: JSON.stringify({ codeGenerated: finalCode }),
        }
      });

      return res.json({
        success: true,
        message: "تم توليد وتأصيل كود الإحالة القيادي الجديد الخاص بك بنجاح 🎯",
        referralCode: updated.referralCode,
      });
    } catch (error) {
      console.error("❌ Error generating referral code:", error);
      return res.status(500).json({ success: false, error: "فشل توليد الكود التسويقي، خطأ في خادم البيانات المعزول" });
    }
  }
);

// ===========================================================================
// DELETE /api/centers - التدمير الذري الشامل والآمن لكافة روابط السنتر (حماية السيادة البيانية للـ SaaS)
// ===========================================================================
router.delete(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  requireCenterAccess,
  async (req, res) => {
    const { centerId } = req.user;

    try {
      // 1. التحقق الاستباقي لعدم العبث بمنافذ الحذف والتحقق من الوجود الفعلي
      const center = await prisma.center.findUnique({
        where: { id: centerId },
      });

      if (!center) {
        return res.status(404).json({ 
          success: false, 
          error: "السنتر المستهدف غير موجود بالفعل أو تمت تصفيته وسحقه مسبقاً" 
        });
      }

      // 2. تفعيل الهندسة الذرية المتسلسلة (Prisma Transactions) للتنظيف الشامل دون ترك أي فضلات بيانية (Orphans)
      await prisma.$transaction(async (tx) => {
        
        // أ. تنظيف سجلات فحص الكروت اللحظية وعمليات الـ QR بالسنتر
        await tx.attendanceScan.deleteMany({ where: { centerId } });

        // ب. حذف روابط الـ ShortLinks لحماية الـ slugs من أي تضارب خارجي مستقبلي
        await tx.shortLink.deleteMany({ where: { centerId } });

        // ج. حذف سجلات الحضور والغياب (Attendance) لكافة الطلاب بالسنتر
        await tx.attendance.deleteMany({ where: { centerId } });

        // د. حذف النوافذ الزمنية المفتوحة للحصص والمجموعات (SessionAttendanceWindow)
        await tx.sessionAttendanceWindow.deleteMany({
          where: {
            session: {
              teacher: { centerId }
            }
          }
        });

        // هـ. حذف تفاصيل المجموعات والحصص المدرجة داخل اشتراكات الطلاب المفتوحة
        await tx.subscriptionItem.deleteMany({
          where: {
            subscription: {
              student: { centerId }
            }
          }
        });

        // و. إسقاط دفاتر اشتراكات الطلاب المالية تماماً لتصفية الجداول التابعة للطلاب
        await tx.subscription.deleteMany({
          where: {
            student: { centerId }
          }
        });

        // ز. حذف الحصص والمجموعات الدراسية (Sessions) المرتبطة بقاعات السنتر ومدرسيه
        await tx.session.deleteMany({
          where: {
            OR: [
              { teacher: { centerId } },
              { room: { centerId } }
            ]
          }
        });

        // ح. مسح تسعيرات الحصص المخصصة لكل معلم بناءً على المراحل والمجموعات (PriceConfiguration)
        await tx.priceConfiguration.deleteMany({
          where: {
            teacher: { centerId }
          }
        });

        // ط. حذف تقارير أولياء الأمور الشهرية التراكمية الموثقة للحضور والغياب للسنتر
        await tx.monthlyReportLog.deleteMany({ where: { centerId } });

        // ي. تصفية معاملات ومحفظة الواتساب المعمارية بالكامل لمنع تسريب العملات أو الـ Credits
        await tx.whatsAppTransaction.deleteMany({
          where: {
            wallet: { centerId }
          }
        });
        await tx.whatsAppWallet.deleteMany({ where: { centerId } });

        // ك. حماية بناء نظام الإحالة: السناتر التي سجلت بسببه يتم تحريرها وجعل المعرف (null) بدلاً من كسر تكامل البيانات
        await tx.center.updateMany({
          where: { referredById: centerId },
          data: { referredById: null }
        });

        // ل. حذف فواتير السنتر والمدفوعات المالية واشتراكاته مع نظام الـ SaaS الرئيسي كاملاً
        await tx.payment.deleteMany({ where: { centerId } });
        await tx.centerSubscription.deleteMany({ where: { centerId } });

        // م. تصفية السجلات التوثيقية للنظام (Activity Logs) التابعة للسنتر
        await tx.activityLog.deleteMany({ where: { centerId } });

        // ن. تدمير الركائز التشغيلية الأربعة الأساسية (المستخدمين/السكرتارية، الطلاب، المدرسين، القاعات)
        await tx.user.deleteMany({ where: { centerId } });
        await tx.student.deleteMany({ where: { centerId } });
        await tx.teacher.deleteMany({ where: { centerId } });
        await tx.room.deleteMany({ where: { centerId } });

        // س. المرحلة النهائية والملحمية العليا: اقتلاع السنتر من جذر قاعدة البيانات بنجاح استراتيجي مطلق
        await tx.center.delete({ where: { id: centerId } });
      });

      return res.json({
        success: true,
        message: "تم تدمير وحذف السنتر بالكامل وتطهير وتصفية كافة السجلات التابعة له بيقين بياني تام 🧨",
      });

    } catch (error) {
      console.error("❌ CRITICAL ERROR DURING CENTER ATOMIC DELETION:", error);
      return res.status(500).json({
        success: false,
        error: "فشلت عملية الحذف الهيكلية العظمى لوجود قيود علاقات نشطة أو معقدة بقاعدة البيانات",
        details: error.message,
      });
    }
  }
);

module.exports = router;