const express = require("express");
const { PrismaClient } = require("@prisma/client");

const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
} = require("../middleware/auth");
const { sendAutoWhatsApp } = require("../utils/whatsappUtils");

const router = express.Router();
const prisma = new PrismaClient();

const LATE_AFTER_MINUTES = 10; // الحساب الذكي للتأخير بعد كم دقيقة

// =============================================
// مساعدات الوقت والتاريخ بتوقيت القاهرة (Helpers)
// =============================================

const TIMEZONE = "Africa/Cairo";
const SCAN_BEFORE_MINUTES = 15; // تظهر الحصة قبل موعدها بـ 15 دقيقة
const LIVE_WINDOW_MAX_LATE = 30; // تختفي الحصة تلقائياً بعد 30 دقيقة من بدايتها

/**
 * دالة مساعدة لتهيئة وتوحيد حالة الحضور (تصلح البج المخفي في الملف القديم)
 */
function normalizeAttendanceStatus(status) {
  if (!status || typeof status !== "string") return "PRESENT";
  const upper = status.toUpperCase();
  if (["PRESENT", "LATE", "ABSENT"].includes(upper)) return upper;
  return "PRESENT";
}

function formatCairoDateLabel(date = new Date()) {
  try {
    return new Intl.DateTimeFormat("ar-EG", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function formatCairoDateTimeLabel(date = new Date()) {
  try {
    return new Intl.DateTimeFormat("ar-EG", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h12",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function getCairoParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: String(parts.weekday || "").toUpperCase(),
  };
}

function getCairoDayName(date = new Date()) {
  return getCairoParts(date).weekday;
}

function getCairoDateKey(date = new Date()) {
  const { year, month, day } = getCairoParts(date);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

function timeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return 0;
  const [hours, minutes] = timeStr.split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function minutesToTime(minutes) {
  if (typeof minutes !== "number" || isNaN(minutes)) return "00:00";
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function sortSessionsByTime(sessions) {
  if (!Array.isArray(sessions)) return [];
  return [...sessions].sort((a, b) => {
    const diff = timeToMinutes(a.startTime) - timeToMinutes(b.startTime);
    if (diff !== 0) return diff;
    return timeToMinutes(a.endTime) - timeToMinutes(b.endTime);
  });
}

function getLateMinutes(session, nowMinutes) {
  const startMin = timeToMinutes(session?.startTime);
  if (!startMin || Number.isNaN(startMin)) return 0;
  return Math.max(0, nowMinutes - startMin);
}

function isWithinScanOpenWindow(session, nowMinutes) {
  if (!session || !session.startTime || !session.endTime) return false;
  const startMin = timeToMinutes(session.startTime);
  const endMin = timeToMinutes(session.endTime);
  return nowMinutes >= startMin - SCAN_BEFORE_MINUTES && nowMinutes <= endMin;
}

function isWithinLiveWindow(session, nowMinutes, isOpen) {
  if (!session || !session.startTime) return false;
  const startMin = timeToMinutes(session.startTime);
  const isAfterBufferStart = nowMinutes >= startMin - SCAN_BEFORE_MINUTES;
  const isBeforeCutoff = nowMinutes <= startMin + LIVE_WINDOW_MAX_LATE;
  return (isAfterBufferStart && isBeforeCutoff) || isOpen;
}

async function getTodaysSessions(tx, centerId, dayName) {
  return tx.session.findMany({
    where: {
      room: { centerId },
      days: { has: dayName },
    },
    include: {
      teacher: { select: { id: true, name: true, subject: true } },
      room: { select: { id: true, name: true, maxStudents: true } },
    },
    orderBy: [{ startTime: "asc" }, { endTime: "asc" }, { id: "asc" }],
  });
}

async function getWindowBySessionAndDate(tx, sessionId, dateKey) {
  return tx.sessionAttendanceWindow.findUnique({
    where: {
      sessionId_date: {
        sessionId,
        date: dateKey,
      },
    },
  });
}

// =============================================
// غلاف الإرسال الآمن للواتساب لحماية السيرفر من الانهيار
// =============================================
async function safeSendWhatsApp(studentId, type, payload = {}) {
  try {
    if (typeof sendAutoWhatsApp === "function") {
      await sendAutoWhatsApp(studentId, type, payload);
    }
  } catch (error) {
    console.error("❌ [WHATSAPP ROUTING ERROR]:", error.message);
  }
}

/**
 * دالة تفكيك وتحديد الحصص المستهدفة بالمسح - مطورة بالكامل لتدعم البحث المتعدد بالتوازي
 */
async function resolveScanTarget(
  tx,
  { centerId, dayName, nowMinutes, sessionId, sessionIds },
) {
  const todaySessions = sortSessionsByTime(
    await getTodaysSessions(tx, centerId, dayName),
  );

  // 1. إذا تم إرسال مصفوفة معرفات صريحة من الفرونت إند
  if (Array.isArray(sessionIds) && sessionIds.length > 0) {
    const ids = sessionIds.map(Number).filter(Number.isInteger);
    const selected = todaySessions.filter((s) => ids.includes(s.id));
    if (selected.length === 0) {
      const err = new Error(
        "لا توجد حصص صالحة أو مطابقة للمعرفات المرسلة اليوم",
      );
      err.statusCode = 400;
      throw err;
    }
    return sortSessionsByTime(selected);
  }

  // 2. إذا تم إرسال معرّف حصة واحدة صريحة
  if (sessionId !== undefined && sessionId !== null) {
    const target = todaySessions.find((s) => s.id === Number(sessionId));
    if (!target) {
      const err = new Error(
        "الحصة المحددة غير موجودة أو لا تنتمي لجدول السنتر اليوم",
      );
      err.statusCode = 404;
      throw err;
    }
    return [target];
  }

  // 3. التوجيه الآلي الذكي الشامل (الوضع الافتراضي للاسكانر المفتوح للسنتر بالكامل):
  // يبحث أولاً عن جميع الحصص التي تمتلك "نافذة تحضير مفتوحة حالياً ولم تُغلق بعد" داخل السنتر
  const dateKey = getCairoDateKey(new Date());
  const openWindows = await tx.sessionAttendanceWindow.findMany({
    where: {
      date: dateKey,
      isClosed: false,
      session: { room: { centerId } },
    },
    select: { sessionId: true },
  });

  const openSessionIds = openWindows.map((w) => w.sessionId);
  let eligible = todaySessions.filter((s) => openSessionIds.includes(s.id));

  // إذا لم تكن هناك نوافذ مفتوحة يدوياً بعد، نعتمد على النطاق الزمني للحصص المتاحة تلقائياً في هذا الوقت
  if (eligible.length === 0) {
    eligible = todaySessions.filter((session) =>
      isWithinScanOpenWindow(session, nowMinutes),
    );
  }

  if (eligible.length === 0) {
    const err = new Error(
      "لا توجد أي حصة مفتوحة أو متاحة للاستقبال حالياً في هذا التوقيت",
    );
    err.statusCode = 400;
    throw err;
  }

  return eligible; // إرجاع كافة الحصص المؤهلة ليقوم نظام فلترة الاشتراكات بتوجيه الطالب لمجموعته الصحيحة
}

// ==========================================================
// نظام الترحيل والتحويل المتوازي الذكي الخارق للحصص المتتالية
// ==========================================================
async function carryForwardFromPreviousSession(
  tx,
  centerId,
  currentSession,
  currentWindow,
  dateKey,
  now,
) {
  const dayName = getCairoDayName(now);
  const allTodaySessions = sortSessionsByTime(
    await getTodaysSessions(tx, centerId, dayName),
  );

  const currentStart = timeToMinutes(currentSession.startTime);

  // 🌟 ذكاء خارق: جلب كاااافة الحصص السابقة المتوازية التي انتهت قبل بداية الحصة الحالية بـ 0 إلى 30 دقيقة
  const previousSessions = allTodaySessions.filter((s) => {
    const prevEnd = timeToMinutes(s.endTime);
    const gap = currentStart - prevEnd;
    return gap >= 0 && gap <= 30 && s.id !== currentSession.id;
  });

  if (previousSessions.length === 0) {
    return { carriedCount: 0, fromSessions: [] };
  }

  const previousSessionIds = previousSessions.map((s) => s.id);

  // جلب نوافذ التحضير الخاصة بكافة تلك الحصص السابقة لليوم الحالي
  const previousWindows = await tx.sessionAttendanceWindow.findMany({
    where: {
      sessionId: { in: previousSessionIds },
      date: dateKey,
    },
    select: { id: true },
  });

  if (previousWindows.length === 0) {
    return { carriedCount: 0, fromSessions: [] };
  }

  const previousWindowIds = previousWindows.map((w) => w.id);

  // جلب الطلاب الذين سجلوا حضور (سواء طبيعي أو متأخر) في أي من تلك الحصص المفتوحة سابقاً بالتوازي
  const previousAttendances = await tx.attendance.findMany({
    where: {
      windowId: { in: previousWindowIds },
      status: { in: ["PRESENT", "LATE"] },
    },
    select: { studentId: true },
  });

  if (previousAttendances.length === 0) {
    return {
      carriedCount: 0,
      fromSessions: previousSessions.map((s) => ({ id: s.id, name: s.name })),
    };
  }

  // إزالة التكرار من مصفوفة معرّفات الطلاب لضمان أداء عالي وسرعة المعالجة
  const uniquePreviousStudentIds = [
    ...new Set(previousAttendances.map((a) => a.studentId)),
  ];

  // 🌟 الفلترة المعمارية الصارمة: فحص من من هؤلاء الطلاب يمتلك اشتراكاً نشطاً يربطه بالحصة الحالية التي تُفتح الآن
  const validSubscriptions = await tx.student.findMany({
    where: {
      id: { in: uniquePreviousStudentIds },
      centerId,
      subscriptions: {
        some: {
          status: "ACTIVE",
          endDate: { gte: now },
          items: {
            some: { sessionId: currentSession.id },
          },
        },
      },
    },
    select: { id: true },
  });

  const allowedStudentIdsSet = new Set(validSubscriptions.map((s) => s.id));

  // جلب الطلاب المسجلين بالفعل في الحصة الحالية لمنع التكرار التام وتضارب مفاتيح البيانات
  const currentAttendance = await tx.attendance.findMany({
    where: { windowId: currentWindow.id },
    select: { studentId: true },
  });
  const currentAttendanceSet = new Set(
    currentAttendance.map((a) => a.studentId),
  );

  // تجهيز السجلات الجديدة للحقن التلقائي المباشر بقاعدة البيانات
  const rowsToCreate = uniquePreviousStudentIds
    .filter(
      (studentId) =>
        !currentAttendanceSet.has(studentId) &&
        allowedStudentIdsSet.has(studentId),
    )
    .map((studentId) => ({
      studentId: studentId,
      sessionId: currentSession.id,
      windowId: currentWindow.id,
      centerId,
      status: "PRESENT",
      scannedAt: now,
      markedAt: now,
      autoMarked: true,
      markedBySystem: true,
      lateMinutes: 0,
    }));

  if (rowsToCreate.length > 0) {
    await tx.attendance.createMany({
      data: rowsToCreate,
      skipDuplicates: true,
    });
  }

  return {
    carriedCount: rowsToCreate.length,
    fromSessions: previousSessions.map((s) => ({ id: s.id, name: s.name })),
  };
}

// =============================================
// المسارات والعمليات (Routes)
// =============================================

// 1️⃣ GET /live-sessions - جلب الحصص النشطة والمتاحة للاستقبال الآن
router.get(
  "/live-sessions",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId } = req.user;
      const now = new Date();

      const { year, month, day, hour, minute, weekday } = getCairoParts(now);
      const nowMinutes = hour * 60 + minute;
      const dateKey = getCairoDateKey(now);

      const formattedDateString = `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${year}`;
      const rawSessions = await getTodaysSessions(prisma, centerId, weekday);

      if (!rawSessions || rawSessions.length === 0) {
        return res.json({
          success: true,
          date: formattedDateString,
          day: weekday,
          count: 0,
          sessions: [],
        });
      }

      const sessions = sortSessionsByTime(rawSessions);
      const sessionIds = sessions.map((s) => s.id);

      const windows = await prisma.sessionAttendanceWindow.findMany({
        where: {
          sessionId: { in: sessionIds },
          date: dateKey,
        },
      });

      const windowMap = new Map(windows.map((w) => [w.sessionId, w]));

      const live = sessions
        .map((session) => {
          const startMin = timeToMinutes(session.startTime);
          const window = windowMap.get(session.id);

          if (window && window.isClosed) return null;

          const isOpen = !!window && !window.isClosed;
          const isVisible = isWithinLiveWindow(session, nowMinutes, isOpen);

          if (!isVisible) return null;

          return {
            id: session.id,
            name: session.name,
            startTime: session.startTime,
            endTime: session.endTime,
            stage: session.stage,
            grade: session.grade,
            maxStudents: session.maxStudents,
            roomMaxStudents: session.room?.maxStudents || 60,
            teacherName: session.teacher?.name || "غير محدد",
            subject: session.teacher?.subject || "",
            roomName: session.room?.name || "غير محدد",
            isOpen,
            windowId: window?.id || null,
            scanWindowStart: minutesToTime(
              Math.max(0, startMin - SCAN_BEFORE_MINUTES),
            ),
            scanWindowEnd: minutesToTime(startMin + LIVE_WINDOW_MAX_LATE),
          };
        })
        .filter(Boolean);

      return res.json({
        success: true,
        date: formattedDateString,
        day: weekday,
        count: live.length,
        sessions: live,
      });
    } catch (error) {
      console.error("❌ live-sessions critical engine error:", error);
      return res.status(500).json({
        success: false,
        error: "فشل جلب الحصص النشطة بسبب خطأ في احتساب خطوط الوقت",
      });
    }
  },
);

// 2️⃣ POST /open-sessions - فتح نافذة تحضير لعدة حصص بالتوازي (جديد كلياً وتلبي طلبك بالكامل وبقوة)
router.post(
  "/open-session/:sessionId",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId, userId } = req.user;
      const sessionId = Number(req.params.sessionId);
      const now = new Date();

      if (!sessionId || isNaN(new Date(sessionId).getTime())) {
        return res.status(400).json({
          success: false,
          error: "معرف الحصة الممرر غير صالح برمجياً",
        });
      }

      const { weekday, hour, minute } = getCairoParts(now);
      const nowMinutes = hour * 60 + minute;
      const dateKey = getCairoDateKey(now);

      // جلب الحصة والتحقق الصارم من ملكيتها للمركز الحالي حمايةً للبيانات
      const session = await prisma.session.findFirst({
        where: { id: sessionId, room: { centerId } },
        include: {
          teacher: { select: { id: true, name: true, subject: true } },
          room: { select: { id: true, name: true } },
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: "الحصة الدراسية المطلوبة غير موجودة بالمنظومة أو لا تنتمي لمركزك الحالي",
        });
      }

      // التحقق من الجدولة الزمنية لليوم الحالي
      if (!session.days.includes(weekday)) {
        return res.status(400).json({
          success: false,
          error: `هذه الحصة ليست مجدولة لليوم الحالي (${weekday})`,
        });
      }

      const startMin = timeToMinutes(session.startTime);
      const endMin = timeToMinutes(session.endTime);

      // قيود وقت الفتح الصارمة
      if (nowMinutes < startMin - SCAN_BEFORE_MINUTES) {
        return res.status(400).json({
          success: false,
          error: `لا يمكن فتح الحصة قبل ${SCAN_BEFORE_MINUTES} دقيقة من موعدها الإفتراضي. موعد الحصة: ${session.startTime}`,
        });
      }

      if (nowMinutes > endMin) {
        return res.status(400).json({
          success: false,
          error: "عذراً، وقت الحصة المحددة قد انتهى لليوم الحالي ولا يمكن استقبال حضور لها",
        });
      }

      // تنفيذ المعاملة داخل قاعدة البيانات مع تفعيل لوجيك الصمود ضد التكرار (Idempotency)
      const result = await prisma.$transaction(async (tx) => {
        // البحث عن نافذة حضور قائمة بالفعل للحصة في نفس اليوم
        let window = await tx.sessionAttendanceWindow.findUnique({
          where: {
            sessionId_date: {
              sessionId: session.id,
              date: dateKey,
            },
          },
        });

        let alreadyExisted = false;
        let carryStats = { carriedCount: 0, fromSessions: [] };
        let fromNames = "لا يوجد حصة سابقة متصلة";

        if (!window) {
          // [الحالة الأولى]: الحصة تفتح لأول مرة اليوم -> ننشئ النافذة وننفذ لوجيك الترحيل الشامل
          window = await tx.sessionAttendanceWindow.create({
            data: {
              sessionId: session.id,
              date: dateKey,
              openedAt: now,
              isClosed: false,
            },
          });

          // استدعاء نظام النقل والترحيل الذكي للطلاب من الحصص السابقة المتصلة
          carryStats = await carryForwardFromPreviousSession(
            tx,
            centerId,
            session,
            window,
            dateKey,
            now
          );

          fromNames =
            carryStats.fromSessions && carryStats.fromSessions.length > 0
              ? carryStats.fromSessions.map((s) => s.name).join(" + ")
              : "لا يوجد حصة سابقة متصلة";

          // تسجيل الأكشن في سجل العمليات للأمان والرقابة
          await tx.activityLog.create({
            data: {
              centerId,
              userId,
              action: "OPEN_SESSION_WINDOW",
              targetType: "SessionAttendanceWindow",
              targetId: window.id,
              details: JSON.stringify({
                sessionName: session.name,
                roomName: session.room?.name,
                carriedStudentsCount: carryStats.carriedCount,
                fromSessionName: fromNames,
                isDuplicateRetry: false,
              }),
            },
          });
        } else {
          // [الحالة الثانية]: الحصة مفتوحة بالفعل مسبقاً (إعادة محاولة من الأوفلاين)
          alreadyExisted = true;

          // إذا كانت مغلقة، نقوم بإعادة فتحها لضمان معالجة طابور العمليات بسلاسة دون تعليق
          if (window.isClosed) {
            window = await tx.sessionAttendanceWindow.update({
              where: { id: window.id },
              data: { isClosed: false, openedAt: now },
            });
          }

          // جلب عدد الطلاب الذين تم ترحيلهم بالفعل مسبقاً لتوفير بيانات صحيحة للفرونت إند
          const actualCarriedCount = await tx.attendance.count({
            where: { windowId: window.id, autoMarked: true },
          });

          carryStats.carriedCount = actualCarriedCount;
          fromNames = "تم الترحيل وتثبيت الحضور تلقائياً في الطلب الأول";
        }

        return { window, carryStats, fromNames, alreadyExisted };
      });

      // إرجاع استجابة ناجحة دائماً في الحالتين لحماية استقرار طابور الأوفلاين بالفرونت إند
      return res.json({
        success: true,
        message: result.alreadyExisted
          ? "تنبيه: الحصة مفتوحة بالفعل اليوم مسبقاً، تم استرجاع بيانات الجلسة الحالية بنجاح واستقرار تام 🔄⚡"
          : "تم فتح نافذة الاستقبال بنجاح وتفعيل نظام الحضور التلقائي والرقابة المحصنة ⚡✅",
        isDuplicateRetry: result.alreadyExisted,
        session: {
          id: session.id,
          name: session.name,
          time: `${session.startTime} - ${session.endTime}`,
          teacherName: session.teacher?.name || "غير محدد",
          subject: session.teacher?.subject || "غير محدد",
          roomName: session.room?.name || "غير محدد",
        },
        window: {
          id: result.window.id,
          date: result.window.date,
          openedAt: result.window.openedAt,
          isClosed: result.window.isClosed,
        },
        carryForwardStats: {
          carriedCount: result.carryStats.carriedCount,
          fromSession: result.fromNames,
        },
      });
    } catch (error) {
      console.error("❌ Open Session Critical Architecture Error:", error);
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "فشلت عملية فتح وتجهيز الحصة الدراسية على السيرفر الرئيسي",
      });
    }
  }
);

