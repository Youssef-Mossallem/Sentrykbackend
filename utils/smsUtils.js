// backend/utils/smsUtils.js
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// السعر للعرض في السجلات فقط، الخصم يتم بالوحدة (1)
const CHARGE_PRICE =
  parseFloat(process.env.CHARGE_SMS_PRICE_PER_MESSAGE) || 0.23;

/**
 * دالة مساعدة لحساب عدد أجزاء الرسالة بناءً على 60 حرفاً للجزء الواحد
 * @param {string} text - نص الرسالة
 * @returns {number} - عدد الأجزاء
 */
function calculateSmsParts(text) {
  if (!text) return 0;
  const charCount = text.trim().length;
  // كل 60 حرف = رسالة واحدة، يتم التقريب للأعلى دائماً
  return Math.ceil(charCount / 60);
}

/**
 * إرسال إشعار SMS تلقائي ذكي لولي أمر الطالب
 * @param {number|string} studentId - ID الطالب
 * @param {string} eventType - FIRST_SUB | ENDING_SOON | EXPIRED | RENEWED
 */
async function sendAutoSms(studentId, eventType) {
  try {
    const numericId = Number(studentId);
    if (isNaN(numericId) || numericId <= 0) {
      console.warn(`[AUTO SMS] studentId غير صالح: ${studentId}`);
      return { success: false, reason: "invalid_student_id" };
    }

    // جلب الطالب مع أحدث اشتراك وبيانات السنتر
    const student = await prisma.student.findUnique({
      where: { id: numericId },
      include: {
        center: { select: { name: true, id: true } },
        subscriptions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: {
            items: {
              include: { subject: { select: { name: true } } },
            },
          },
        },
      },
    });

    if (!student || !student.phone?.trim()) {
      console.warn(`[AUTO SMS] لا يوجد طالب أو رقم تليفون لـ ID: ${numericId}`);
      return { success: false, reason: "no_phone" };
    }

    const phone = student.phone.trim();
    const centerName = student.center?.name || "المركز التعليمي";
    const lastSub = student.subscriptions[0];

    // إذا كان الحدث يتطلب بيانات اشتراك ولم نجد اشتراكاً
    if (!lastSub && eventType !== "FIRST_SUB") {
      console.warn(`[AUTO SMS] لا يوجد سجل اشتراك للطالب ${student.name}`);
      return { success: false, reason: "no_subscription_found" };
    }

    // تجهيز بيانات الرسالة المتغيرة
    const endDateStr = lastSub?.endDate 
      ? new Date(lastSub.endDate).toLocaleDateString("ar-EG") 
      : "غير محدد";
    const subType = lastSub?.subscriptionType || "غير محدد";
    const totalPrice = lastSub?.totalPrice || 0;

    const materialsList = lastSub?.items
      ? lastSub.items
          .map((item) => `• ${item.subject.name} - ${item.priceSnapshot} ج.م`)
          .join("\n")
      : "لا توجد مواد محددة";

    let message = "";

    // إنشاء نص الرسالة حسب نوع الحدث
    switch (eventType) {
      case "FIRST_SUB":
        message = `مرحبًا بك في ${centerName}!\nتم تسجيل ${student.name} بنجاح.\nاشتراكك (${subType}) ينتهي يوم ${endDateStr}.\nالمواد:\n${materialsList}\nالمجموع: ${totalPrice} ج.م`;
        break;

      case "ENDING_SOON":
        message = `عزيزي ولي أمر ${student.name}،\nنذكرك بأن اشتراك الطالب في ${centerName} (${subType}) سينتهي بتاريخ ${endDateStr}.\nيرجى التجديد لضمان الاستمرار.`;
        break;

      case "EXPIRED":
        message = `عزيزي ولي أمر ${student.name}،\nنحيطكم علماً بأن اشتراك السنتر (${centerName}) قد انتهى بتاريخ ${endDateStr}.\nيرجى التجديد لاستئناف الحضور.`;
        break;

      case "RENEWED":
        message = `تم تجديد اشتراك ${student.name} بنجاح في ${centerName}!\nالاشتراك الجديد (${subType}) ينتهي يوم ${endDateStr}.\nالمواد:\n${materialsList}\nالمجموع: ${totalPrice} ج.م\nشكراً لكم.`;
        break;

      default:
        console.warn(`[AUTO SMS] نوع حدث غير معروف: ${eventType}`);
        return { success: false, reason: "invalid_event_type" };
    }

    // --- حساب عدد الأجزاء المطلوبة بناءً على النص النهائي ---
    const requiredParts = calculateSmsParts(message);

    // 1. التحقق من رصيد المحفظة
    const wallet = await prisma.smsWallet.findUnique({
      where: { centerId: student.centerId },
    });

    if (!wallet || wallet.balance < requiredParts) {
      console.warn(`[AUTO SMS] رصيد غير كافٍ لمركز ${student.centerId}. المطلوب: ${requiredParts}، المتاح: ${wallet?.balance || 0}`);
      return { success: false, reason: "insufficient_balance" };
    }

    // 2. خصم عدد الأجزاء الفعلي وتحديث المحفظة وتسجيل العملية
    await prisma.$transaction([
      prisma.smsWallet.update({
        where: { centerId: student.centerId },
        data: { balance: { decrement: requiredParts } },
      }),
      prisma.smsTransaction.create({
        data: {
          walletId: wallet.id,
          amount: -requiredParts, // تسجيل عدد الأجزاء المسحوبة كقيمة سالبة
          type: "SEND",
          description: `[تلقائي: ${eventType}] - طالب: ${student.name} - أجزاء: ${requiredParts} - هاتف: ${phone}`,
        },
      }),
    ]);

    // 3. تنفيذ الإرسال الفعلي (Log)
    console.log(`------------------------------------`);
    console.log(`[SMS SENT AUTO] نوع الحدث: ${eventType}`);
    console.log(`إلى: ${phone}`);
    console.log(`عدد الحروف: ${message.length}`);
    console.log(`عدد الرسائل المحسوبة: ${requiredParts}`);
    console.log(`الرسالة: ${message}`);
    console.log(`------------------------------------`);

    return { success: true, partsSent: requiredParts };
  } catch (error) {
    console.error(`[AUTO SMS ERROR] تفاصيل الخطأ:`, error.message);
    return { success: false, reason: "internal_error" };
  }
}

// تنظيف الاتصال عند إغلاق السيرفر
process.on("SIGTERM", async () => await prisma.$disconnect());
process.on("SIGINT", async () => await prisma.$disconnect());

module.exports = { sendAutoSms };