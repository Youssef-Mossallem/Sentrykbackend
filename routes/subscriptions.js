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
// مساعدات الوقت والتاريخ وقفل اللوجيك (Helpers)
// =============================================

/**
 * دالة مساعدة مطورة لحساب تاريخ النهاية التراكمي متوافقة مع الأوفلاين
 * تم إضافة المعامل referenceDate لضمان البناء فوق التوقيت التاريخي الصحيح للأوفلاين بدلاً من وقت السيرفر الحالي
 */
const calculateEndDate = (
  subscriptionType,
  currentEndDate,
  durationInMonths = 1,
  referenceDate = new Date()
) => {
  // 🚀 لو الاشتراك الحالي لسه مانتهاش بالنسبة لوقت العملية المحددة، بنبني التاريخ الجديد فوق القديم لضمان حق الطالب كاملاً
  const baseDate =
    currentEndDate && new Date(currentEndDate) > referenceDate
      ? new Date(currentEndDate)
      : new Date(referenceDate);

  const end = new Date(baseDate);
  end.setHours(23, 59, 59, 999);

  switch (subscriptionType) {
    case "HALF_MONTH":
      end.setDate(end.getDate() + 15);
      break;
    case "COURSE":
      end.setMonth(end.getMonth() + (durationInMonths || 3));
      break;
    case "PER_SESSION":
      end.setDate(end.getDate() + 1); // الحصة تنتهي بنهاية اليوم
      break;
    case "MONTHLY":
    default:
      end.setMonth(end.getMonth() + 1);
      break;
  }
  return end;
};