// 3️⃣ POST /open-session/:sessionId - الحفاظ على المسار الفردي وتحديثه ليتوافق مع نظام النقل المتعدد المطور
router.post(
  "/open-sessions",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId, userId } = req.user;
      const { sessionIds } = req.body;

      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: "يجب تمرير مصفوفة تحتوي على معرفات الحصص المراد فتحها يدوياً [sessionIds]",
        });
      }

      const ids = sessionIds.map(Number).filter(Number.isInteger);
      if (ids.length === 0) {
        return res.status(400).json({
          success: false,
          error: "المعرفات الممررة غير صالحة برمجياً",
        });
      }

      const now = new Date();
      const { weekday, hour, minute } = getCairoParts(now);
      const nowMinutes = hour * 60 + minute;
      const dateKey = getCairoDateKey(now);

      // جلب الحصص المحددة والمحمية بـ centerId الخاص بالمسؤول الحالي
      const sessions = await prisma.session.findMany({
        where: { id: { in: ids }, room: { centerId } },
        include: {
          teacher: { select: { id: true, name: true, subject: true } },
          room: { select: { id: true, name: true } },
        },
      });

      if (sessions.length === 0) {
        return res.status(404).json({
          success: false,
          error: "لم يتم العثور على أي حصص صالحة تابعة لمركزك التلعيمي",
        });
      }

      const warnings = [];

      // تنفيذ العمليات مجمعة بالكامل داخل Transaction آمن ومحصن
      const openedResults = await prisma.$transaction(async (tx) => {
        const batch = [];

        for (const session of sessions) {
          // 1. التحقق من يوم الجدولة
          if (!session.days.includes(weekday)) {
            warnings.push(`الحصة (${session.name}) ليست مجدولة لليوم الحالي.`);
            continue;
          }

          const startMin = timeToMinutes(session.startTime);
          const endMin = timeToMinutes(session.endTime);

          // 2. التحقق من الحدود الزمنية للفتح
          if (nowMinutes < startMin - SCAN_BEFORE_MINUTES) {
            warnings.push(`لا يمكن فتح (${session.name}) قبل ${SCAN_BEFORE_MINUTES} دقيقة من موعدها.`);
            continue;
          }

          if (nowMinutes > endMin) {
            warnings.push(`وقت الحصة (${session.name}) قد انتهى بالفعل اليوم ولا يمكن فتحها.`);
            continue;
          }

          // 3. فحص الصمود والتحقق من وجود نافذة حضور مسبقة (المعالجة الذكية للتكرار بالدفعات)
          let window = await tx.sessionAttendanceWindow.findUnique({
            where: { sessionId_date: { sessionId: session.id, date: dateKey } },
          });

          let alreadyExisted = false;
          let carriedCount = 0;

          if (!window) {
            // فتح نافذة جديدة كلياً
            window = await tx.sessionAttendanceWindow.create({
              data: {
                sessionId: session.id,
                date: dateKey,
                openedAt: now,
                isClosed: false,
              },
            });

            // استدعاء نظام النقل والترحيل الذكي الشامل المتوازي
            const carry = await carryForwardFromPreviousSession(
              tx,
              centerId,
              session,
              window,
              dateKey,
              now
            );
            carriedCount = carry.carriedCount;

            // تسجيل لوج الفتح الفردي داخل الدفعة لتوثيق التحركات
            await tx.activityLog.create({
              data: {
                centerId,
                userId,
                action: "OPEN_SESSION_WINDOW",
                targetType: "SessionAttendanceWindow",
                targetId: window.id,
                details: JSON.stringify({
                  sessionName: session.name,
                  roomName: session.room?.name,
                  carriedStudentsCount: carriedCount,
                  fromSessions: carry.fromSessions,
                  bulkOperation: true,
                  isDuplicateRetry: false,
                }),
              },
            });
          } else {
            // الحصة تم فتحها مسبقاً، نسترجعها بسلام ونضمن فتحها إن أغلقت بالخطأ دون إلقاء خطأ يعطل الـ Queue
            alreadyExisted = true;
            if (window.isClosed) {
              window = await tx.sessionAttendanceWindow.update({
                where: { id: window.id },
                data: { isClosed: false, openedAt: now },
              });
            }

            // حساب العدد الحالي للذين تم ترحيلهم مسبقاً لعدم إفساد العدادات بالفرونت إند
            carriedCount = await tx.attendance.count({
              where: { windowId: window.id, autoMarked: true },
            });
          }

          // حقن النتيجة بالـ batch سواءً كانت جديدة أو مسترجعة لضمان تلبية تتابع عمليات الأوفلاين بنجاح
          batch.push({
            id: session.id,
            name: session.name,
            time: `${session.startTime} - ${session.endTime}`,
            windowId: window.id,
            carriedCount: carriedCount,
            alreadyExisted: alreadyExisted,
          });
        }

        return batch;
      });

      // إذا لم يتم فتح أو استرجاع أي حصة بنجاح، وكانت هناك تحذيرات زمنية تمنع الفتح
      if (openedResults.length === 0 && warnings.length > 0) {
        return res.status(400).json({
          success: false,
          error: "فشل فتح جميع الحصص المطلوبة بسبب قيود الوقت الصارمة وعدم مطابقة الجدولة",
          details: warnings,
        });
      }

      // حساب عدد الحصص المسترجعة مسبقاً من الإجمالي لمعلومات المطور والفرونت إند
      const duplicateCount = openedResults.filter((r) => r.alreadyExisted).length;

      return res.json({
        success: true,
        message: duplicateCount > 0
          ? `تمت معالجة الدفعة بنجاح: تم تفعيل فتح [ ${openedResults.length - duplicateCount} ] مجموعة جديدة، واسترجاع وضمان استقرار [ ${duplicateCount} ] مجموعة مفتوحة مسبقاً ⚡✅`
          : `تم فتح عدد [ ${openedResults.length} ] مجموعة بنجاح وتفعيل الرقابة ونظام النقل والتحويل المتوازي الذكي ⚡✅`,
        openedSessions: openedResults,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (error) {
      console.error("❌ Bulk Open Sessions Critical Error:", error);
      return res.status(500).json({
        success: false,
        error: "حدث خطأ بنمية الخادم غير متوقع أثناء معالجة فتح الحصص بالتوازي على السيرفر",
      });
    }
  }
);

