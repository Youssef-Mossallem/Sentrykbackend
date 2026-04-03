// backend/cron/smsScheduler.js
const cron = require("node-cron");
const { PrismaClient } = require("@prisma/client");
const { sendAutoSms } = require("../utils/smsUtils");

const prisma = new PrismaClient();

/**
 * دالة الجدولة الأسطورية - تعمل يومياً الساعة 7 صباحاً بتوقيت السيرفر
 * لضمان الدقة، نستخدم توقيت مصر (Cairo Time)
 */
const startSmsScheduler = () => {
  // '0 7 * * *' تعني: دقيقة 0، ساعة 7، كل يوم، كل شهر، كل أسبوع
  cron.schedule("0 7 * * *", async () => {
    console.log("--------------------------------------------------");
    console.log(`⏰ [CRON START] بدأ فحص الاشتراكات: ${new Date().toLocaleString("ar-EG")}`);
    
    try {
      // 1. تحديد التواريخ المطلوبة (اليوم، وبعد 3 أيام)
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const threeDaysFromNow = new Date();
      threeDaysFromNow.setDate(today.getDate() + 3);
      threeDaysFromNow.setHours(0, 0, 0, 0);

      const endOfThreeDays = new Date(threeDaysFromNow);
      endOfThreeDays.setHours(23, 59, 59, 999);

      const endOfToday = new Date(today);
      endOfToday.setHours(23, 59, 59, 999);

      // --- المرحلة الأولى: تنبيه بقرب الانتهاء (بعد 3 أيام) ---
      const endingSoonSubs = await prisma.subscription.findMany({
        where: {
          endDate: {
            gte: threeDaysFromNow,
            lte: endOfThreeDays,
          },
          status: "ACTIVE", // نرسل فقط للنشطين حالياً
        },
        select: { studentId: true },
      });

      console.log(`🔍 [INFO] تم العثور على ${endingSoonSubs.length} اشتراك سينتهي بعد 3 أيام.`);
      
      for (const sub of endingSoonSubs) {
        // ننتظر قليلاً بين كل رسالة والأخرى لتجنب ضغط السيرفر
        await new Promise(resolve => setTimeout(resolve, 500)); 
        await sendAutoSms(sub.studentId, "ENDING_SOON");
      }

      // --- المرحلة الثانية: تنبيه بالانتهاء الفعلي (اليوم) ---
      const expiredTodaySubs = await prisma.subscription.findMany({
        where: {
          endDate: {
            gte: today,
            lte: endOfToday,
          },
          // هنا نرسل حتى لو الحالة بدأت تتغير لـ EXPIRED برمجياً
        },
        select: { studentId: true },
      });

      console.log(`🔍 [INFO] تم العثور على ${expiredTodaySubs.length} اشتراك ينتهي اليوم.`);

      for (const sub of expiredTodaySubs) {
        await new Promise(resolve => setTimeout(resolve, 500));
        await sendAutoSms(sub.studentId, "EXPIRED");
      }

      console.log(`✅ [CRON FINISHED] تم الانتهاء من إرسال إشعارات اليوم بنجاح.`);
      console.log("--------------------------------------------------");
    } catch (error) {
      console.error("❌ [CRON FATAL ERROR]:", error);
    }
  });

  console.log("🚀 [SMS SCHEDULER] المنبه الأسطوري يعمل الآن (كل يوم الساعة 7 صباحاً)");
};

module.exports = startSmsScheduler;