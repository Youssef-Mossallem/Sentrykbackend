// backend/utils/smsUtils.js
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const CHARGE_PRICE = parseFloat(process.env.CHARGE_SMS_PRICE_PER_MESSAGE) || 0.23;

function calculateSmsParts(text) {
  if (!text) return 0;
  return Math.ceil(text.trim().length / 60);
}

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
    const centerName = student.center?.name || "المركز التعليمي";
    const lastSub = student.subscriptions[0];

    if (!lastSub && eventType !== "FIRST_SUB") return { success: false, reason: "no_subscription_found" };

    const endDateStr = lastSub?.endDate ? new Date(lastSub.endDate).toLocaleDateString("ar-EG") : "غير محدد";
    const subType = lastSub?.subscriptionType || "غير محدد";
    const totalPrice = lastSub?.totalPrice || 0;

    // تجهيز قائمة المواد (لو موجودة)
    const materialsList = lastSub?.items?.length
      ? lastSub.items.map(i => `${i.subject.name}-${i.priceSnapshot}ج`).join(", ")
      : "";

    let message = "";

    switch (eventType) {
      case "FIRST_SUB":
        message = `مرحبًا ${student.name}!\n${centerName}\nاشتراك: ${subType}\nينتهي: ${endDateStr}`;
        if (materialsList) message += `\nمواد: ${materialsList}`;
        message += `\nالمجموع: ${totalPrice}ج.م`;
        break;

      case "ENDING_SOON":
        message = `${student.name}، اشتراكه في ${centerName} (${subType}) ينتهي: ${endDateStr}. يرجى التجديد.`;
        break;

      case "EXPIRED":
        message = `${student.name}، اشتراكه في ${centerName} انتهى: ${endDateStr}. يرجى التجديد.`;
        break;

      case "RENEWED":
        message = `تم تجديد اشتراك ${student.name} في ${centerName} (${subType}) حتى ${endDateStr}`;
        if (materialsList) message += `\nمواد: ${materialsList}`;
        message += `\nالمجموع: ${totalPrice}ج.م`;
        break;

      default:
        return { success: false, reason: "invalid_event_type" };
    }

    const requiredParts = calculateSmsParts(message);

    const wallet = await prisma.smsWallet.findUnique({ where: { centerId: student.centerId } });
    if (!wallet || wallet.balance < requiredParts) return { success: false, reason: "insufficient_balance" };

    await prisma.$transaction([
      prisma.smsWallet.update({ where: { centerId: student.centerId }, data: { balance: { decrement: requiredParts } } }),
      prisma.smsTransaction.create({
        data: {
          walletId: wallet.id,
          amount: -requiredParts,
          type: "SEND",
          description: `[تلقائي:${eventType}] ${student.name}, أجزاء:${requiredParts}, هاتف:${phone}`,
        },
      }),
    ]);

    console.log(`[SMS SENT] نوع: ${eventType}, إلى: ${phone}, أجزاء: ${requiredParts}, نص: ${message}`);
    return { success: true, partsSent: requiredParts };
  } catch (error) {
    console.error(`[AUTO SMS ERROR]`, error.message);
    return { success: false, reason: "internal_error" };
  }
}

process.on("SIGTERM", async () => await prisma.$disconnect());
process.on("SIGINT", async () => await prisma.$disconnect());

module.exports = { sendAutoSms };