// 4️⃣ POST /scan - مسح الـ QR والتوجيه الذكي الآلي الشامل لعدة حصص مفتوحة بالتوازي
router.post(
  "/scan",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId } = req.user;
      const {
        qrToken,
        sessionId,
        sessionIds,
        status: requestedStatus,
      } = req.body;

      if (!qrToken?.trim()) {
        return res
          .status(400)
          .json({
            success: false,
            error: "رمز الـ QR Token مطلوب لمسح حضور الطالب",
          });
      }

      const student = await prisma.student.findFirst({
        where: { qrToken, centerId },
      });
      if (!student) {
        return res
          .status(404)
          .json({
            success: false,
            error: "الطالب غير مسجل بالمنظومة أو رمز الكود غير صالح",
          });
      }

      const now = new Date();
      const { weekday, hour, minute } = getCairoParts(now);
      const nowMinutes = hour * 60 + minute;
      const dateKey = getCairoDateKey(now);
      const desiredStatus = normalizeAttendanceStatus(requestedStatus);

      const result = await prisma.$transaction(async (tx) => {
        // جلب كافة المجموعات المستهدفة بالاعتماد على ذكاء الدالة المحدثة
        const targetSessions = await resolveScanTarget(tx, {
          centerId,
          dayName: weekday,
          nowMinutes,
          sessionId,
          sessionIds,
        });

        const scannedSessions = [];

        for (const session of targetSessions) {
          // فحص اشتراك الطالب في هذه الحصة بالتحديد
          const hasActiveSubscriptionForSession =
            await tx.subscriptionItem.findFirst({
              where: {
                sessionId: session.id,
                subscription: {
                  studentId: student.id,
                  status: "ACTIVE",
                  endDate: { gte: now },
                },
              },
            });

          // لو الطالب مش مشترك في المجموعة دي، والنظام في وضع "المسح المفتوح لعدة حصص بالتوازي"
          // نقوم بعمل تخطي (continue) لفحص المجموعة التوازية الأخرى دون قطع وتوقيف العملية برمتها!
          if (!hasActiveSubscriptionForSession) {
            if (sessionId || (sessionIds && sessionIds.length > 0)) {
              throw new Error(
                `أمن الاشتراك: الطالب [ ${student.name} ] ليس لديه اشتراك نشط في حصة (${session.name}) 🛑`,
              );
            }
            continue;
          }

          const startMin = timeToMinutes(session.startTime);

          let window = await getWindowBySessionAndDate(tx, session.id, dateKey);
          if (!window) {
            window = await tx.sessionAttendanceWindow.create({
              data: {
                sessionId: session.id,
                date: dateKey,
                openedAt: now,
                isClosed: false,
                autoCloseMinutes: LATE_AFTER_MINUTES,
              },
            });
          } else if (window.isClosed) {
            throw new Error(
              `الحصة (${session.name}) مغلقة حالياً ومحمية من التعديل`,
            );
          }

          const existingAttendance = await tx.attendance.findFirst({
            where: { studentId: student.id, windowId: window.id },
          });

          if (existingAttendance) {
            throw new Error(
              `أمن المنظومة: الطالب [ ${student.name} ] مسجل له حالة بالفعل اليوم في حصة (${session.name}) 🛑`,
            );
          }

          await tx.attendanceScan.create({
            data: { studentId: student.id, centerId, scannedAt: now },
          });

          const lateMinutes = getLateMinutes(session, nowMinutes);
          let finalStatus = "PRESENT";

          if (desiredStatus === "ABSENT") {
            finalStatus = "ABSENT";
          } else if (
            nowMinutes > startMin + LATE_AFTER_MINUTES ||
            desiredStatus === "LATE"
          ) {
            finalStatus = "LATE";
          }

          const attendance = await tx.attendance.create({
            data: {
              studentId: student.id,
              sessionId: session.id,
              windowId: window.id,
              centerId,
              status: finalStatus,
              scannedAt: now,
              markedAt: now,
              autoMarked: false,
              markedBySystem: false,
              lateMinutes: finalStatus === "LATE" ? lateMinutes : 0,
            },
          });

          scannedSessions.push({ session, attendance, window });

          // طالما تم التوجيه والتحضير بنجاح للمجموعة المشترك فيها، نكتفي بذلك وننهي الفحص لحماية منطق البيانات (Break)
          break;
        }

        // لو لفينا على كل المجموعات المفتوحة ومطلعش مشترك في ولا واحدة، نضرب الإيرور الأمني فوراً
        if (scannedSessions.length === 0) {
          throw new Error(
            `عذراً، الطالب [ ${student.name} ] غير مسجل في أي مجموعة نشطة ومفتوحة حالياً بالسنتر 🛑`,
          );
        }

        return scannedSessions;
      });

      return res.json({
        success: true,
        message: `تم تسجيل حضور [ ${student.name} ] بنجاح وتوجيهه تلقائياً لمجموعته الصحيحة 🎯`,
        student: {
          id: student.id,
          name: student.name,
          stage: student.stage,
          grade: student.grade,
        },
        markedSessions: result.map((item) => ({
          sessionId: item.session.id,
          sessionName: item.session.name,
          status: item.attendance.status,
          time: `${item.session.startTime} - ${item.session.endTime}`,
        })),
      });
    } catch (error) {
      console.error("Scan system error:", error.message);
      return res.status(error.statusCode || 400).json({
        success: false,
        error: error.message || "حدث خطأ غير متوقع أثناء معالجة مسح الحضور",
      });
    }
  },
);

