const express = require("express");
const { PrismaClient } = require("@prisma/client");
const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
} = require("../middleware/auth");

// 🚀 استدعاء الموديول الذكي والمحدث لإرسال تنبيهات الواتساب الرسمية
const { sendAutoWhatsApp } = require("../utils/whatsappUtils");

const router = express.Router();
const prisma = new PrismaClient();

// =============================================
// مساعدات الوقت والتاريخ وقفل اللوجيك الهندسية (Helpers)
// =============================================

/**
 * دالة مساعدة مطورة ومطاطية لحساب تاريخ النهاية التراكمي متوافقة تماماً مع الأوفلاين والأونلاين.
 * تم تعديل اللوجيك الخاص بنوع PER_SESSION ليقوم بحساب تاريخ انتهاء الاشتراك بناءً على جدول أيام الحصص الفعلي
 * للمجموعة وعدد الحصص المشتراة ليكون النظام ذكياً ومحاكياً للواقع تماماً بمستوى الشركات.
 * * @param {string} subscriptionType - نوع الباقة (MONTHLY, HALF_MONTH, COURSE, PER_SESSION)
 * @param {Date|string} currentEndDate - تاريخ انتهاء الاشتراك الحالي (في حال التجديد التراكمي)
 * @param {number} durationInMonths - المدة بالشهور لباقة الكورسات
 * @param {Date} referenceDate - تاريخ بدء العملية (الحالي أو وقت الأوفلاين المالي)
 * @param {Array} perSessionData - مصفوفة كائنات تحتوي على أيام المجموعات وعدد الحصص المشتراة لكل مجموعة
 */
const calculateEndDate = (
  subscriptionType,
  currentEndDate,
  durationInMonths = 1,
  referenceDate = new Date(),
  perSessionData = null,
) => {
  // 🚀 إذا كان الاشتراك الحالي سارياً بالنسبة لوقت العملية المحددة، نبني التاريخ الجديد فوق القديم لضمان حق الطالب كاملاً
  const baseDate =
    currentEndDate && new Date(currentEndDate) > referenceDate
      ? new Date(currentEndDate)
      : new Date(referenceDate);

  const end = new Date(baseDate);
  const monthsToAdd = Number(durationInMonths) || 1;

  switch (subscriptionType) {
    case "HALF_MONTH":
      end.setDate(end.getDate() + 15);
      break;
    case "COURSE":
      end.setMonth(end.getMonth() + monthsToAdd);
      break;
    case "PER_SESSION":
      // اللوجيك الذكي والمحدث: حساب انتهاء الاشتراك الفعلي بناءً على مواعيد المجموعات
      if (
        perSessionData &&
        Array.isArray(perSessionData) &&
        perSessionData.length > 0
      ) {
        let maxCalculatedEndDate = new Date(baseDate);
        const daysMap = {
          sunday: 0,
          monday: 1,
          tuesday: 2,
          wednesday: 3,
          thursday: 4,
          friday: 5,
          saturday: 6,
        };

        // المرور على المجموعات المشترك بها لحساب أبعد تاريخ انتهاء لحماية حق الوصول للطالب
        for (const group of perSessionData) {
          if (!group.days || group.days.length === 0 || !group.totalSessions)
            continue;

          // تنظيف مصفوفة الأيام وتحويلها إلى أرقام مقابلة لأيام الأسبوع في JS
          const groupDays = group.days.map((d) => d.trim().toLowerCase());
          let remainingSessions = Number(group.totalSessions);
          let current = new Date(baseDate);

          if (remainingSessions <= 0) continue;

          // العثور على أول حصة تقع في المستقبل بناءً على ترتيب مصفوفة الأيام (مثال العميل: اشتراك الثلاثاء يبدأ السبت)
          let firstDayName = groupDays[0];
          let firstDayIdx = daysMap[firstDayName];

          if (firstDayIdx !== undefined) {
            let foundFirstSession = false;

            // البحث عبر الأسبوعين القادمين عن أول يوم يطابق اليوم الأول للمجموعة تماشياً مع ترتيب الدورة التعليمية
            for (let i = 0; i < 14; i++) {
              if (i > 0 || current.getDay() !== firstDayIdx) {
                current.setDate(current.getDate() + 1);
              }
              if (current.getDay() === firstDayIdx) {
                foundFirstSession = true;
                break;
              }
            }

            if (foundFirstSession) {
              remainingSessions--; // خصم الحصة الأولى التي تم تحديد تاريخها بنجاح
              let dayArrayPointer = 1; // الانتقال لليوم التالي المجدول في مصفوفة المجموعة

              // تتبع باقي الحصص المشتراة دورياً وبشكل تتابعي صارم
              let safetyCounter = 0;
              while (remainingSessions > 0 && safetyCounter < 500) {
                const nextDayName =
                  groupDays[dayArrayPointer % groupDays.length];
                const nextDayIdx = daysMap[nextDayName];

                if (nextDayIdx !== undefined) {
                  // التقدم باليوم في التقويم حتى الوصول لليوم التالي المحدد في جدول الحصص
                  for (let j = 0; j < 7; j++) {
                    current.setDate(current.getDate() + 1);
                    if (current.getDay() === nextDayIdx) {
                      remainingSessions--;
                      break;
                    }
                  }
                }
                dayArrayPointer++;
                safetyCounter++;
              }

              // إذا كان تاريخ انتهاء هذه المجموعة أبعد من التواريخ السابقة، نعتمد الأبعد لضمان الاستقرار
              if (current > maxCalculatedEndDate) {
                maxCalculatedEndDate = new Date(current);
              }
            }
          }
        }
        end.setTime(maxCalculatedEndDate.getTime());
      } else {
        // حماية تراجعية (Fallback) في حال عدم إرسال أيام مواعيد المجموعات لأي سبب هندسي مفاجئ
        end.setDate(end.getDate() + 30);
      }
      break;

    case "MONTHLY":
    default:
      end.setMonth(end.getMonth() + monthsToAdd);
      break;
  }

  // ضبط نهاية اليوم بشكل دقيق جداً هندسياً ومقاوم للمناطق الزمنية
  end.setHours(23, 59, 59, 999);
  return end;
};

