const cron = require("node-cron");
const { PrismaClient } = require("@prisma/client");

// 🚀 استدعاء الدالة الذكية الجديدة للواتساب المعتمدة على الـ Templates الرسمية لـ Meta
const { sendAutoWhatsApp } = require("../utils/whatsappUtils");

const prisma = new PrismaClient();

// مصفوفة مساعدة لأسماء الشهور العربية لتبدو الرسائل احترافية في الواتساب
const ARABIC_MONTHS = {
  1: "يناير", 2: "فبراير", 3: "مارس", 4: "أبريل", 5: "مايو", 6: "يونيو",
  7: "يوليو", 8: "أغسطس", 9: "سبتمبر", 10: "أكتوبر", 11: "نوفمبر", 12: "ديسمبر"
};

/**
 * دالة مساعدة لإرسال رسائل الواتساب داخل حلقة الـ Cron بأمان كامل
 * تضمن عدم انهيار الطابور المجدول في حالة حدوث خطأ لطالب واحد، وتدعم تمرير بيانات إضافية متغيرة للـ Meta API
 */
async function safeSchedulerWhatsApp(studentId, eventType, additionalData = null) {
  try {
    if (typeof sendAutoWhatsApp === "function") {
      const result = await sendAutoWhatsApp(studentId, eventType, additionalData);
      if (result && result.success) {
        console.log(`[Scheduler WhatsApp SUCCESS] ✅ تم إرسال الحدث [${eventType}] بنجاح للطالب رقم: ${studentId}`);
      } else {
        console.warn(`[Scheduler WhatsApp WARN] ⚠️ لم يتم الإرسال للطالب ${studentId}. السبب: ${result?.reason || "غير معروف"}`);
      }
    }
  } catch (error) {
    console.error(`❌ [Scheduler WhatsApp CRITICAL ERROR] فشل الإرسال للطالب ${studentId} في الحدث ${eventType}:`, error.message);
  }
}

/**
 * محرك التحليلات الشهري المؤتمت (Automated Monthly Analytics Engine)
 * يقوم باحتساب الإحصائيات الدقيقة للطالب وحفظها في الـ Log ثم إرسالها فوراً عبر الواتساب كتقرير أسطوري شامل
 */
