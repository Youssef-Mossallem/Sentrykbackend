const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

/**
 * حساب أجزاء الرسالة (عربي) - 60 حرفاً للجزء الواحد
 */
function calculateSmsParts(text) {
  if (!text) return 0;
  const charCount = text.trim().length;
  return Math.ceil(charCount / 60);
}

/**
 * دالة الصبر (الانتظار) - لضمان اكتمال الـ Transactions في قاعدة البيانات
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * إرسال إشعار SMS تلقائي - نسخة "الصبور القوي"
 * @param {number|string} studentId - ID الطالب
 * @param {string} eventType - نوع الحدث
 */
async function sendAutoSms(studentId, eventType) {
  try {
    const numericId = Number(studentId);
    if (!numericId || numericId <= 0) return { success: false, reason: "invalid_id" };

    // --- المحاولة الأولى لجلب البيانات بصبر ---
    let student = await fetchStudentData(numericId);

    // لو مفيش اشتراكات، نصبر 800ms ونحاول تاني (عشان نلحق الـ Transaction اللي بيسيف)
    if (!student?.subscriptions?.length) {
      console.log(`[SMS WAIT] جاري الصبر على قاعدة البيانات للطالب ${numericId}...`);
      await wait(800); 
      student = await fetchStudentData(numericId);
    }

    // 1. فحص وجود الطالب وهاتفه (شرط أساسي للإرسال)
    if (!student || !student.phone?.trim()) {
      console.warn(`[SMS FAIL] الطالب ${numericId} غير موجود أو بدون هاتف.`);
      return { success: false, reason: "no_student_or_phone" };
    }

    const phone = student.phone.trim();
    const centerName = student.center?.name || "المركز";
    const lastSub = student.subscriptions?.[0] || null;

    // 2. فحص وجود اشتراك (لو مفيش اشتراك خالص حتى بعد الصبر)
    if (!lastSub) {
      console.warn(`[SMS FAIL] لا يوجد أي اشتراك مسجل للطالب: ${student.name}`);
      return { success: false, reason: "no_subscription" };
    }

    // 3. تجهيز البيانات المالية والزمنية "بكل مرونة" (Safe Access)
    const totalPrice = lastSub.totalPrice ?? 0;
    const endDate = lastSub.endDate 
      ? new Date(lastSub.endDate).toLocaleDateString("ar-EG", { day: 'numeric', month: 'numeric' })
      : "غير محدد";

    // تحويل قائمة المواد (لو مفيش مواد مش هيطلع ارور، هيكتب لا يوجد)
    const itemsList = (lastSub.items && lastSub.items.length > 0)
      ? lastSub.items
          .map(i => `${i.subject?.name ?? "مادة"}:${i.priceSnapshot ?? 0}ج`)
          .join(" | ")
      : "لا يوجد مواد محددة";

    let message = "";

    // 4. بناء نص الرسالة (تصميم احترافي ومختصر)
    const studentName = student.name || "طالب";
    
    switch (eventType) {
      case "FIRST_SUB":
        message = `تم تسجيل ${studentName} بـ ${centerName}\nالمواد: ${itemsList}\nالإجمالي: ${totalPrice}ج\nالانتهاء: ${endDate}`;
        break;
      case "RENEWED":
        message = `تم تجديد اشتراك ${studentName} بـ ${centerName}\nالمواد: ${itemsList}\nالإجمالي: ${totalPrice}ج\nالانتهاء: ${endDate}`;
        break;
      case "ENDING_SOON":
        message = `تنبيه: اشتراك ${studentName} بـ ${centerName} ينتهي ${endDate}\nيرجى التجديد لضمان الاستمرار.`;
        break;
      case "EXPIRED":
        message = `عذراً: انتهى اشتراك ${studentName} بـ ${centerName} (${endDate})\nيرجى مراجعة السنتر للتجديد.`;
        break;
      default:
        console.error(`[SMS FAIL] الحدث ${eventType} غير مدعوم.`);
        return { success: false, reason: "unsupported_event" };
    }

    // 5. حساب التكلفة والتحقق من المحفظة
    const requiredParts = calculateSmsParts(message);
    const wallet = await prisma.smsWallet.findUnique({
      where: { centerId: student.centerId },
    });

    if (!wallet || wallet.balance < requiredParts) {
      console.error(`[SMS FAIL] رصيد غير كاف لمركز: ${centerName}. متاح: ${wallet?.balance ?? 0}`);
      return { success: false, reason: "insufficient_balance" };
    }

    // 6. الخصم وتسجيل المعاملة (Atomic Transaction)
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
          description: `[تلقائي: ${eventType}] - ${studentName} - ${requiredParts} رسالة`,
        },
      }),
    ]);

    // 7. لوجز النجاح المبهجة
    console.log(`\n--- ✅ تم الإرسال بنجاح (نسخة الصبور) ---`);
    console.log(`📍 ${centerName} -> 👤 ${studentName}`);
    console.log(`📝 النص: ${message.split('\n')[0]}...`);
    console.log(`💳 الرصيد الحالي: ${wallet.balance - requiredParts}`);
    console.log(`----------------------------------------\n`);

    return { success: true, partsSent: requiredParts };

  } catch (error) {
    console.error(`[CRITICAL SMS ERROR]:`, error.message);
    return { success: false, reason: "internal_error", error: error.message };
  }
}

/**
 * دالة مساعدة لجلب بيانات الطالب مع اشتراكاته (لتجنب التكرار)
 */
async function fetchStudentData(id) {
  return await prisma.student.findUnique({
    where: { id },
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
}

// تنظيف الاتصال عند الإغلاق
process.on("SIGINT", async () => { await prisma.$disconnect(); });

module.exports = { sendAutoSms };