// =============================================
// غلاف الإرسال الآمن لحماية الخلفية من الانهيار (Safe Background Wrapper)
// =============================================
async function safeSendWhatsApp(studentId, type, payload = {}) {
  try {
    if (typeof sendAutoWhatsApp === "function") {
      await sendAutoWhatsApp(studentId, type, payload);
      console.log(
        `✅ [WHATSAPP SUCCESS] تم إرسال رسالة التجديد/الاشتراك بنجاح للطالب: ${studentId}`,
      );
    }
  } catch (error) {
    console.error(
      `❌ [SUBSCRIPTION ROUTE WHATSAPP ERROR] فشل إرسال رسالة الواتساب لـ الطالب رقم ${studentId}:`,
      error.message,
    );
  }
}

// =============================================
// 1️⃣ POST /api/subscriptions/:studentId - إنشاء أو تجديد اشتراك (يدعم المزامنة الفردية للأوفلاين)
// =============================================
router.post(
  "/:studentId",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    let isFirstSubscription = false;
    const studentIdNum = Number(req.params.studentId);

    if (isNaN(studentIdNum)) {
      return res.status(400).json({ error: "رقم تعريف الطالب غير صحيح 🛑" });
    }

    try {
      // استقبال حقول الأوفلاين الاختيارية وحزمة المجموعات من الواجهة الأمامية
      const { items, isOfflineMode, offlineCreatedAt } = req.body;
      const { centerId, userId } = req.user;

      // تحديد وقت البدء الحقيقي للعملية ماليًا وزمنيًا بناءً على وقت حدوثها الفعلي في الأوفلاين أو التوقيت الحالي
      const subscriptionActionDate =
        isOfflineMode && offlineCreatedAt
          ? new Date(offlineCreatedAt)
          : new Date();

      // 1. جلب بيانات الطالب مع آخر اشتراك نشط له متضمناً المجموعات والمدرسين لربطها بالهيكلة الجديدة
      const student = await prisma.student.findFirst({
        where: { id: studentIdNum, centerId },
        include: {
          subscriptions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: {
              items: {
                include: {
                  session: { include: { teacher: true } },
                },
              },
            },
          },
        },
      });

      if (!student) {
        return res
          .status(404)
          .json({ error: "الطالب غير موجود بالنظام أو لا يتبع هذا السنتر 🛑" });
      }

      // التحقق وتأمين صيغة المرحلة الدراسية للطالب ومطابقتها مع الـ Enum الخاص بالبريسما
      const validStages = ["PRIMARY", "MIDDLE", "HIGH"];
      const studentStageEnum = validStages.includes(
        student.stage?.toUpperCase(),
      )
        ? student.stage.toUpperCase()
        : null;

      if (!studentStageEnum) {
        return res.status(400).json({
          error: "المرحلة الدراسية المسجلة للطالب غير صالحة للنظام السحابي 🛑",
        });
      }

      isFirstSubscription = student.subscriptions.length === 0;
      const activeSub = student.subscriptions[0];

      // 2. معالجة وتأمين البيانات بواسطة DB Transaction لمنع أي خطأ مالي أو تضارب بالبيانات
      const dbResult = await prisma.$transaction(async (tx) => {
        let subscription;
        let finalTotalSessions = null;
        let finalDurationMonths = null;
        const perSessionData = [];

        // 💡 [الحالة أ]: تجديد تلقائي للمجموعات الحالية (عند إرسال المصفوفة فارغة أو غير موجودة بالـ body)
        if (!items || items.length === 0) {
          if (!activeSub) {
            throw new Error(
              "لا يوجد اشتراك سابق لهذا الطالب ليتم تجديده تلقائياً، يرجى اختيار المجموعات أولاً.",
            );
          }

          let totalPrice = 0;
          const processedItems = [];
          const globalSubType = activeSub.subscriptionType;

          // إعادة فحص التسعير الحالي لكل مجموعة مسجل بها الطالب بناءً على سنته ومرحلته الحالية
          for (const oldItem of activeSub.items) {
            if (!oldItem.session) continue;

            const priceRecord = await tx.priceConfiguration.findFirst({
              where: {
                teacherId: oldItem.session.teacherId,
                stage: studentStageEnum,
                subscriptionType: globalSubType,
                grades: { has: student.grade }, // التحقق الذكي من مصفوفة السنوات بالبريسما
              },
            });

            if (!priceRecord) {
              throw new Error(
                `لم يتم العثور على إعدادات تسعير صالحة للمدرس ${oldItem.session.teacher?.name || ""} متوافقة مع مرحلة وسنة الطالب الحالية.`,
              );
            }

            totalPrice += priceRecord.price;
            processedItems.push({
              sessionId: oldItem.sessionId,
              priceSnapshot: priceRecord.price,
            });

            // تجميع القيم المضافة حديثاً لإصلاح منطق المدد والحصص التراكمي الشامل
            if (globalSubType === "PER_SESSION" && priceRecord.totalSessions) {
              finalTotalSessions =
                (finalTotalSessions || 0) + priceRecord.totalSessions;
              perSessionData.push({
                days: oldItem.session.days,
                totalSessions: priceRecord.totalSessions,
              });
            }
            if (globalSubType === "COURSE" && priceRecord.durationMonths) {
              finalDurationMonths = Math.max(
                finalDurationMonths || 0,
                priceRecord.durationMonths,
              );
            }
          }

          // حساب تاريخ الانتهاء بناءً على المدة المستخرجة من باقة الكورس أو جدول تتابع حصص الـ PER_SESSION الفعلي
          const newEndDate = calculateEndDate(
            globalSubType,
            activeSub.endDate,
            finalDurationMonths || 1,
            subscriptionActionDate,
            perSessionData,
          );

          // تنظيف البنود القديمة لإعادة حقنها بالأسعار والبيانات المحدثة منعاً للتكرار
          await tx.subscriptionItem.deleteMany({
            where: { subscriptionId: activeSub.id },
          });

          subscription = await tx.subscription.update({
            where: { id: activeSub.id },
            data: {
              startDate: subscriptionActionDate,
              endDate: newEndDate,
              totalPrice: totalPrice,
              status: "ACTIVE",
              totalSessions: finalTotalSessions
                ? (activeSub.totalSessions || 0) + finalTotalSessions
                : activeSub.totalSessions,
              durationMonths: finalDurationMonths || activeSub.durationMonths,
              updatedAt: new Date(),
            },
          });

          await tx.subscriptionItem.createMany({
            data: processedItems.map((item) => ({
              subscriptionId: subscription.id,
              sessionId: item.sessionId,
              priceSnapshot: item.priceSnapshot,
            })),
          });
        }
        // 💡 [الحالة ب]: اشتراك جديد لأول مرة أو تعديل/تغيير المجموعات والمواد المشترك بها الطالب
        else {
          let totalPrice = 0;
          const processedItems = [];

          // فلترة المصفوفة لمنع تكرار الـ sessionId في نفس الطلب عن طريق الخطأ بالواجهة الأمامية
          const uniqueSessionIds = [
            ...new Set(items.map((i) => Number(i.sessionId))),
          ];
          const globalSubType = items[0].subscriptionType || "MONTHLY";

          for (const sId of uniqueSessionIds) {
            const itemFromReq = items.find((i) => Number(i.sessionId) === sId);
            const subType = itemFromReq.subscriptionType || globalSubType;

            // جلب بيانات المجموعة للوصول لمعرف المدرس والجدول الزمني التابع لها
            const session = await tx.session.findUnique({
              where: { id: sId },
              include: { teacher: true },
            });

            if (!session) {
              throw new Error(
                `المجموعة ذات المعرف الرقمي (${sId}) غير موجودة بالنظام.`,
              );
            }

            // فحص السعر بناءً على المدرس والمرحلة والسنة الدراسية للطالب
            const priceRecord = await tx.priceConfiguration.findFirst({
              where: {
                teacherId: session.teacherId,
                stage: studentStageEnum,
                subscriptionType: subType,
                grades: { has: student.grade },
              },
            });

            if (!priceRecord) {
              throw new Error(
                `عذراً، المدرس (${session.teacher?.name}) لم يحدد حزمة أسعار متوافقة مع صف الطالب الحالي للمجموعة (${session.name}).`,
              );
            }

            totalPrice += priceRecord.price;
            processedItems.push({
              sessionId: sId,
              priceSnapshot: priceRecord.price,
            });

            // حساب الحصص والشهور وبناء مصفوفة التتبع الحصصي الذكي
            if (subType === "PER_SESSION" && priceRecord.totalSessions) {
              finalTotalSessions =
                (finalTotalSessions || 0) + priceRecord.totalSessions;
              perSessionData.push({
                days: session.days,
                totalSessions: priceRecord.totalSessions,
              });
            }
            if (subType === "COURSE" && priceRecord.durationMonths) {
              finalDurationMonths = Math.max(
                finalDurationMonths || 0,
                priceRecord.durationMonths,
              );
            }
          }

          const newEndDate = calculateEndDate(
            globalSubType,
            activeSub?.endDate,
            finalDurationMonths || 1,
            subscriptionActionDate,
            perSessionData,
          );

          if (activeSub) {
            // تحديث كائن الاشتراك القائم لتجنب تضخم سجلات الطالب بالـ DB والمحافظة على ملف موحد
            await tx.subscriptionItem.deleteMany({
              where: { subscriptionId: activeSub.id },
            });

            subscription = await tx.subscription.update({
              where: { id: activeSub.id },
              data: {
                subscriptionType: globalSubType,
                totalPrice: totalPrice,
                startDate: subscriptionActionDate,
                endDate: newEndDate,
                status: "ACTIVE",
                totalSessions: finalTotalSessions,
                usedSessions: 0, // إعادة تعيين العداد لإطلاق الدورة الحالية الجديدة لضمان الاستقرار
                durationMonths: finalDurationMonths,
                updatedAt: new Date(),
              },
            });
          } else {
            // إنشاء كائن اشتراك جديد كلياً للطالب لأول مرة في السنتر مع الحفاظ على تاريخ الأوفلاين
            subscription = await tx.subscription.create({
              data: {
                studentId: studentIdNum,
                startDate: subscriptionActionDate,
                endDate: newEndDate,
                subscriptionType: globalSubType,
                totalPrice: totalPrice,
                status: "ACTIVE",
                totalSessions: finalTotalSessions,
                usedSessions: 0,
                durationMonths: finalDurationMonths,
                createdBy: userId,
                createdAt: subscriptionActionDate,
              },
            });
          }

          // حقن لقطة الشاشة والأسعار الفورية الصارمة (Snapshot) للمجموعات المختارة حالياً
          await tx.subscriptionItem.createMany({
            data: processedItems.map((item) => ({
              subscriptionId: subscription.id,
              sessionId: item.sessionId,
              priceSnapshot: item.priceSnapshot,
            })),
          });
        }

        // جلب كائن الاشتراك النهائي مدمجاً بكافة تفاصيل العلاقات الجديدة لعرضها الفوري بالفرونت إند وإرسالها للواتساب
        subscription = await tx.subscription.findUnique({
          where: { id: subscription.id },
          include: {
            items: {
              include: {
                session: { include: { teacher: true } },
              },
            },
          },
        });

        // تسجيل العملية بدقة متناهية في سجل الأنشطة العام للمركز التعليمي
        await tx.activityLog.create({
          data: {
            centerId,
            userId,
            action: isOfflineMode
              ? "SYNC_OFFLINE_SUBSCRIPTION"
              : isFirstSubscription
                ? "CREATE_SUBSCRIPTION"
                : "RENEW_SUBSCRIPTION",
            targetType: "Subscription",
            targetId: subscription.id,
            createdAt: subscriptionActionDate,
            details: JSON.stringify({
              totalPrice: subscription.totalPrice,
              endDate: subscription.endDate,
              sessionsCount: subscription.items.length,
              durationMonths: subscription.durationMonths,
              totalSessions: subscription.totalSessions,
              isOfflineSync: !!isOfflineMode,
            }),
          },
        });

        return subscription;
      });

      // 🚀 [تحديث السحر الـ WhatsAppي الجديد للأوفلاين والاونلاين بكافة تفاصيل المدد الحصصية والزمنية]
      safeSendWhatsApp(studentIdNum, "FIRST_SUB", {
        subscriptionId: dbResult.id,
        studentName: student.name,
        subscriptionType: dbResult.subscriptionType,
        totalPrice: dbResult.totalPrice,
        endDate: dbResult.endDate,
        durationMonths: dbResult.durationMonths, // إرسال مدة الكورس لرسالة الواتساب الفورية 🔥
        totalSessions: dbResult.totalSessions,
        isOfflineProcessed: !!isOfflineMode,
        groups: dbResult.items.map((i) => i.session?.name || "غير مححدد"),
      });

      return res.json({
        success: true,
        message: isOfflineMode
          ? "تمت مزامنة وحفظ الاشتراك الأوفلاين بنجاح مالي تام وتنبيه ولي الأمر ⚡✅"
          : isFirstSubscription
            ? "تم تسجيل الاشتراك وتسكين المجموعات بنجاح 🎉"
            : "تم تجديد الاشتراك بنجاح مالي واستقرار تام بالخادم ✅",
        subscription: {
          id: dbResult.id,
          type: dbResult.subscriptionType,
          startDate: dbResult.startDate,
          endDate: dbResult.endDate,
          totalPrice: dbResult.totalPrice,
          status: dbResult.status,
          totalSessions: dbResult.totalSessions,
          durationMonths: dbResult.durationMonths,
          enrolledSessions: dbResult.items.map((item) => ({
            sessionId: item.sessionId,
            sessionName: item.session?.name || "غير محدد",
            teacherName: item.session?.teacher?.name || "غير محدد",
            subject: item.session?.teacher?.subject || "",
            price: item.priceSnapshot,
          })),
        },
      });
    } catch (error) {
      console.error("❌ Subscription EndPoint Error:", error);
      return res.status(400).json({ error: error.message });
    }
  },
);