// =============================================
// غلاف الإرسال الآمن لحماية الخلفية من الانهيار (Safe Background Wrapper)
// =============================================
async function safeSendWhatsApp(studentId, type, payload = {}) {
  try {
    if (typeof sendAutoWhatsApp === "function") {
      await sendAutoWhatsApp(studentId, type, payload);
    }
  } catch (error) {
    console.error(
      `❌ [SUBSCRIPTION ROUTE WHATSAPP ERROR] لـ الطالب رقم ${studentId}:`,
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
      // استقبال حقول الأوفلاين الاختيارية من الفرونت إند
      const { items, isOfflineMode, offlineCreatedAt } = req.body; 
      const { centerId, userId } = req.user;

      // تحديد وقت البدء الحقيقي للعملية ماليًا وزمنيًا
      const subscriptionActionDate = isOfflineMode && offlineCreatedAt ? new Date(offlineCreatedAt) : new Date();

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
          .json({ error: "الطالب غير موجود بالنظام أو لا يتبع هذا السنتر" });
      }

      isFirstSubscription = student.subscriptions.length === 0;
      const activeSub = student.subscriptions[0];

      // 2. معالجة وتأمين البيانات بواسطة DB Transaction لمنع أي خطأ مالي أو تضارب بالبيانات
      const dbResult = await prisma.$transaction(async (tx) => {
        let subscription;

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
                stage: student.stage,
                subscriptionType: globalSubType,
                grades: { has: student.grade }, // التحقق الذكي من مصفوفة السنوات بالبريسما
              },
            });

            if (!priceRecord) {
              throw new Error(
                `لم يتم العثور على إعدادات تسعير صالحة للمدرس ${oldItem.session.teacher?.name || ""} متوافقة مع مرحلة وسنة الطالب.`,
              );
            }

            totalPrice += priceRecord.price;
            processedItems.push({
              sessionId: oldItem.sessionId,
              priceSnapshot: priceRecord.price,
            });
          }

          // استخدام مرجع تاريخ العملية الأوفلاين الصحيح بدلاً من وقت الخادم التلقائي
          const newEndDate = calculateEndDate(globalSubType, activeSub.endDate, 1, subscriptionActionDate);

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

            // جلب بيانات المجموعة للوصول لمعرف المدرس التابع لها
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
                stage: student.stage,
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
          }

          const newEndDate = calculateEndDate(
            globalSubType,
            activeSub?.endDate,
            1,
            subscriptionActionDate
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

        // جلب كائن الاشتراك النهائي مدمجاً بكافة تفاصيل العلاقات الجديدة لعرضها الفوري بالفرونت إند
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
              : (isFirstSubscription ? "CREATE_SUBSCRIPTION" : "RENEW_SUBSCRIPTION"),
            targetType: "Subscription",
            targetId: subscription.id,
            createdAt: subscriptionActionDate,
            details: JSON.stringify({
              totalPrice: subscription.totalPrice,
              endDate: subscription.endDate,
              sessionsCount: subscription.items.length,
              isOfflineSync: !!isOfflineMode
            }),
          },
        });

        return subscription;
      });

      // 🚀 [تحديث السحر الـ WhatsAppي الجديد]
      // توجيه الإرسال دائماً لقالب الـ FIRST_SUB المتطور والمسؤول عن صياغة وعرض باقة الحصص الحالية والجديدة لولي الأمر
      safeSendWhatsApp(studentIdNum, "FIRST_SUB").catch((err) => {
        console.error(
          `[BACKGROUND WHATSAPP EXCEPTION IN ROUTE] طالب ${studentIdNum}:`,
          err.message,
        );
      });

      // استجابة مطابقة تماماً للمتطلبات والمعايير القياسية للوحة التحكم
      return res.json({
        success: true,
        message: isOfflineMode
          ? "تمت مزامنة وحفظ الاشتراك الأوفلاين بنجاح مالي تام ⚡✅"
          : (isFirstSubscription ? "تم تسجيل الاشتراك وتسكين Mجموعات بنجاح 🎉" : "تم تجديد الاشتراك بنجاح مالي واستقرار تام بالخادم ✅"),
        subscription: {
          id: dbResult.id,
          type: dbResult.subscriptionType,
          startDate: dbResult.startDate,
          endDate: dbResult.endDate,
          totalPrice: dbResult.totalPrice,
          status: dbResult.status,
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
// 1B️⃣ POST /api/subscriptions/bulk-sync - مزامنة جماعية للاشتراكات المسجلة أوفلاين (Bulk Subscription Sync)
// =============================================
router.post(
  "/bulk-sync",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { subscriptionsArray } = req.body; // يتوقع مصفوفة من العمليات: [{ studentId: 10, items: [], offlineCreatedAt: "..." }]
      const { centerId, userId } = req.user;

      if (!Array.isArray(subscriptionsArray) || subscriptionsArray.length === 0) {
        return res.status(400).json({ error: "يجب إرسال مصفوفة اشتراكات صالحة لبدء المزامنة" });
      }

      const syncResultSummary = { succeededCount: 0, failedCount: 0, details: [] };

      // استخدام حلقة تكرارية مرنة لمعالجة كل اشتراك على حدة لكي لا يتعطل كامل الطابور بسبب خطأ فردي
      for (const syncItem of subscriptionsArray) {
        try {
          const { studentId, items, offlineCreatedAt } = syncItem;
          const currentStudentId = Number(studentId);

          if (!currentStudentId || isNaN(currentStudentId)) {
            throw new Error("رقم تعريف الطالب غير صالح أو مفقود");
          }

          const subscriptionActionDate = offlineCreatedAt ? new Date(offlineCreatedAt) : new Date();

          // جلب الطالب والتحقق من تبعيته للمركز الحالي
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
            throw new Error("الطالب المذكور غير موجود بالنظام أو لا ينتمي لهذا السنتر");
          }

          const activeSub = student.subscriptions[0];

          await prisma.$transaction(async (tx) => {
            let totalPrice = 0;
            const processedItems = [];
            let globalSubType = "MONTHLY";

            // في حالة التجديد التلقائي (المصفوفة فارغة)
            if (!items || items.length === 0) {
              if (!activeSub) {
                throw new Error("لا يوجد اشتراك سابق للتجديد التلقائي؛ يرجى تمرير مجموعات صالحة.");
              }

              globalSubType = activeSub.subscriptionType;
              // جلب بنود الاشتراك القديمة
              const oldItems = await tx.subscriptionItem.findMany({
                where: { subscriptionId: activeSub.id },
                include: { session: true }
              });

              for (const oldItem of oldItems) {
                if (!oldItem.session) continue;
                const priceRecord = await tx.priceConfiguration.findFirst({
                  where: {
                    teacherId: oldItem.session.teacherId,
                    stage: student.stage,
                    subscriptionType: globalSubType,
                    grades: { has: student.grade },
                  },
                });

                if (!priceRecord) throw new Error(`إعدادات التسعير مفقودة للمدرس المعني في نظام السنتر.`);
                totalPrice += priceRecord.price;
                processedItems.push({ sessionId: oldItem.sessionId, priceSnapshot: priceRecord.price });
              }

              const newEndDate = calculateEndDate(globalSubType, activeSub.endDate, 1, subscriptionActionDate);

              await tx.subscriptionItem.deleteMany({ where: { subscriptionId: activeSub.id } });
              await tx.subscription.update({
                where: { id: activeSub.id },
                data: {
                  startDate: subscriptionActionDate,
                  endDate: newEndDate,
                  totalPrice,
                  status: "ACTIVE",
                  updatedAt: new Date(),
                }
              });

              await tx.subscriptionItem.createMany({
                data: processedItems.map(i => ({
                  subscriptionId: activeSub.id,
                  sessionId: i.sessionId,
                  priceSnapshot: i.priceSnapshot
                }))
              });

            } else {
              // في حالة باقة مخصصة أو تعديل مجموعات
              const uniqueSessionIds = [...new Set(items.map(i => Number(i.sessionId)))];
              globalSubType = items[0].subscriptionType || "MONTHLY";

              for (const sId of uniqueSessionIds) {
                const session = await tx.session.findUnique({
                  where: { id: sId },
                  include: { teacher: true }
                });

                if (!session) throw new Error(`المجموعة رقم (${sId}) غير موجودة بالنظام.`);

                const priceRecord = await tx.priceConfiguration.findFirst({
                  where: {
                    teacherId: session.teacherId,
                    stage: student.stage,
                    subscriptionType: globalSubType,
                    grades: { has: student.grade }
                  }
                });

                if (!priceRecord) throw new Error(`لا يوجد تسعير متوافق للمدرس ${session.teacher?.name || ""}.`);
                totalPrice += priceRecord.price;
                processedItems.push({ sessionId: sId, priceSnapshot: priceRecord.price });
              }

              const newEndDate = calculateEndDate(globalSubType, activeSub?.endDate, 1, subscriptionActionDate);

              let subId = activeSub?.id;
              if (activeSub) {
                await tx.subscriptionItem.deleteMany({ where: { subscriptionId: activeSub.id } });
                await tx.subscription.update({
                  where: { id: activeSub.id },
                  data: {
                    subscriptionType: globalSubType,
                    totalPrice,
                    startDate: subscriptionActionDate,
                    endDate: newEndDate,
                    status: "ACTIVE",
                    updatedAt: new Date()
                  }
                });
              } else {
                const newSub = await tx.subscription.create({
                  data: {
                    studentId: currentStudentId,
                    startDate: subscriptionActionDate,
                    endDate: newEndDate,
                    subscriptionType: globalSubType,
                    totalPrice,
                    status: "ACTIVE",
                    createdBy: userId,
                    createdAt: subscriptionActionDate
                  }
                });
                subId = newSub.id;
              }

              await tx.subscriptionItem.createMany({
                data: processedItems.map(i => ({
                  subscriptionId: subId,
                  sessionId: i.sessionId,
                  priceSnapshot: i.priceSnapshot
                }))
              });
            }

            // تدوين لوج المزامنة بنجاح
            await tx.activityLog.create({
              data: {
                centerId,
                userId,
                action: "BULK_OFFLINE_SUBSCRIPTION_SYNC",
                targetType: "Subscription",
                targetId: activeSub ? activeSub.id : 0,
                createdAt: new Date(),
                details: JSON.stringify({ studentId: currentStudentId, totalPrice })
              }
            });
          });

          // إرسال تنبيه واتساب فوري في الخلفية
          safeSendWhatsApp(currentStudentId, "FIRST_SUB").catch(() => {});

          syncResultSummary.succeededCount++;
          syncResultSummary.details.push({ studentId: currentStudentId, status: "SUCCESS" });
        } catch (individualError) {
          syncResultSummary.failedCount++;
          syncResultSummary.details.push({
            studentId: syncItem.studentId || "غير محدد",
            status: "FAILED",
            reason: individualError.message
          });
        }
      }

      return res.status(200).json({
        success: true,
        message: `تمت معالجة الدفعة الأوفلاين المجمعة بنجاح. الناجحة: ${syncResultSummary.succeededCount}، الفاشلة: ${syncResultSummary.failedCount}`,
        summary: syncResultSummary
      });

    } catch (criticalError) {
      console.error("❌ Critical Subscription Bulk-Sync Error:", criticalError);
      return res.status(500).json({ error: "انهيار داخلي أثناء معالجة حزمة المزامنة المجمعة للاشتراكات" });
    }
  }
);

// =============================================
// 2️⃣ GET /api/subscriptions - عرض وتصفية جميع اشتراكات السنتر (ADMIN, SECRETARY)
// =============================================
router.get("/", authenticateToken, requireCenterAccess, async (req, res) => {
  try {
    const { centerId } = req.user;
    const { status } = req.query;

    // جلب الاشتراكات المفلترة مع دمج بيانات الطلاب ومجموعات الحصص ومدرسيها
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

    // معالجة البيانات وإعادتها بشكل مسطح وثابت (Flat Structure) لراحة وعرض جداول الفرونت إند
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
      activeGroups: sub.items.map((i) => ({
        sessionId: i.sessionId,
        sessionName: i.session?.name || "مجموعة محذوفة",
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
    return res
      .status(500)
      .json({
        error: "حصل خطأ داخلي أثناء جلب ومعالجة البيانات المالية للاشتراكات",
      });
  }
});

module.exports = router;