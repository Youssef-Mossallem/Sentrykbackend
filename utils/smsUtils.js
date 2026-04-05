const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

/**
 * حساب أجزاء الرسالة (عربي) - 60 حرفاً للجزء الواحد لضمان التوفير والاحترافية
 */
function calculateSmsParts(text) {
  if (!text) return 0;
  const charCount = text.trim().length;
  // التكسير يتم كل 60 حرف، والتقريب دائماً للأعلى
  return Math.ceil(charCount / 60);
}

/**
 * إرسال إشعار SMS تلقائي "سنتريك" - نسخة احترافية خالية من الأخطاء
 * @param {number|string} studentId - ID الطالب
 * @param {string} eventType - نوع الحدث (FIRST_SUB | ENDING_SOON | EXPIRED | RENEWED)
 */
async function sendAutoSms(studentId, eventType) {
  try {
    const numericId = Number(studentId);
    if (!numericId || numericId <= 0) {
      return { success: false, reason: "invalid_student_id" };
    }

    // جلب بيانات الطالب مع السنتر وآخر اشتراك بطلب واحد (Optimized Query)
    const student = await prisma.student.findUnique({
      where: { id: numericId },
      include: {
        center: { select: { name: true, id: true } },
        subscriptions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: {
            items: { 
              include: { 
                subject: { select: { name: true } } 
              } 
            },
          },
        },
      },
    });

    // 1. فحص وجود الطالب وهاتفه
    if (!student || !student.phone?.trim()) {
      console.warn(`[SMS FAIL] الطالب ${numericId} غير موجود أو بدون هاتف.`);
      return { success: false, reason: "no_student_or_phone" };
    }

    const phone = student.phone.trim();
    const centerName = student.center?.name || "المركز";
    
    // 2. فحص وجود اشتراك (Safe Access)
    const lastSub = (student.subscriptions && student.subscriptions.length > 0) 
      ? student.subscriptions[0] 
      : null;

    if (!lastSub) {
      console.warn(`[SMS FAIL] لا يوجد اشتراك للطالب: ${student.name}`);
      return { success: false, reason: "no_subscription_record" };
    }

    // 3. تجهيز البيانات المالية والزمنية بأمان (Null Safety)
    const totalPrice = lastSub.totalPrice || 0;
    const endDate = lastSub.endDate 
      ? new Date(lastSub.endDate).toLocaleDateString("ar-EG", { day: 'numeric', month: 'numeric' })
      : "غير محدد";

    // تحويل قائمة المواد لشكل: (مادة:سعر | مادة:سعر)
    const itemsList = (lastSub.items && lastSub.items.length > 0)
      ? lastSub.items.map(i => `${i.subject?.name || "مادة"}:${i.priceSnapshot || 0}ج`).join(" | ")
      : "لا يوجد مواد";

    let message = "";

    // 4. بناء نص الرسالة بناءً على الحدث (شكل أسطوري ومختصر)
    switch (eventType) {
      case "FIRST_SUB":
        message = `تم تسجيل ${student.name} بـ ${centerName}\nالمواد: ${itemsList}\nالإجمالي: ${totalPrice}ج\nالانتهاء: ${endDate}`;
        break;

      case "ENDING_SOON":
        message = `تنبيه: اشتراك ${student.name} بـ ${centerName} ينتهي ${endDate}\nالمواد: ${itemsList}\nيرجى التجديد.`;
        break;

      case "EXPIRED":
        message = `عذراً: انتهى اشتراك ${student.name} بـ ${centerName} (${endDate})\nالمواد: ${itemsList}\nيرجى مراجعة السنتر.`;
        break;

      case "RENEWED":
        message = `تم تجديد اشتراك ${student.name} بـ ${centerName}\nالمواد: ${itemsList}\nالإجمالي: ${totalPrice}ج\nالانتهاء: ${endDate}`;
        break;

      default:
        console.error(`[SMS FAIL] نوع الحدث غير مدعوم: ${eventType}`);
        return { success: false, reason: "unsupported_event_type" };
    }

    // 5. حساب التكلفة والتحقق من المحفظة
    const requiredParts = calculateSmsParts(message);

    const wallet = await prisma.smsWallet.findUnique({
      where: { centerId: student.centerId },
    });

    if (!wallet || wallet.balance < requiredParts) {
      console.error(`[SMS FAIL] رصيد غير كاف لمركز: ${centerName}. متاح: ${wallet?.balance || 0}`);
      return { success: false, reason: "insufficient_balance" };
    }

    // 6. تنفيذ الخصم وتسجيل المعاملة في قاعدة البيانات (Atomic Transaction)
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

    // 7. الـ Console Logs الأسطورية لمتابعة كل شيء
    console.log(`\n--- 🚀 إرسال SMS تلقائي بنجاح ---`);
    console.log(`📍 المركز: ${centerName}`);
    console.log(`👤 الطالب: ${student.name}`);
    console.log(`📱 الهاتف: ${phone}`);
    console.log(`📝 النص: ${message.replace(/\n/g, " | ")}`);
    console.log(`📊 الإحصائيات: ${message.length} حرف | ${requiredParts} جزء`);
    console.log(`💳 الرصيد المتبقي: ${wallet.balance - requiredParts}`);
    console.log(`------------------------------------\n`);

    return { success: true, partsSent: requiredParts };
  } catch (error) {
    // التقاط أي خطأ غير متوقع ومنع السيرفر من الانهيار
    console.error(`[CRITICAL SMS ERROR]:`, error.stack);
    return { success: false, reason: "internal_server_error", error: error.message };
  }
}

// التأكد من إغلاق الاتصال بقاعدة البيانات عند توقف السيرفر
process.on("SIGINT", async () => { await prisma.$disconnect(); process.exit(0); });

module.exports = { sendAutoSms };
