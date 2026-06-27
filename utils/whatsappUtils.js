const axios = require("axios");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// جلب الإعدادات والتحقق من الحالات الأساسية من البيئة
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED === "true";

/**
 * دالة مساعدة ذكية لاختصار رابط Cloudinary الطويل عبر TinyURL لجعل الرسالة بريميوم وشيك
 * تم تأمينها بالكامل بـ Timeout لضمان عدم تأخير أو إيقاف استجابة السيرفر
 */
async function shortenUrlWithTinyURL(longUrl) {
  if (!longUrl || !String(longUrl).startsWith("http")) return longUrl || "";
  try {
    const response = await axios.get(
      `https://tinyurl.com/api-create?url=${encodeURIComponent(longUrl)}`,
      { timeout: 3500 }
    );
    if (response.data && typeof response.data === "string" && response.data.startsWith("http")) {
      return response.data.trim();
    }
  } catch (error) {
    console.error("⚠️ [TinyURL Automation Warning]: فشل اختصار الرابط، سيتم إرسال الرابط الأصلي لتفادي تعطيل الرسالة:", error.message);
  }
  return longUrl;
}

/**
 * دالة منخفضة المستوى لإرسال الطلب الفعلي لـ Meta Cloud API
 */
async function sendMetaWhatsAppRequest(toPhone, templateName, bodyComponents = []) {
  try {
    const parameters = bodyComponents.map(val => ({
      type: "text",
      text: String(val).trim()
    }));

    const payload = {
      messaging_product: "whatsapp",
      to: toPhone,
      type: "template",
      template: {
        name: templateName,
        language: { code: "ar" }, // مطابقة لغة القوالب المعتمدة في فيسبوك بالكامل
        components: [
          {
            type: "body",
            parameters: parameters
          }
        ]
      }
    };

    const url = `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`;

    const response = await axios.post(url, payload, {
      headers: {
        "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    return { success: true, metaResponse: response.data };
  } catch (error) {
    console.error("❌ [META API ERROR]: REJECTED BY FACEBOOK SERVERS:", error.response?.data || error.message);
    return { success: false, error: error.response?.data || error.message };
  }
}

/**
 * الدالة الذكية والمطورة لإرسال إشعارات واتساب البريميوم لـ "سَنْتـرِك"
 * @param {number|string} studentId - معرف الطالب في قاعدة البيانات
 * @param {string} eventType - نوع الحدث المدعوم بالنظام (FIRST_SUB, ENDING_SOON, EXPIRED, ABSENT, MONTHLY_REPORT)
 * @param {object} extraData - الملحقات الخارجية وسجلات تقارير الطلاب
 */
async function sendAutoWhatsApp(studentId, eventType, extraData = {}) {
  try {
    if (!WHATSAPP_ENABLED) {
      console.warn("[AUTO WHATSAPP] تنبيه: نظام إرسال رسائل الواتساب معطل حالياً من إعدادات الـ .env");
      return { success: false, reason: "whatsapp_disabled" };
    }

    const numericId = Number(studentId);
    if (isNaN(numericId) || numericId <= 0) {
      console.warn(`[AUTO WHATSAPP] معرف الطالب الممرر غير صالح برمجياً: ${studentId}`);
      return { success: false, reason: "invalid_student_id" };
    }

    // استعلام فائق الكفاءة لجلب سجل الطالب، الحصص والمدرسين والقاعات المرتبطة به بضربة واحدة[cite: 12]
    const student = await prisma.student.findUnique({
      where: { id: numericId },
      include: {
        center: { select: { name: true, id: true } }, // ربط السنتر الفعلي للطالب
        subscriptions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: {
            items: {
              include: {
                session: {
                  include: {
                    teacher: { select: { name: true, subject: true } },
                    room: { select: { name: true } }
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!student || !student.phone?.trim()) {
      console.warn(`[AUTO WHATSAPP] لم يتم العثور على الطالب أو رقم الهاتف فارغ لـ ID: ${numericId}`);
      return { success: false, reason: "no_phone" };
    }

    // 📱 تهيئة وتأمين الصيغة الدولية لرقم الهاتف المتوافقة مع ميتا (تحويل 010 إلى 2010 تلقائياً)[cite: 12]
    let rawPhone = student.phone.trim();
    if (rawPhone.startsWith("+")) rawPhone = rawPhone.substring(1);
    if (rawPhone.startsWith("0")) rawPhone = rawPhone.substring(1);
    if (!rawPhone.startsWith("20")) rawPhone = `20${rawPhone}`;

    const centerName = student.center?.name || "التميز التعليمي";
    const studentName = student.name.trim();
    const lastSub = student.subscriptions[0];

    // تهيئة المتغيرات الأساسية للحصص المالية
    let sessionsListText = "لا يوجد مجموعات مسجلة حالياً";
    let totalPriceStr = "0";
    let endDateStr = "غير محدد";

    if (lastSub) {
      totalPriceStr = String(lastSub.totalPrice || 0);
      
      if (lastSub.endDate) {
        const d = new Date(lastSub.endDate);
        endDateStr = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
      }

      // بناء وتجميع تفاصيل الحصص (الاسم، المدرس، المادة، القاعة، السعر، التوقيت) أفقياً[cite: 12]
      if (lastSub.items && lastSub.items.length > 0) {
        sessionsListText = lastSub.items.map((item, index) => {
          const sName = item.session?.name || "حصة عامة";
          const tName = item.session?.teacher?.name || "مدرس المادة";
          const subject = item.session?.teacher?.subject || "مادة علمية";
          const roomName = item.session?.room?.name || "القاعة الرئيسية";
          const price = item.priceSnapshot || 0;
          const sTime = item.session?.time || item.session?.startTime || "يحدد لاحقاً";
          
          return `(${index + 1}) مجموعة ${sName} [مادة: ${subject} - مستر/مس: ${tName}] قاعة: ${roomName} الساعة: ${sTime} بسعر: ${price}ج`.trim();
        }).join(" ❖ "); // 🌟 الفصل بالرمز البريميوم لضمان عدم وجود أسطر جديدة تسبب رفض خوادم فيسبوك[cite: 12]
      }
    }

    let templateName = "";
    let templateVariables = [];

    // 🎯 فرز البيانات وتوزيعها بدقة ميكروسكوبية حسب ترتيب متغيرات القوالب المعتمدة
    switch (eventType) {
      case "FIRST_SUB":
        templateName = "sentryk_first_subscription";
        
        // جلب الرابط من الملحقات واختصاره بشكل فوري وآمن
        const longQrUrl = extraData.qrImageUrl || "";
        const shortQrUrl = await shortenUrlWithTinyURL(longQrUrl);

        // الترتيب: {{1}} الطالب، {{2}} السنتر، {{3}} الحصص والمجموعات، {{4}} الإجمالي، {{5}} انتهاء الصلاحية، {{6}} الرابط
        templateVariables = [
          studentName, 
          centerName, 
          sessionsListText, 
          totalPriceStr, 
          endDateStr, 
          shortQrUrl || "سيتم تسليم الكارت المطبوع بالسنتر"
        ];
        break;

      case "ENDING_SOON":
        templateName = "subscription_expiry_reminder";
        // الترتيب: {{1}} الطالب، {{2}} السنتر، {{3}} تفاصيل الحصص، {{4}} الإجمالي، {{5}} تاريخ الانتهاء الحالي
        templateVariables = [
          studentName, 
          centerName, 
          sessionsListText, 
          totalPriceStr, 
          endDateStr
        ];
        break;

      case "EXPIRED":
        templateName = "subscription_expired_notice";
        // الترتيب: {{1}} الطالب، {{2}} السنتر، {{3}} التفاصيل المسجلة مسبقاً، {{4}} إجمالي التجديد المطلوب
        templateVariables = [
          studentName, 
          centerName, 
          sessionsListText, 
          totalPriceStr
        ];
        break;

      case "ABSENT":
        templateName = "student_absence_notice";
        
        let absenceSessionDetails = "الحصة المقررة لليوم";
        if (extraData.sessionName) {
          const sSub = extraData.subjectName || "المادة";
          const sTech = extraData.teacherName || "المدرس";
          absenceSessionDetails = `مجموعة ${extraData.sessionName} [مادة: ${sSub} - مستر/مس: ${sTech}]`;
        }

        // الترتيب: {{1}} الطالب، {{2}} السنتر، {{3}} تفاصيل الحصة الغائب عنها
        templateVariables = [
          studentName, 
          centerName, 
          absenceSessionDetails
        ];
        break;

      case "MONTHLY_REPORT":
        templateName = "student_monthly_academic_report_2";

        // 1. معالجة وتجميع حصص الحضور المنتظم أفقياً بدون أسطر جديدة[cite: 12]
        let regularLogsText = "لا يوجد سجل حضور منتظم موثق لهذا الشهر";
        const regularLogsArr = Array.isArray(extraData.presentLogs) 
          ? extraData.presentLogs.filter(log => !log.isLate && log.status !== "LATE") 
          : [];

        if (regularLogsArr.length > 0) {
          regularLogsText = regularLogsArr.map((log, i) => {
            const dateStr = log.scannedAt ? new Date(log.scannedAt).toLocaleDateString("ar-EG", { month: "numeric", day: "numeric", timeZone: "Africa/Cairo" }) : "";
            return `(${i + 1}) مجموعة ${log.sessionName} [${log.teacherName || "المدرس"}] بتاريخ ${dateStr}`.trim();
          }).join(" ❖ ");
        }

        // 2. معالجة وتجميع حصص الحضور المتأخر مع إبراز ساعة الدخول الفعلية أفقياً[cite: 12]
        let lateLogsText = "لا يوجد سجل حضور متأخر بحمد الله لهذا الشهر";
        const lateLogsArr = Array.isArray(extraData.presentLogs) 
          ? extraData.presentLogs.filter(log => log.isLate || log.status === "LATE")
          : [];

        if (lateLogsArr.length > 0) {
          lateLogsText = lateLogsArr.map((log, i) => {
            const actualTime = log.scannedAt ? new Date(log.scannedAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" }) : "غير محدد";
            const scheduledTime = log.scheduledTime || log.sessionTime || "الموعد الرسمي";
            return `(${i + 1}) مجموعة ${log.sessionName} [الموعد: ${scheduledTime} - الدخول الفعلي: ${actualTime}]`.trim();
          }).join(" ❖ ");
        }

        // 3. معالجة وتجميع حصص الغياب الكامل أفقياً[cite: 12]
        let absentLogsText = "لا يوجد سجل غياب موثق بحمد الله لهذا الشهر";
        if (Array.isArray(extraData.absentLogs) && extraData.absentLogs.length > 0) {
          absentLogsText = extraData.absentLogs.map((log, i) => {
            const dateStr = log.date ? new Date(log.date).toLocaleDateString("ar-EG", { month: "numeric", day: "numeric", timeZone: "Africa/Cairo" }) : "";
            return `(${i + 1}) مجموعة ${log.sessionName} [${log.teacherName || "المدرس"}] بتاريخ ${dateStr}`.trim();
          }).join(" ❖ ");
        }

        // الترتيب: {{1}} الطالب، {{2}} السنتر، {{3}} حضور منتظم، {{4}} حضور متأخر، {{5}} غياب كامل
        templateVariables = [
          studentName,
          centerName,
          regularLogsText,
          lateLogsText,
          absentLogsText
        ];
        break;

      default:
        console.warn(`[AUTO WHATSAPP] نوع الحدث الممرر غير معرف بالمنظومة: ${eventType}`);
        return { success: false, reason: "invalid_event_type" };
    }

    // 🔒 التحقق الآمن من محفظة الواتساب للسنتر لمنع العمليات غير المصرح بها[cite: 12]
    const wallet = await prisma.whatsAppWallet.findUnique({
      where: { centerId: student.centerId }
    });

    if (!wallet || wallet.balance < 1) {
      console.warn(`[AUTO WHATSAPP] رصيد المحفظة غير كافٍ للسنتر ${student.centerId}. الرصيد الحالي: ${wallet?.balance || 0}`);
      return { success: false, reason: "insufficient_balance" };
    }

    // 🚀 تنفيذ الإرسال الفعلي إلى Meta API[cite: 12]
    const apiResult = await sendMetaWhatsAppRequest(rawPhone, templateName, templateVariables);

    if (!apiResult.success) {
      return { success: false, reason: "meta_api_failed", details: apiResult.error };
    }

    // 💵 خصم رصيد المعاملة وتوثيقها بشكل تزامني آمن داخل قاعدة البيانات[cite: 12]
    await prisma.$transaction([
      prisma.whatsAppWallet.update({
        where: { centerId: student.centerId },
        data: { balance: { decrement: 1 } }
      }),
      prisma.whatsAppTransaction.create({
        data: {
          walletId: wallet.id,
          amount: -1,
          type: "SEND",
          description: `[${eventType}]-طالب:${studentName.substring(0, 15)}-قالب:${templateName}`
        }
      })
    ]);

    console.log(`[WHATSAPP SUCCESS] ✅ تم إرسال القالب الرصين [${templateName}] بنجاح ورشاقة للرقم: ${rawPhone}`);
    return { success: true, messageId: apiResult.metaResponse?.messages?.[0]?.id };

  } catch (error) {
    console.error(`[AUTO WHATSAPP CRITICAL MODULE ERROR]:`, error.message);
    return { success: false, reason: "internal_error", message: error.message };
  }
}

// تنظيف وحماية اتصالات قاعدة البيانات عند إيقاف تشغيل الخادم
process.on("SIGTERM", async () => await prisma.$disconnect());
process.on("SIGINT", async () => await prisma.$disconnect());

module.exports = { sendAutoWhatsApp };