// =============================================
// 1B️⃣ POST /api/subscriptions/bulk-sync - مزامنة جماعية ممتازة للاشتراكات المسجلة أوفلاين لدعم حقول الكورسات والمدد بدقة
// =============================================
router.post(
  "/bulk-sync",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { subscriptionsArray } = req.body;
      const { centerId, userId } = req.user;

      if (
        !Array.isArray(subscriptionsArray) ||
        subscriptionsArray.length === 0
      ) {
        return res.status(400).json({
          error: "يجب إرسال مصفوفة اشتراكات صالحة لبدء المزامنة الجماعية 🛑",
        });
      }

      const syncResultSummary = {
        succeededCount: 0,
        failedCount: 0,
        details: [],
      };
      const pendingWhatsAppNotifications = [];

      for (const syncItem of subscriptionsArray) {
        try {
          const { studentId, items, offlineCreatedAt } = syncItem;
          const currentStudentId = Number(studentId);

          if (!currentStudentId || isNaN(currentStudentId)) {
            throw new Error(
              "رقم تعريف الطالب غير صالح أو مفقود في ملف الأوفلاين المرفوع.",
            );
          }

          const subscriptionActionDate = offlineCreatedAt
            ? new Date(offlineCreatedAt)
            : new Date();

          const student = await prisma.student.findFirst({
            where: { id: currentStudentId, centerId },
            include: {
              subscriptions: {
                orderBy: { createdAt: "desc" },
                take: 1,
              },
            },
          });

          if (!student) {
            throw new Error(
              "الطالب المذكور غير موجود بالنظام أو لا ينتمي لصلاحيات هذا السنتر.",
            );
          }

          const validStages = ["PRIMARY", "MIDDLE", "HIGH"];
          const studentStageEnum = validStages.includes(
            student.stage?.toUpperCase(),
          )
            ? student.stage.toUpperCase()
            : null;

          if (!studentStageEnum) {
            throw new Error(
              `المرحلة الدراسية للطالب (${student.stage}) غير متوافقة مع النظام السحابي.`,
            );
          }

          const activeSub = student.subscriptions[0];

          // معالجة حركة البيانات المالية الفردية داخل الدفعة المجمعة بواسطة ميكانيزم الـ Transaction المنعزل والمحدث بالكامل
          const transactionResult = await prisma.$transaction(async (tx) => {
            let totalPrice = 0;
            const processedItems = [];
            let globalSubType = "MONTHLY";
            let finalTotalSessions = null;
            let finalDurationMonths = null;
            const perSessionData = [];

            // [الحالة 1]: التجديد التلقائي للأوفلاين (المصفوفة فارغة)
            if (!items || items.length === 0) {
              if (!activeSub) {
                throw new Error(
                  "لا يوجد اشتراك سابق للتجديد التلقائي؛ يرجى تمرير مجموعات صالحة.",
                );
              }

              globalSubType = activeSub.subscriptionType;
              const oldItems = await tx.subscriptionItem.findMany({
                where: { subscriptionId: activeSub.id },
                include: { session: true },
              });

              for (const oldItem of oldItems) {
                if (!oldItem.session) continue;
                const priceRecord = await tx.priceConfiguration.findFirst({
                  where: {
                    teacherId: oldItem.session.teacherId,
                    stage: studentStageEnum,
                    subscriptionType: globalSubType,
                    grades: { has: student.grade },
                  },
                });

                if (!priceRecord)
                  throw new Error(
                    `إعدادات التسعير وحزم المدرس مفقودة للتجديد التلقائي في السنتر.`,
                  );
                totalPrice += priceRecord.price;
                processedItems.push({
                  sessionId: oldItem.sessionId,
                  priceSnapshot: priceRecord.price,
                });

                if (
                  globalSubType === "PER_SESSION" &&
                  priceRecord.totalSessions
                ) {
                  finalTotalSessions =
                    (finalTotalSessions || 0) + priceRecord.totalSessions;
                  perSessionData.push({
                    days: oldItem.session.days,
                    totalSessions: priceRecord.totalSessions,
                  });
                }
                if (globalSubType === "COURSE" && priceRecord.durationMonths) {
                  finalDurationMonths = Math.max(
                    finalDurationMonths || 0,
                    priceRecord.durationMonths,
                  );
                }
              }

              const newEndDate = calculateEndDate(
                globalSubType,
                activeSub.endDate,
                finalDurationMonths || 1,
                subscriptionActionDate,
                perSessionData,
              );

              await tx.subscriptionItem.deleteMany({
                where: { subscriptionId: activeSub.id },
              });

              let updatedSub = await tx.subscription.update({
                where: { id: activeSub.id },
                data: {
                  startDate: subscriptionActionDate,
                  endDate: newEndDate,
                  totalPrice,
                  status: "ACTIVE",
                  totalSessions: finalTotalSessions
                    ? (activeSub.totalSessions || 0) + finalTotalSessions
                    : activeSub.totalSessions,
                  durationMonths:
                    finalDurationMonths || activeSub.durationMonths,
                  updatedAt: new Date(),
                },
              });

              await tx.subscriptionItem.createMany({
                data: processedItems.map((i) => ({
                  subscriptionId: updatedSub.id,
                  sessionId: i.sessionId,
                  priceSnapshot: i.priceSnapshot,
                })),
              });

              return updatedSub;
            } else {
              // [الحالة 2]: باقة مخصصة جديدة أو تعديل مجموعات الطلاب في وضع الأوفلاين الجماعي المجمع
              const uniqueSessionIds = [
                ...new Set(items.map((i) => Number(i.sessionId))),
              ];
              globalSubType = items[0].subscriptionType || "MONTHLY";

              for (const sId of uniqueSessionIds) {
                const session = await tx.session.findUnique({
                  where: { id: sId },
                  include: { teacher: true },
                });

                if (!session)
                  throw new Error(
                    `المجموعة رقم (${sId}) المرفوعة أوفلاين غير موجودة بقاعدة البيانات السحابية.`,
                  );

                const priceRecord = await tx.priceConfiguration.findFirst({
                  where: {
                    teacherId: session.teacherId,
                    stage: studentStageEnum,
                    subscriptionType: globalSubType,
                    grades: { has: student.grade },
                  },
                });

                if (!priceRecord)
                  throw new Error(
                    `لا يوجد تسعير متوافق مسجل للمدرس ${session.teacher?.name || ""} لهذه المرحلة.`,
                  );
                totalPrice += priceRecord.price;
                processedItems.push({
                  sessionId: sId,
                  priceSnapshot: priceRecord.price,
                });

                if (
                  globalSubType === "PER_SESSION" &&
                  priceRecord.totalSessions
                ) {
                  finalTotalSessions =
                    (finalTotalSessions || 0) + priceRecord.totalSessions;
                  perSessionData.push({
                    days: session.days,
                    totalSessions: priceRecord.totalSessions,
                  });
                }
                if (globalSubType === "COURSE" && priceRecord.durationMonths) {
                  finalDurationMonths = Math.max(
                    finalDurationMonths || 0,
                    priceRecord.durationMonths,
                  );
                }
              }

              const newEndDate = calculateEndDate(
                globalSubType,
                activeSub?.endDate,
                finalDurationMonths || 1,
                subscriptionActionDate,
                perSessionData,
              );

              let finalSub;
              if (activeSub) {
                await tx.subscriptionItem.deleteMany({
                  where: { subscriptionId: activeSub.id },
                });
                finalSub = await tx.subscription.update({
                  where: { id: activeSub.id },
                  data: {
                    subscriptionType: globalSubType,
                    totalPrice,
                    startDate: subscriptionActionDate,
                    endDate: newEndDate,
                    status: "ACTIVE",
                    totalSessions: finalTotalSessions,
                    usedSessions: 0,
                    durationMonths: finalDurationMonths,
                    updatedAt: new Date(),
                  },
                });
              } else {
                finalSub = await tx.subscription.create({
                  data: {
                    studentId: currentStudentId,
                    startDate: subscriptionActionDate,
                    endDate: newEndDate,
                    subscriptionType: globalSubType,
                    totalPrice,
                    status: "ACTIVE",
                    totalSessions: finalTotalSessions,
                    usedSessions: 0,
                    durationMonths: finalDurationMonths,
                    createdBy: userId,
                    createdAt: subscriptionActionDate,
                  },
                });
              }

              await tx.subscriptionItem.createMany({
                data: processedItems.map((i) => ({
                  subscriptionId: finalSub.id,
                  sessionId: i.sessionId,
                  priceSnapshot: i.priceSnapshot,
                })),
              });

              return finalSub;
            }
          });

          // إعادة جلب شاملة لملء بيانات الـ Relations لضمان وصولها كاملة للواتساب والملخص النهائي للدفعة المزامنة
          const fullResultWithRelations = await prisma.subscription.findUnique({
            where: { id: transactionResult.id },
            include: {
              items: { include: { session: true } },
            },
          });

          await prisma.activityLog.create({
            data: {
              centerId,
              userId,
              action: "BULK_OFFLINE_SUBSCRIPTION_SYNC_ITEM",
              targetType: "Subscription",
              targetId: fullResultWithRelations.id,
              createdAt: new Date(),
              details: JSON.stringify({
                studentId: currentStudentId,
                totalPrice: fullResultWithRelations.totalPrice,
                durationMonths: fullResultWithRelations.durationMonths,
              }),
            },
          });

          // إضافة كائن التنبيه المحسن لشريط الإرسال الخلفي بالواتساب
          pendingWhatsAppNotifications.push({
            studentId: currentStudentId,
            payload: {
              subscriptionId: fullResultWithRelations.id,
              studentName: student.name,
              subscriptionType: fullResultWithRelations.subscriptionType,
              totalPrice: fullResultWithRelations.totalPrice,
              endDate: fullResultWithRelations.endDate,
              durationMonths: fullResultWithRelations.durationMonths, // إطلاق المدة بالشهور فورياً 🚀
              totalSessions: fullResultWithRelations.totalSessions,
              isBulkSynced: true,
              groups: fullResultWithRelations.items.map(
                (i) => i.session?.name || "غير محدد",
              ),
            },
          });

          syncResultSummary.succeededCount++;
          syncResultSummary.details.push({
            studentId: currentStudentId,
            status: "SUCCESS",
            subscriptionId: fullResultWithRelations.id,
            durationMonths: fullResultWithRelations.durationMonths,
            totalSessions: fullResultWithRelations.totalSessions,
          });
        } catch (individualError) {
          syncResultSummary.failedCount++;
          syncResultSummary.details.push({
            studentId: syncItem.studentId || "غير محدد",
            status: "FAILED",
            reason: individualError.message,
          });
        }
      }

      // إرسال كتل رسائل الواتساب في الخلفية بأمان تام 🚀
      if (pendingWhatsAppNotifications.length > 0) {
        pendingWhatsAppNotifications.forEach((notifyItem) => {
          safeSendWhatsApp(
            notifyItem.studentId,
            "FIRST_SUB",
            notifyItem.payload,
          ).catch((err) => {
            console.error(
              `🚨 [BULK SYNC WHATSAPP THREAD ERROR] للطالب ${notifyItem.studentId}:`,
              err.message,
            );
          });
        });
      }

      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "BULK_OFFLINE_SUBSCRIPTION_SYNC_COMPLETED",
          targetType: "BulkJob",
          createdAt: new Date(),
          details: JSON.stringify({
            totalProcessed: subscriptionsArray.length,
            successCount: syncResultSummary.succeededCount,
            failCount: syncResultSummary.failedCount,
          }),
        },
      });

      return res.status(200).json({
        success: true,
        message: `تمت معالجة ومزامنة الدفعة الأوفلاين المجمعة بنجاح مالي وتحديث للمدد والكورسات. الناجحة: ${syncResultSummary.succeededCount}، الفاشلة: ${syncResultSummary.failedCount} 🎉⚡`,
        summary: syncResultSummary,
      });
    } catch (criticalError) {
      console.error("❌ Critical Subscription Bulk-Sync Error:", criticalError);
      return res.status(500).json({
        error:
          "انهيار داخلي في السيرفر أثناء معالجة حزمة المزامنة المجمعة للاشتراكات",
      });
    }
  },
);