// 5️⃣ GET /session-students/:sessionId - جلب طلاب الحصة وتحديد حالات حضورهم اللحظية
router.get(
  "/session-students/:sessionId",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId } = req.user;
      const sessionId = Number(req.params.sessionId);
      const { name, status } = req.query;
      const now = new Date();
      const dateKey = getCairoDateKey(now);

      const session = await prisma.session.findFirst({
        where: { id: sessionId, room: { centerId } },
      });
      if (!session) {
        return res
          .status(404)
          .json({ success: false, error: "الحصة المطلوبة غير موجودة بالمركز" });
      }

      const studentWhere = {
        centerId,
        subscriptions: {
          some: {
            status: "ACTIVE",
            endDate: { gte: now },
            items: {
              some: { sessionId },
            },
          },
        },
      };

      if (name) {
        studentWhere.name = {
          contains: String(name).trim(),
          mode: "insensitive",
        };
      }

      const targetStudents = await prisma.student.findMany({
        where: studentWhere,
        select: { id: true, name: true, phone: true },
        orderBy: { name: "asc" },
      });

      const window = await getWindowBySessionAndDate(
        prisma,
        session.id,
        dateKey,
      );

      const attendanceRecords = window
        ? await prisma.attendance.findMany({
            where: { windowId: window.id },
            select: {
              studentId: true,
              status: true,
              scannedAt: true,
              autoMarked: true,
            },
          })
        : [];

      const attendanceMap = new Map(
        attendanceRecords.map((a) => [a.studentId, a]),
      );

      let studentsResult = targetStudents.map((student) => {
        const record = attendanceMap.get(student.id);
        return {
          id: student.id,
          name: student.name,
          phone: student.phone,
          status: record
            ? record.status
            : window
              ? "NOT_SCANNED"
              : "NOT_OPENED",
          isInside: !!record && ["PRESENT", "LATE"].includes(record.status),
          scannedAt: record ? record.scannedAt : null,
          autoMarked: record ? record.autoMarked : false,
        };
      });

      if (status) {
        studentsResult = studentsResult.filter(
          (s) => s.status === String(status).toUpperCase(),
        );
      }

      return res.json({
        success: true,
        sessionName: session.name,
        stage: session.stage,
        grade: session.grade,
        window: window || null,
        count: studentsResult.length,
        students: studentsResult,
      });
    } catch (error) {
      console.error("session-students error:", error);
      return res
        .status(500)
        .json({
          success: false,
          error: "فشل جلب ومعالجة طلاب الحصة التعليمية بشكل صحيح",
        });
    }
  },
);