async function generateAndSendAutomatedMonthlyReport(student, month, year) {
  try {
    const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

    // 1. جلب مجموعات الطالب الحقيقية والفعالية من اشتراكاته لضمان عدم احتسابه غائباً في مجموعات لا ينتمي إليها
    const studentSubscriptions = await prisma.subscription.findMany({
      where: {
        studentId: student.id,
        centerId: student.centerId,
      },
      include: {
        items: {
          select: { sessionId: true }
        }
      }
    });

    const sessionIds = [
      ...new Set(studentSubscriptions.flatMap(sub => sub.items.map(item => item.sessionId)))
    ];

    if (sessionIds.length === 0) {
      console.log(`ℹ️ [Monthly Report] الطالب ${student.name} ليس لديه اشتراكات مجموعات مسجلة للحساب التراكمي.`);
      return;
    }

    // 2. جلب النوافذ المقفلة (الحصص الفعلية التي تم أخذ الغياب فيها) المرتبطة بمجموعات الطالب المحددة فقط
    const windows = await prisma.sessionAttendanceWindow.findMany({
      where: {
        sessionId: { in: sessionIds },
        isClosed: true,
        date: { gte: start, lte: end },
      },
      orderBy: [{ date: "asc" }]
    });

    const windowIds = windows.map((w) => w.id);
    if (windowIds.length === 0) return; // لا توجد حصص فعلية أُغلقت في هذا الشهر لهذه المجموعات

    // 3. جلب سجل حضور الطالب الفعلي المرتبط بتلك النوافذ
    const attendances = await prisma.attendance.findMany({
      where: {
        studentId: student.id,
        centerId: student.centerId,
        windowId: { in: windowIds },
      },
      select: {
        windowId: true,
        status: true,
        lateMinutes: true,
      },
    });

    const attendanceMap = new Map(attendances.map((a) => [a.windowId, a]));

    let totalLateMinutes = 0;
    const details = windows.map((window) => {
      const attendance = attendanceMap.get(window.id);
      const status = attendance?.status || "ABSENT";
      if (status === "LATE") totalLateMinutes += (attendance?.lateMinutes || 0);
      return { status };
    });

    // 4. الحسابات الختامية الدقيقة للأرقام والنسب
    const totalExpectedSessions = windows.length;
    const totalPresent = details.filter((d) => d.status === "PRESENT").length;
    const totalLate = details.filter((d) => d.status === "LATE").length;
    const totalAbsent = details.filter((d) => d.status === "ABSENT").length;

    const totalAttendedCount = totalPresent + totalLate;
    const numericRate = totalExpectedSessions > 0 ? (totalAttendedCount / totalExpectedSessions) * 100 : 100;
    const attendanceRate = `${numericRate.toFixed(1)}%`;

    // 5. حساب الغياب المتتالي لرصد المخاطر الحرجة
    let consecutiveAbsentStreak = 0;
    for (let i = details.length - 1; i >= 0; i--) {
      if (details[i].status === "ABSENT") {
        consecutiveAbsentStreak++;
      } else {
        break;
      }
    }

    // 6. محرك التقييم الديناميكي لمستوى الطالب
    let evaluationText = "ممتاز ومثالي ⭐⭐⭐";
    if (numericRate < 50 || consecutiveAbsentStreak >= 3) {
      evaluationText = "حرج جداً! غياب متكرر ويحتاج لمتابعة فورية واستدعاء ولي أمر 🚨";
    } else if (numericRate < 75) {
      evaluationText = "ضعيف، الطالب يتغيب كثيراً ويؤثر على مستواه الدراسي ⚠️";
    } else if (numericRate < 90) {
      evaluationText = "جيد جداً، ملتزم بشكل عام مع بعض التقصير الطفيف 👍";
    }

    // 7. حفظ التقرير في قاعدة البيانات (Upsert) للتوثيق التاريخي والمالي بالخادم
    await prisma.monthlyReportLog.upsert({
      where: {
        studentId_month_year: { studentId: student.id, month, year },
      },
      update: {
        totalPresent,
        totalAbsent,
        totalLate,
        sentAt: new Date(),
        status: "UPDATED",
      },
      create: {
        studentId: student.id,
        centerId: student.centerId,
        month,
        year,
        totalPresent,
        totalAbsent,
        totalLate,
        status: "GENERATED",
      },
    });

    // 8. صياغة وتمرير المتغيرات المتسلسلة لـ Meta Cloud API لإرسال رسالة الواتساب الأسطورية
    const monthLabel = `${ARABIC_MONTHS[month] || month} ${year}`;
    
    await safeSchedulerWhatsApp(student.id, "MONTHLY_REPORT", {
      studentName: student.name,
      monthName: monthLabel,
      totalExpected: String(totalExpectedSessions),
      present: String(totalPresent),
      absent: String(totalAbsent),
      late: String(totalLate),
      rate: attendanceRate,
      evaluation: evaluationText,
      streakAbsent: String(consecutiveAbsentStreak),
      totalLateMin: String(totalLateMinutes)
    });

  } catch (error) {
    console.error(`❌ [Monthly Engine Student Error] حصل خطأ أثناء احتساب تقرير الطالب ${student.id}:`, error.message);
  }
}

/**
 * دالة الجدولة الأسطورية المحدثة بالكامل للواتساب
 * تحتوي على منبهين دوريين مقفلين هندسياً بتوقيت القاهرة
 */