// =============================================
// 2️⃣ GET /api/subscriptions - عرض وتصفية جميع اشتراكات السنتر بدقة وهندسة عرض مسطحة لسهولة القراءة بالفرونت إند
// =============================================
router.get("/", authenticateToken, requireCenterAccess, async (req, res) => {
  try {
    const { centerId } = req.user;
    const { status } = req.query;

    const subscriptions = await prisma.subscription.findMany({
      where: {
        student: { centerId },
        ...(status && { status: status.toUpperCase() }),
      },
      include: {
        student: {
          select: {
            id: true,
            name: true,
            phone: true,
            stage: true,
            grade: true,
          },
        },
        items: {
          include: {
            session: { include: { teacher: true } },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    const formattedData = subscriptions.map((sub) => ({
      id: sub.id,
      studentId: sub.student?.id,
      studentName: sub.student?.name,
      studentPhone: sub.student?.phone,
      stage: sub.student?.stage,
      grade: sub.student?.grade,
      startDate: sub.startDate,
      endDate: sub.endDate,
      totalPrice: sub.totalPrice,
      status: sub.status,
      subscriptionType: sub.subscriptionType,
      totalSessions: sub.totalSessions,
      usedSessions: sub.usedSessions,
      durationMonths: sub.durationMonths, // تسطيح حقل المدة بالشهور لعرضه فورياً ⚡
      activeGroups: sub.items.map((i) => ({
        sessionId: i.sessionId,
        sessionName: i.session?.name || "مجموعة محذوفة من النظام",
        teacherName: i.session?.teacher?.name || "غير محدد",
        subject: i.session?.teacher?.subject || "",
        price: i.priceSnapshot,
      })),
    }));

    return res.json({
      success: true,
      count: formattedData.length,
      data: formattedData,
    });
  } catch (error) {
    console.error("❌ Fetch Subscriptions Error:", error);
    return res.status(500).json({
      error:
        "حصل خطأ داخلي هندسي أثناء جلب ومعالجة البيانات المالية للاشتراكات والتحقق من التراخيص السحابية",
    });
  }
});

module.exports = router;