// 6️⃣ POST /close-session/:sessionId - إنهاء الحصة يدوياً وتحويل المتخلفين لـ غائب تلقائياً وإرسال الواتساب
router.post(
  "/close-session/:sessionId",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const sessionId = Number(req.params.sessionId);
      const { centerId, userId } = req.user;
      const now = new Date();
      const dateKey = getCairoDateKey(now);

      const result = await prisma.$transaction(async (tx) => {
        const session = await tx.session.findFirst({
          where: { id: sessionId, room: { centerId } },
          include: {
            teacher: { select: { name: true, subject: true } },
          },
        });

        if (!session) {
          const err = new Error(
            "الحصة غير موجودة أو تم قيدها مسبقاً لمركز آخر",
          );
          err.statusCode = 404;
          throw err;
        }

        let window = await tx.sessionAttendanceWindow.findUnique({
          where: { sessionId_date: { sessionId, date: dateKey } },
        });

        if (!window) {
          window = await tx.sessionAttendanceWindow.create({
            data: { sessionId, date: dateKey, openedAt: now, isClosed: false },
          });
        }

        if (window.isClosed) {
          const err = new Error(
            "الحصة مغلقة ومقيدة بالفعل مسبقاً ومحمية من التعديل التكراري",
          );
          err.statusCode = 400;
          throw err;
        }

        const presentAttendances = await tx.attendance.findMany({
          where: { sessionId, centerId, windowId: window.id },
          select: { studentId: true },
        });
        const presentIds = presentAttendances.map((p) => p.studentId);

        const targetStudents = await tx.student.findMany({
          where: {
            centerId,
            subscriptions: {
              some: {
                status: "ACTIVE",
                endDate: { gte: now },
                items: {
                  some: { sessionId },
                },
              },
            },
          },
          select: { id: true, name: true, phone: true },
        });

        const absentStudents = targetStudents.filter(
          (s) => !presentIds.includes(s.id),
        );

        const absentRows = absentStudents.map((student) => ({
          studentId: student.id,
          sessionId,
          windowId: window.id,
          centerId,
          status: "ABSENT",
          scannedAt: null,
          markedAt: now,
          markedBySystem: true,
          autoMarked: true,
          lateMinutes: 0,
        }));

        if (absentRows.length > 0) {
          await tx.attendance.createMany({
            data: absentRows,
            skipDuplicates: true,
          });
        }

        const closedWindow = await tx.sessionAttendanceWindow.update({
          where: { id: window.id },
          data: { isClosed: true, closedAt: now, manualClosedBy: userId },
        });

        const finalized = await tx.attendance.findMany({
          where: { windowId: window.id },
          select: { status: true },
        });

        return {
          session,
          window: closedWindow,
          absentStudents,
          finalized,
          totalStudents: targetStudents.length,
        };
      });

      await Promise.all(
        result.absentStudents.map((student) =>
          safeSendWhatsApp(student.id, "ABSENT", {
            sessionName: result.session.name,
            subjectName: result.session.teacher?.subject,
            teacherName: result.session.teacher?.name,
          }),
        ),
      );

      return res.json({
        success: true,
        message:
          "تم إغلاق الحصة بنجاح تام وتحويل الطلاب المتغيبين إلى المنظومة الآلية للغياب وإرسال الإشعارات 🔐",
        session: { id: result.session.id, name: result.session.name },
        summary: {
          totalExpected: result.totalStudents,
          present: result.finalized.filter((a) => a.status === "PRESENT")
            .length,
          late: result.finalized.filter((a) => a.status === "LATE").length,
          absent: result.finalized.filter((a) => a.status === "ABSENT").length,
        },
      });
    } catch (error) {
      console.error("close-session error:", error);
      return res.status(error.statusCode || 500).json({
        success: false,
        error:
          error.message || "حدث خطأ غير متوقع أثناء إغلاق الحصة وحقن الغياب",
      });
    }
  },
);

