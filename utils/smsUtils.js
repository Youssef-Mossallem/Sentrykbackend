const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const CHARGE_PRICE =
  parseFloat(process.env.CHARGE_SMS_PRICE_PER_MESSAGE) || 0.23;

/**
 * دالة مساعدة لحساب عدد أجزاء الرسالة بناءً على 60 حرفاً للجزء الواحد
 */
function calculateSmsParts(text) {
  if (!text) return 0;
  const charCount = text.trim().length;
  return Math.ceil(charCount / 60);
}

/**
 * إرسال إشعار SMS تلقائي ذكي لولي أمر الطالب
 */
async function sendAutoSms(studentId, eventType) {
  try {
    const numericId = Number(studentId);
    if (isNaN(numericId) || numericId <= 0) {
      console.warn(`[AUTO SMS] studentId غير صالح: ${studentId}`);
      return { success: false, reason: "invalid_student_id" };
    }

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
    const centerName = student.center?.name;
    const lastSub = student.subscriptions[0];

    if (!lastSub && eventType !== "FIRST_SUB") {
      console.warn(`[AUTO SMS] لا يوجد سجل اشتراك للطالب ${student.name}`);
      return { success: false, reason: "no_subscription_found" };
    }

    // --- بناء محتوى الرسالة بذكاء (حذف الفارغ وتقليل الحروف) ---
    
    // 1. تجهيز التاريخ بشكل مختصر (يوم/شهر فقط لتوفير مساحة)
    const endDate = lastSub?.endDate ? new Date(lastSub.endDate).toLocaleDateString("ar-EG", {day:'numeric', month:'numeric'}) : null;
    
    // 2. تجهيز قائمة المواد (فقط إذا وجدت)
    const materialsList = (lastSub?.items && lastSub.items.length > 0)
      ? lastSub.items.map((item) => `${item.subject.name}:${item.priceSnapshot}`).join(" | ")
      : null;

    const totalPrice = lastSub?.totalPrice;
    const studentName = student.name;

    let message = "";

    // تصميم الرسائل المختصر:
    switch (eventType) {
      case "FIRST_SUB":
        message = `تم تسجيل ${studentName} بـ ${centerName}`;
        if (materialsList) message += `\nمواد: ${materialsList}`;
        if (totalPrice) message += `\nإجمالي: ${totalPrice}ج`;
        if (endDate) message += `\nينتهي: ${endDate}`;
        break;

      case "ENDING_SOON":
        message = `تنبيه: اشتراك ${studentName} بـ ${centerName} ينتهي يوم ${endDate}. نرجو التجديد.`;
        break;

      case "EXPIRED":
        message = `عذراً: انتهى اشتراك ${studentName} بـ ${centerName} بتاريخ ${endDate}.`;
        break;

      case "RENEWED":
        message = `تم تجديد ${studentName} بـ ${centerName}`;
        if (materialsList) message += `\nمواد: ${materialsList}`;
        if (totalPrice) message += `\nإجمالي: ${totalPrice}ج`;
        if (endDate) message += `\nينتهي: ${endDate}`;
        break;

      default:
        return { success: false, reason: "invalid_event_type" };
    }

    // تنظيف الرسالة من أي مسافات زائدة
    message = message.trim();

    const requiredParts = calculateSmsParts(message);

    const wallet = await prisma.smsWallet.findUnique({
      where: { centerId: student.centerId },
    });

    if (!wallet || wallet.balance < requiredParts) {
      console.warn(`[AUTO SMS] رصيد غير كافٍ. المطلوب: ${requiredParts}`);
      return { success: false, reason: "insufficient_balance" };
    }

    await prisma.$transaction([
      prisma.smsWallet.update({
        where: { centerId: student.centerId },
        data: { balance: { decrement: requiredParts } },
      }),
      prisma.smsTransaction.create({
        data: {
          walletId: wallet.id,
          amount: -requiredParts,
          type: "SEND",
          description: `[${eventType}]-طالب:${studentName}-${requiredParts}جزء`,
        },
      }),
    ]);

    console.log(`------------------------------------`);
    console.log(`[SMS SENT AUTO] إلى: ${phone}`);
    console.log(`الحروف: ${message.length} | الأجزاء: ${requiredParts}`);
    console.log(`النص: ${message}`);
    console.log(`------------------------------------`);

    return { success: true, partsSent: requiredParts };
  } catch (error) {
    console.error(`[AUTO SMS ERROR]:`, error.message);
    return { success: false, reason: "internal_error" };
  }
}

process.on("SIGTERM", async () => await prisma.$disconnect());
process.on("SIGINT", async () => await prisma.$disconnect());

module.exports = { sendAutoSms };
