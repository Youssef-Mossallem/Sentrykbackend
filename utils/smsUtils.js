const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// السعر للعرض فقط، الخصم يتم بالوحدة (رسالة واحدة)
const CHARGE_PRICE = parseFloat(process.env.CHARGE_SMS_PRICE_PER_MESSAGE) || 0.23;

/**
 * حساب عدد أجزاء الرسالة بناءً على 60 حرفاً للجزء (عربي)
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
    if (isNaN(numericId) || numericId <= 0) return { success: false, reason: "invalid_student_id" };

    const student = await prisma.student.findUnique({
      where: { id: numericId },
      include: {
        center: { select: { name: true, id: true } },
        subscriptions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: {
            items: { include: { subject: { select: { name: true } } } },
          },
        },
      },
    });

    if (!student || !student.phone?.trim()) return { success: false, reason: "no_phone" };

    const phone = student.phone.trim();
    const centerName = student.center?.name || "المركز";
    const lastSub = student.subscriptions[0];

    if (!lastSub && eventType !== "FIRST_SUB") return { success: false, reason: "no_sub_found" };

    // تنسيق التاريخ (يوم/شهر)
    const endDate = lastSub?.endDate 
      ? new Date(lastSub.endDate).toLocaleDateString("ar-EG", { day: 'numeric', month: 'numeric' })
      : "";

    // تجهيز قائمة المواد المختصرة (مادة:سعر)
    // مثال: فيزياء:100ج | كيمياء:100ج
    const itemsList = lastSub?.items
      ? lastSub.items.map(i => `${i.subject.name}:${i.priceSnapshot}ج`).join(" | ")
      : "";

    let message = "";

    // صياغة احترافية تشمل كل البيانات الأساسية
    switch (eventType) {
      case "FIRST_SUB":
        message = `تم تسجيل ${student.name} بـ ${centerName}\nالمواد: ${itemsList}\nالإجمالي: ${lastSub.totalPrice}ج\nالانتهاء: ${endDate}`;
        break;

      case "ENDING_SOON":
        message = `تنبيه: اشتراك ${student.name} بـ ${centerName} ينتهي ${endDate}\nالمواد: ${itemsList}\nيرجى التجديد.`;
        break;

      case "EXPIRED":
        message = `عذراً: انتهى اشتراك ${student.name} بـ ${centerName} (${endDate})\nالمواد: ${itemsList}\nيرجى مراجعة السنتر.`;
        break;

      case "RENEWED":
        message = `تم تجديد اشتراك ${student.name} بـ ${centerName}\nالمواد: ${itemsList}\nالإجمالي: ${lastSub.totalPrice}ج\nالانتهاء: ${endDate}`;
        break;

      default:
        return { success: false, reason: "invalid_event_type" };
    }

    const requiredParts = calculateSmsParts(message);

    const wallet = await prisma.smsWallet.findUnique({
      where: { centerId: student.centerId },
    });

    if (!wallet || wallet.balance < requiredParts) {
      console.warn(`[SMS] رصيد غير كاف لمركز ${student.centerId}`);
      return { success: false, reason: "insufficient_balance" };
    }

    // خصم الرصيد وتسجيل العملية
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
          description: `[تلقائي: ${eventType}] - ${student.name} - ${requiredParts} رسالة`,
        },
      }),
    ]);

    console.log(`[SMS SENT] ${phone} | Parts: ${requiredParts} | Text: ${message}`);

    return { success: true, partsSent: requiredParts };
  } catch (error) {
    console.error(`[AUTO SMS ERROR]:`, error.message);
    return { success: false, reason: "internal_error" };
  }
}

process.on("SIGTERM", async () => await prisma.$disconnect());
process.on("SIGINT", async () => await prisma.$disconnect());

module.exports = { sendAutoSms };