// 7️⃣ GET /monthly-report/:studentId - احتساب التقرير الشهري التراكمي لنسبة حضور الطالب
const ARABIC_MONTHS = {
  1: "يناير",
  2: "فبراير",
  3: "مارس",
  4: "أبريل",
  5: "مايو",
  6: "يونيو",
  7: "يوليو",
  8: "أغسطس",
  9: "سبتمبر",
  10: "أكتوبر",
  11: "نوفمبر",
  12: "ديسمبر",
};

router.get(
  "/monthly-report/:studentId",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId } = req.user;
      const studentId = Number(req.params.studentId);

      const cairoNow =
        typeof getCairoParts === "function"
          ? getCairoParts()
          : {
              month: new Date().getMonth() + 1,
              year: new Date().getFullYear(),
            };
      const month = Number(req.query.month) || cairoNow.month;
      const year = Number(req.query.year) || cairoNow.year;

      if (!studentId || Number.isNaN(studentId)) {
        return res
          .status(400)
          .json({ success: false, error: "رقم الطالب الممرر غير صالح" });
      }
      if (!month || month < 1 || month > 12) {
        return res
          .status(400)
          .json({
            success: false,
            error: "الشهر المطلوب غير صالح (يجب أن يكون بين 1-12)",
          });
      }
      if (!year || year < 2000) {
        return res
          .status(400)
          .json({ success: false, error: "السنة المطلوبة غير صالحة" });
      }

      const student = await prisma.student.findFirst({
        where: { id: studentId, centerId },
        select: {
          id: true,
          name: true,
          phone: true,
          stage: true,
          grade: true,
          centerId: true,
        },
      });

      if (!student) {
        return res
          .status(404)
          .json({
            success: false,
            error: "الطالب غير مسجل بهذا المركز التعليمي",
          });
      }

      const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
      const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

      const studentSessions = await prisma.session.findMany({
        where: {
          room: { centerId },
          stage: student.stage,
          grade: student.grade,
        },
        select: { id: true },
      });

      const sessionIds = studentSessions.map((s) => s.id);

      const windows =
        sessionIds.length > 0
          ? await prisma.sessionAttendanceWindow.findMany({
              where: {
                sessionId: { in: sessionIds },
                isClosed: true,
                date: { gte: start, lte: end },
              },
              include: {
                session: {
                  select: {
                    id: true,
                    name: true,
                    startTime: true,
                    endTime: true,
                    teacher: {
                      select: { id: true, name: true, subject: true },
                    },
                    room: { select: { name: true } },
                  },
                },
              },
              orderBy: [{ date: "asc" }, { openedAt: "asc" }, { id: "asc" }],
            })
          : [];

      const windowIds = windows.map((w) => w.id);

      const attendances =
        windowIds.length > 0
          ? await prisma.attendance.findMany({
              where: {
                studentId,
                centerId,
                windowId: { in: windowIds },
              },
              select: {
                windowId: true,
                status: true,
                scannedAt: true,
                lateMinutes: true,
              },
            })
          : [];

      const attendanceMap = new Map(attendances.map((a) => [a.windowId, a]));

      let totalLateMinutes = 0;
      const subjectBreakdown = {};

      const presentLogs = [];
      const absentLogs = [];

      const details = windows.map((window) => {
        const attendance = attendanceMap.get(window.id);
        const status = attendance?.status || "ABSENT";
        const lateMin = attendance?.lateMinutes || 0;

        if (status === "LATE") {
          totalLateMinutes += lateMin;
        }

        const teacherName = window.session.teacher?.name || "مدرس غير محدد";
        const subjectName = window.session.teacher?.subject || "عام/أخرى";
        const subjectKey = `${subjectName} - ${teacherName}`;

        if (!subjectBreakdown[subjectKey]) {
          subjectBreakdown[subjectKey] = {
            subject: subjectName,
            teacher: teacherName,
            expected: 0,
            present: 0,
            late: 0,
            absent: 0,
          };
        }

        subjectBreakdown[subjectKey].expected++;
        if (status === "PRESENT") subjectBreakdown[subjectKey].present++;
        if (status === "LATE") subjectBreakdown[subjectKey].late++;
        if (status === "ABSENT") subjectBreakdown[subjectKey].absent++;

        const logItem = {
          status,
          scannedAt: attendance?.scannedAt || window.date,
          sessionName: window.session.name,
          teacherName: teacherName,
          sessionTime: window.session.startTime,
          scheduledTime: window.session.startTime,
          date: window.date,
        };

        if (status === "PRESENT" || status === "LATE") {
          presentLogs.push({
            ...logItem,
            isLate: status === "LATE",
          });
        } else {
          absentLogs.push(logItem);
        }

        return {
          windowId: window.id,
          date: window.date,
          dateLabel:
            typeof formatCairoDateLabel === "function"
              ? formatCairoDateLabel(window.date)
              : window.date.toISOString().split("T")[0],
          session: {
            id: window.session.id,
            name: window.session.name,
            startTime: window.session.startTime,
            endTime: window.session.endTime,
            teacherName,
            subject: subjectName,
            roomName: window.session.room?.name || "غير محدد",
          },
          status,
          scannedAt: attendance?.scannedAt || null,
          lateMinutes: lateMin,
        };
      });

      Object.keys(subjectBreakdown).forEach((key) => {
        const item = subjectBreakdown[key];
        const attended = item.present + item.late;
        item.attendanceRate =
          item.expected > 0
            ? `${((attended / item.expected) * 100).toFixed(1)}%`
            : "100%";
      });

      const totalExpectedSessions = windows.length;
      const totalPresent = details.filter((d) => d.status === "PRESENT").length;
      const totalLate = details.filter((d) => d.status === "LATE").length;
      const totalAbsent = details.filter((d) => d.status === "ABSENT").length;

      const totalAttendedCount = totalPresent + totalLate;
      const numericRate =
        totalExpectedSessions > 0
          ? (totalAttendedCount / totalExpectedSessions) * 100
          : 100;
      const attendanceRate = `${numericRate.toFixed(1)}%`;

      const averageLateMinutes =
        totalLate > 0 ? Math.round(totalLateMinutes / totalLate) : 0;

      let consecutiveAbsentStreak = 0;
      for (let i = details.length - 1; i >= 0; i--) {
        if (details[i].status === "ABSENT") {
          consecutiveAbsentStreak++;
        } else {
          break;
        }
      }

      let evaluationText = "ممتاز ومثالي ⭐⭐⭐";
      let evaluationStatus = "EXCELLENT";

      if (numericRate < 50 || consecutiveAbsentStreak >= 3) {
        evaluationText =
          "حرج جداً! غياب متكرر ويحتاج لمتابعة فورية واستدعاء ولي أمر 🚨";
        evaluationStatus = "CRITICAL";
      } else if (numericRate < 75) {
        evaluationText =
          "ضعيف، الطالب يتغيب كثيراً ويؤثر على مستواه الدراسي ⚠️";
        evaluationStatus = "WARNING";
      } else if (numericRate < 90) {
        evaluationText = "جيد جداً، ملتزم بشكل عام مع بعض التقصير الطفيف 👍";
        evaluationStatus = "GOOD";
      }

      await prisma.monthlyReportLog.upsert({
        where: { studentId_month_year: { studentId, month, year } },
        update: {
          totalPresent,
          totalAbsent,
          totalLate,
          sentAt: new Date(),
          status: "UPDATED",
        },
        create: {
          studentId,
          centerId,
          month,
          year,
          totalPresent,
          totalAbsent,
          totalLate,
          status: "GENERATED",
        },
      });

      if (req.query.send === "true") {
        await safeSendWhatsApp(student.id, "MONTHLY_REPORT", {
          presentLogs,
          absentLogs,
        });
      }

      return res.json({
        success: true,
        student: {
          id: student.id,
          name: student.name,
          phone: student.phone,
          stage: student.stage,
          grade: student.grade,
        },
        reportPeriod: {
          month,
          year,
          monthArabic: ARABIC_MONTHS[month] || String(month),
        },
        summary: {
          totalExpectedSessions,
          totalPresent,
          totalLate,
          totalAbsent,
          attendanceRate,
          performanceEvaluation: {
            status: evaluationStatus,
            text: evaluationText,
          },
        },
        criticalAlerts: {
          consecutiveAbsentStreak,
          isCriticalStreak: consecutiveAbsentStreak >= 3,
          totalLateMinutes,
          averageLateMinutes,
        },
        subjectBreakdown: Object.values(subjectBreakdown),
        details,
      });
    } catch (error) {
      console.error("❌ [CRITICAL MONTHLY REPORT ENGINE ERROR]:", error);
      return res
        .status(500)
        .json({
          success: false,
          error: "حدث خطأ داخلي أثناء احتساب ومعالجة التقرير الشهري",
        });
    }
  },
);