const startWhatsAppScheduler = () => {
  
  // ====================================================================
  // ⏰ الـ Cron الأول: فحص تجديد الاشتراكات اليومي (كل يوم الساعة 7 صباحاً بتوقيت مصر)
  // ====================================================================
  cron.schedule("0 7 * * *", async () => {
    console.log("--------------------------------------------------");
    console.log(`⏰ [CRON START - DAILY SUBS] بدأ فحص الاشتراكات الدوري لإرسال تنبيهات الواتساب: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`);
    
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const endOfToday = new Date(today);
      endOfToday.setHours(23, 59, 59, 999);

      // حساب تاريخ التنبيه المبكر (بعد 3 أيام)
      const threeDaysFromNow = new Date();
      threeDaysFromNow.setDate(today.getDate() + 3);
      threeDaysFromNow.setHours(0, 0, 0, 0);

      const endOfThreeDays = new Date(threeDaysFromNow);
      endOfThreeDays.setHours(23, 59, 59, 999);

      // ----------------------------------------------------------------
      // 🔥 المرحلة الأولى: تنبيه بقرب الانتهاء (باقي 3 أيام على انتهاء الاشتراك)
      // ----------------------------------------------------------------
      const endingSoonSubs = await prisma.subscription.findMany({
        where: {
          endDate: { gte: threeDaysFromNow, lte: endOfThreeDays },
          status: "ACTIVE",
        },
        select: { studentId: true },
      });

      console.log(`🔍 [INFO] تم العثور على (${endingSoonSubs.length}) اشتراك سينتهي بعد 3 أيام وجاري تنبيه أولياء الأمور...`);
      for (const sub of endingSoonSubs) {
        await new Promise(resolve => setTimeout(resolve, 500)); // حماية الـ Rate Limit للـ API الخاص بفيسبوك
        await safeSchedulerWhatsApp(sub.studentId, "ENDING_SOON");
      }

      // ----------------------------------------------------------------
      // 🔥 المرحلة الثانية: تنبيه بالانتهاء الفعلي والغلق (الاشتراكات التي تنتهي اليوم)
      // ----------------------------------------------------------------
      const expiredTodaySubs = await prisma.subscription.findMany({
        where: {
          endDate: { gte: today, lte: endOfToday },
          status: "ACTIVE",
        },
        select: { id: true, studentId: true },
      });

      console.log(`🧨 [INFO] تم العثور على (${expiredTodaySubs.length}) اشتراك ينتهي اليوم وغلق الصلاحيات وإرسال التنبيهات...`);

      if (expiredTodaySubs.length > 0) {
        const expiredIds = expiredTodaySubs.map(sub => sub.id);

        // غلق الصلاحيات في قاعدة البيانات فوراً لمنع دخول بوابات السنتر وعمل Scan للـ QR
        await prisma.subscription.updateMany({
          where: { id: { in: expiredIds } },
          data: { status: "EXPIRED" }
        });
        
        console.log(`✅ [DB UPDATE] تم تحويل حالة عدد (${expiredIds.length}) اشتراكات بنجاح إلى EXPIRED.`);

        for (const sub of expiredTodaySubs) {
          await new Promise(resolve => setTimeout(resolve, 500));
          await safeSchedulerWhatsApp(sub.studentId, "EXPIRED");
        }
      }

      console.log(`✅ [CRON FINISHED - DAILY SUBS] تم الانتهاء من دورة فحص الاشتراكات لليوم بنجاح.`);
      console.log("--------------------------------------------------");
    } catch (error) {
      console.error("❌ [CRON FATAL ERROR - DAILY SUBS]: حصل خطأ فادح في نظام جدولة الاشتراكات اليومي:", error);
    }
  }, {
    scheduled: true,
    timezone: "Africa/Cairo"
  });

  // ====================================================================
  // ⏰ الـ Cron الثاني: محرك إرسال التقارير الشهرية التلقائي (أول يوم في كل شهر الساعة 9 صباحاً بتوقيت مصر)
  // ====================================================================
  cron.schedule("0 9 1 * *", async () => {
    console.log("--------------------------------------------------");
    console.log(`📊 [CRON START - MONTHLY REPORTS] بدأ محرك التحليلات الشهري لإرسال التقارير التراكمية تلقائياً لأولياء الأمور...`);
    
    try {
      // احتساب الشهر والسنة المستهدفين (الشهر الفائت الذي انتهى للتو)
      const now = new Date();
      let targetMonth = now.getMonth(); 
      let targetYear = now.getFullYear();
      
      // لو احنا في شهر 1 (يناير)، التقرير المحسوب سيكون لشهر 12 (ديسمبر) للسنة الماضية
      if (targetMonth === 0) {
        targetMonth = 12;
        targetYear = targetYear - 1;
      }

      console.log(`📅 [INFO] جاري توليد تقارير شهر: ${targetMonth} لعام: ${targetYear}...`);

      // جلب جميع الطلاب المسجلين بالسيستم للبدء بإنتاج تقاريرهم التراكمية
      const students = await prisma.student.findMany({
        select: {
          id: true,
          name: true,
          phone: true,
          stage: true,
          grade: true,
          centerId: true,
        },
      });

      console.log(`👥 [INFO] تم العثور على (${students.length}) طالب، سيتم فحصهم وتوليد تقاريرهم تتابعاً هندسياً...`);

      for (const student of students) {
        // تأخير بسيط 600ms لمنع الضغط العالي (Spike Load) على المعالج، قاعدة البيانات، وتفادي الـ Rate Limit للواتساب
        await new Promise(resolve => setTimeout(resolve, 600));
        await generateAndSendAutomatedMonthlyReport(student, targetMonth, targetYear);
      }

      console.log(`✅ [CRON FINISHED - MONTHLY REPORTS] تم إنتاج وإرسال كافة التقارير الشهرية التلقائية بنجاح تام 🚀.`);
      console.log("--------------------------------------------------");
    } catch (error) {
      console.error("❌ [CRON FATAL ERROR - MONTHLY REPORTS]: فشل نظام احتساب التقارير الشهرية الأوتوماتيكي:", error);
    }
  }, {
    scheduled: true,
    timezone: "Africa/Cairo"
  });

  console.log("🚀 [WHATSAPP SCHEDULER ACTIVE] تم تشغيل الجدولة المزدوجة الأسطورية (فحص اشتراكات يومي 7ص / تقارير شهرية مؤتمتة أول كل شهر 9ص بتوقيت القاهرة).");
};

module.exports = startWhatsAppScheduler;