// 8️⃣ POST /sync - المزامنة وحقن سجلات الحضور القادمة من الأوفلاين
router.post(
  "/sync",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId } = req.user;
      const now = new Date();

      const records = Array.isArray(req.body.records)
        ? req.body.records
        : Array.isArray(req.body.attendanceRecords)
          ? req.body.attendanceRecords
          : [];

      if (records.length === 0) {
        return res.status(400).json({
          success: false,
          error: "مصفوفة السجلات المطلوبة للمزامنة فارغة",
        });
      }

      // 1️⃣ استخدام الـ Transaction لحقن السجلات بشكل آمن وصامد ضد التكرار (Idempotent)
      const results = await prisma.$transaction(async (tx) => {
        const synced = [];
        const affectedWindows = new Set();

        for (const record of records) {
          const studentId = Number(record.studentId);
          const sessionId = Number(record.sessionId);
          const status = normalizeAttendanceStatus(record.status);
          const scannedAt = record.scannedAt
            ? new Date(record.scannedAt)
            : new Date();
          const dateKey = getCairoDateKey(scannedAt);
          const windowIdFromPayload = record.windowId
            ? Number(record.windowId)
            : null;

          // التحقق من الحصة (لو الحصة مش موجودة بنتخطى السجل بدل ما نكسر الـ Transaction بالكامل)
          const session = await tx.session.findFirst({
            where: { id: sessionId, room: { centerId } },
          });
          if (!session) continue;

          // التحقق من الطالب واشتراكه النشط
          const student = await tx.student.findFirst({
            where: {
              id: studentId,
              centerId,
              subscriptions: {
                some: {
                  status: "ACTIVE",
                  endDate: { gte: now },
                  items: { some: { sessionId } },
                },
              },
            },
          });
          if (!student) continue;

          // إيجاد أو إنشاء نافذة الحضور
          let window = windowIdFromPayload
            ? await tx.sessionAttendanceWindow.findFirst({
                where: { id: windowIdFromPayload, sessionId: sessionId },
              })
            : null;

          if (!window) {
            window = await tx.sessionAttendanceWindow.findUnique({
              where: { sessionId_date: { sessionId, date: dateKey } },
            });
          }

          if (!window) {
            window = await tx.sessionAttendanceWindow.create({
              data: {
                sessionId,
                date: dateKey,
                openedAt: scannedAt,
                isClosed: false,
              },
            });
          }

          // حفظ معرف النافذة لمعالجة غيابها لاحقاً
          affectedWindows.add(window.id);

          // 🛡️ فحص الحماية الإستباقي: منع التكرار المزدوج وإتاحة التحديث الذكي
          const existingAtt = await tx.attendance.findUnique({
            where: { studentId_windowId: { studentId, windowId: window.id } },
          });

          let att;
          if (existingAtt) {
            // النقل الذكي: إذا كان السجل القديم غياب والجديد حضور، نقوم بتحديث السجل فوراً
            att = await tx.attendance.update({
              where: { id: existingAtt.id },
              data: {
                status,
                scannedAt,
                markedAt: now,
                lateMinutes: record.lateMinutes ? Number(record.lateMinutes) : existingAtt.lateMinutes,
              },
            });
          } else {
            // إنشاء سجل جديد تماماً في حالة عدم وجوده مسبقاً
            att = await tx.attendance.create({
              data: {
                studentId,
                sessionId,
                windowId: window.id,
                centerId,
                status,
                scannedAt,
                markedAt: scannedAt,
                autoMarked: Boolean(record.autoMarked),
                markedBySystem: Boolean(record.markedBySystem),
                lateMinutes: record.lateMinutes ? Number(record.lateMinutes) : null,
              },
            });
          }

          synced.push(att);
        }

        return { synced, affectedWindows: Array.from(affectedWindows) };
      });

      // ========================================================
      // 🚀 2️⃣ نظام الفحص والتحليل التلقائي لإرسال رسائل الغياب (WhatsApp Core)
      // ========================================================
      
      // جلب بيانات محفظة الواتساب الحالية للسنتر
      let wallet = await prisma.whatsAppWallet.findUnique({
        where: { centerId: Number(centerId) },
      });

      if (!wallet) {
        wallet = await prisma.whatsAppWallet.create({
          data: { centerId: Number(centerId), balance: 0 },
        });
      }

      let messagesSentCount = 0;

      // الفحص وإرسال الرسائل للطلاب المغيبين في النوافذ المتأثرة بالمزامنة فقط إذا كان هناك رصيد
      if (results.affectedWindows.length > 0 && wallet.balance > 0) {
        // جلب كافة سجلات الغياب الفوقية للنوافذ المتأثرة بالمزامنة التي لم يتم إرسال إشعار لها بعد
        const absentRecords = await prisma.attendance.findMany({
          where: {
            windowId: { in: results.affectedWindows },
            status: "ABSENT",
            centerId: Number(centerId),
          },
          include: {
            student: true,
            session: true,
          },
        });

        for (const absentAtt of absentRecords) {
          // التحقق من الرصيد داخل الـ Loop لمنع تجاوز الحد المسموح به
          if (wallet.balance <= 0) {
            console.warn(`⚠️ عاجل: نفد رصيد محفظة الواتساب للسنتر رقم ${centerId} أثناء معالجة المزامنة!`);
            break;
          }

          // استخدام هاتف ولي الأمر كخيار أول ثم هاتف الطالب
          const targetPhone = absentAtt.student.parentPhone || absentAtt.student.phone;
          if (!targetPhone) continue;

          const messageText = `أولياء الأمور الأفاضل، نحيطكم علماً بغياب الطالب/ة: ${absentAtt.student.name} عن حصة: ${absentAtt.session.name} بتاريخ اليوم. نتمنى له التوفيق دائماً.`;

          try {
            // 📲 استدعاء سيرفيس الواتساب المدمجة والمستوردة لديك في المشروع
            await sendWhatsAppMessage(targetPhone, messageText, centerId);

            // تحديث رصيد المحفظة وتسجيل المعاملة المالية في الداتابيز لكل رسالة بنجاح
            await prisma.$transaction(async (tx) => {
              await tx.whatsAppWallet.update({
                where: { id: wallet.id },
                data: { balance: { decrement: 1 } },
              });

              await tx.whatsAppTransaction.create({
                data: {
                  walletId: wallet.id,
                  amount: 1,
                  type: "SEND",
                  description: `رسالة غياب آلية متزامنة للطالب ${absentAtt.student.name} - حصة ${absentAtt.session.name}`,
                },
              });
            });

            // تحديث الحالة محلياً داخل الـ Loop لتتبع الرصيد اللحظي
            wallet.balance -= 1;
            messagesSentCount++;
          } catch (smsErr) {
            console.error(`❌ خطأ أثناء إرسال رسالة الواتساب للطالب رقم ${absentAtt.studentId}:`, smsErr);
          }
        }
      }

      return res.json({
        success: true,
        message: `تمت مزامنة وحقن عدد ${results.synced.length} سجل حضور بنجاح واستقرار تام بالخادم ✅ وتوليد وإرسال ${messagesSentCount} رسالة غياب عبر الواتساب 📱`,
        syncedCount: results.synced.length,
        messagesSentCount,
      });

    } catch (error) {
      console.error("❌ Sync Critical Architecture Error:", error);
      return res.status(400).json({
        success: false,
        error: error.message || "فشلت عملية مزامنة وتحليل البيانات مع خادم السنتر الرئيسي",
      });
    }
  }
);
// attendance.js - الراوت المخصص والمطور لتسجيل الحضور اليدوي (بدون كارت أو QR)
router.post(
  "/mark-attendance",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  async (req, res) => {
    const { centerId, userId } = req.user;
    
    // تحويل المدخلات لبيانات رقمية ونصوص معالجة لضمان سلامة الاستعلام
    const studentId = Number(req.body.studentId);
    const sessionId = Number(req.body.sessionId);
    const status = req.body.status ? req.body.status.toUpperCase() : "PRESENT";
    const lateMinutes = req.body.lateMinutes !== undefined ? Number(req.body.lateMinutes) : 0;

    // 1. صمام الأمان الأول: التحقق الصارم من اكتمال وصلاحية حقول الطلب الجوهرية
    if (isNaN(studentId) || studentId <= 0 || isNaN(sessionId) || sessionId <= 0) {
      console.warn(`⚠️ [Manual Attendance Bad Request]: محاولة إدخال بيانات تالفة أو ناقصة من المستخدم [${userId}]`);
      return res.status(400).json({ 
        success: false, 
        error: "فشل معالجة الطلب: يجب تزويد النظام بمعرف الطالب ومعرف الحصة بشكل رقمي صحيح." 
      });
    }

    if (!["PRESENT", "LATE", "ABSENT"].includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: "فشل المعالجة: حالة الحضور المرسلة غير مطابقة للقيم المعتمدة بالنظام (PRESENT, LATE, ABSENT)." 
      });
    }

    console.log(
      `📝 [Manual Attendance Request]: تسجيل حضور يدوي للطالب [${studentId}] بحصة [${sessionId}] - الحالة: [${status}] من المستخدم: [${userId}]`
    );

    try {
      // 2. تنفيذ العملية داخل معاملة ذرية معزولة (Atomic Transaction) لضمان سلامة واتساق البيانات
      const result = await prisma.$transaction(async (tx) => {
        
        // أ. التحقق الأمني من وجود الطالب وتبعيته المطلقة للسنتر الحالي (Cross-Tenant Protection)
        const studentExists = await tx.student.findFirst({
          where: { id: studentId, centerId: Number(centerId) }
        });
        if (!studentExists) {
          throw new Error("عذراً، الطالب غير مسجل بسجلات هذا المركز التعليمي أو تم حذفه.");
        }

        // ب. التحقق الأمني من الحصة وتبعية المدرس الخاص بها للسنتر الحالي لقطع الطريق على أي تلاعب بالـ IDs
        const sessionExists = await tx.session.findFirst({
          where: { 
            id: sessionId,
            teacher: { centerId: Number(centerId) }
          }
        });
        if (!sessionExists) {
          throw new Error("عذراً، الحصة المطلوبة غير موجودة أو لا تنتمي لصلاحيات هذا المركز.");
        }

        // ج. جلب مفتاح التاريخ الخاص بتوقيت القاهرة (Cairo Date Key) لضمان استقرار النوافذ اليومية
        const todayKey = typeof getCairoDateKey === "function" 
          ? getCairoDateKey(new Date()) 
          : new Date(new Date().setHours(0, 0, 0, 0));

        // د. فحص أو إنشاء نافذة الحضور التاريخية للحصة في اليوم الحالي (SessionAttendanceWindow)
        let window = await tx.sessionAttendanceWindow.findUnique({
          where: { sessionId_date: { sessionId, date: todayKey } }
        });

        if (!window) {
          console.log(`⚙️ [Attendance Window]: لم يتم العثور على نافذة مفتوحة للحصة [${sessionId}] اليوم، جاري توليدها تلقائياً...`);
          window = await tx.sessionAttendanceWindow.create({
            data: { 
              sessionId, 
              date: todayKey, 
              openedAt: new Date(), 
              isClosed: false,
              autoCloseMinutes: 120 // وقت افتراضي مرن لإغلاق النافذة الذاتية
            }
          });
        }

        // هـ. فحص سجل الحضور السابق للوقوف على التغييرات وتوثيقها بدقة بملف النشاطات
        const existingAttendance = await tx.attendance.findUnique({
          where: { studentId_windowId: { studentId, windowId: window.id } }
        });

        // و. دمج وظيفة الـ Upsert الذكية لحقن الحضور الجديد أو تعديل القديم فوراً لمنع أخطاء الـ Unique Constraints
        const normalizedStatus = typeof normalizeAttendanceStatus === "function"
          ? normalizeAttendanceStatus(status)
          : status;

        const updatedAttendance = await tx.attendance.upsert({
          where: { studentId_windowId: { studentId, windowId: window.id } },
          update: {
            status: normalizedStatus,
            lateMinutes: normalizedStatus === "LATE" ? lateMinutes : 0,
            markedAt: new Date(),
            autoMarked: false,
            markedBySystem: false,
          },
          create: {
            studentId,
            sessionId,
            windowId: window.id,
            centerId: Number(centerId),
            status: normalizedStatus,
            lateMinutes: normalizedStatus === "LATE" ? lateMinutes : 0,
            scannedAt: new Date(),
            markedAt: new Date(),
            autoMarked: false,
            markedBySystem: false,
          },
        });

        // ز. توثيق العملية الحالية بجدول مراقبة النشاطات (Audit Trail Log) لمعرفة من قام بالتحضير اليدوي
        await tx.activityLog.create({
          data: {
            centerId: Number(centerId),
            userId: Number(userId),
            action: "MANUAL_ATTENDANCE_MARK",
            targetType: "Attendance",
            targetId: updatedAttendance.id,
            details: JSON.stringify({
              studentName: studentExists.name,
              sessionName: sessionExists.name,
              statusBefore: existingAttendance ? existingAttendance.status : "NONE",
              statusAfter: normalizedStatus,
              lateMinutes: normalizedStatus === "LATE" ? lateMinutes : 0,
              ipRequest: req.ip || "UNKNOWN"
            }),
          },
        });

        return updatedAttendance;
      });

      console.log(`✅ [Manual Attendance Success]: تم إثبات الحضور اليدوي بنجاح للطالب ID: [${studentId}]`);
      return res.json({ 
        success: true, 
        message: "تم تسجيل وتحديث حالة حضور الطالب يدوياً بنجاح استراتيجي تام بالخادم ✅",
        data: result
      });

    } catch (error) {
      console.error(`❌ Manual Attendance Critical Error:`, error);
      return res.status(400).json({ 
        success: false, 
        error: error.message || "فشل معالجة خطوة التحضير اليدوي بالسيرفر" 
      });
    }
  }
);
module.exports = router;
