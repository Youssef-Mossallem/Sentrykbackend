const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// استدعاء ترسانة الحماية المشتركة من الميدلوير
const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
} = require("../middleware/auth");

// مصفوفة الحراس الأساسية الموحدة لتأمين وحماية بيانات السنتر والاشتراك
const commonGuards = [
  authenticateToken,
  requireCenterAccess,
  requireActiveSubscription,
];

// =============================================
// ميدلوير التحقق من مدخلات الحصة (دقة هندسية 100%)
// =============================================
const validateSessionInput = (req, res, next) => {
  const {
    name,
    teacherId,
    roomId,
    startTime,
    days,
    stage,
    grade,
    maxStudents,
  } = req.body;

  if (!name || !name.trim())
    return res.status(400).json({ error: "اسم الحصة/المجموعة مطلوب" });
  if (!teacherId) return res.status(400).json({ error: "معرف المدرس مطلوب" });
  if (!roomId) return res.status(400).json({ error: "معرف القاعة مطلوب" });
  if (!startTime || !startTime.trim())
    return res.status(400).json({ error: "وقت بدء الحصة مطلوب (مثال: 16:00)" });
  if (!days || !Array.isArray(days) || days.length === 0)
    return res
      .status(400)
      .json({
        error: "برجاء اختيار يوم واحد على الأقل في الأسبوع لتكرار الحصة",
      });
  if (!stage || !["PRIMARY", "MIDDLE", "HIGH"].includes(stage))
    return res.status(400).json({ error: "المرحلة الدراسية غير صالحة" });
  if (!grade || typeof grade !== "number")
    return res
      .status(400)
      .json({ error: "السنة الدراسية مطلوبة ويجب أن تكون رقماً" });

  if (maxStudents !== undefined && maxStudents !== null) {
    const parsedMax = parseInt(maxStudents);
    if (isNaN(parsedMax) || parsedMax <= 0) {
      return res
        .status(400)
        .json({
          error: "السعة القصوى للسيشن يجب أن تكون رقماً صحيحاً أكبر من الصفر",
        });
    }
  }

  next();
};

// دالة مساعدة لحساب وقت النهاية تلقائياً (+ ساعة كاملة) إذا لم يرسله الفرونت إند
const calculateDefaultEndTime = (startTimeStr) => {
  const [hours, minutes] = startTimeStr.split(":").map(Number);
  let endHours = hours + 1;
  if (endHours >= 24) endHours = endHours - 24;

  const formattedHours = String(endHours).padStart(2, "0");
  const formattedMinutes = String(minutes).padStart(2, "0");
  return `${formattedHours}:${formattedMinutes}`;
};

const timeToMinutes = (time) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

const hasTimeOverlap = (start1, end1, start2, end2) => {
  const s1 = timeToMinutes(start1);
  const e1 = timeToMinutes(end1);

  const s2 = timeToMinutes(start2);
  const e2 = timeToMinutes(end2);

  return s1 < e2 && e1 > s2;
};

// =============================================
// 1. إنشاء حصة/مجموعة جديدة بالتحقق من سعة القاعة وصلاحية المدرس (ADMIN, SECRETARY)
// =============================================
router.post(
  "/",
  commonGuards,
  requireRole(["ADMIN", "SECRETARY"]),
  validateSessionInput,
  async (req, res) => {
    try {
      const {
        name,
        teacherId,
        roomId,
        startTime,
        endTime,
        days,
        maxStudents,
        stage,
        grade,
      } = req.body;

      const { centerId, userId } = req.user;

      // 1. التحقق من وجود المدرس وتبعيته للسنتر
      const teacher = await prisma.teacher.findFirst({
        where: { id: Number(teacherId), centerId },
      });
      if (!teacher)
        return res
          .status(404)
          .json({ error: "المدرس غير موجود أو لا يتبع هذا السنتر" });

      // 🛑 التعديل الجوهري الجدید 🛑: التحقق من وجود تهيئة سعرية للمدرس تطابق هذه المرحلة وهذا الجريد
      const validPriceConfig = await prisma.priceConfiguration.findFirst({
        where: {
          teacherId: Number(teacherId),
          stage: stage,
          grades: {
            has: Number(grade), // التأكد أن الجريد المطلوب موجود داخل مصفوفة الجريدات بجدول الأسعار
          },
        },
      });

      if (!validPriceConfig) {
        return res.status(400).json({
          error: `عذراً هندسة، المدرس "${teacher.name}" لا يمتلك تهيئة سعرية معتمدة للمرحلة (${stage}) والجريد (${grade}). برجاء إعداد أسعاره أولاً لتمكينه من فتح هذه المجموعة.`,
        });
      }

      // 2. التحقق من وجود القاعة وتبعيتها للسنتر
      const room = await prisma.room.findFirst({
        where: { id: Number(roomId), centerId },
      });
      if (!room)
        return res
          .status(404)
          .json({ error: "القاعة غير موجودة أو لا تتبع هذا السنتر" });

      // 3. التحقق الذكي من السعة القصوى للسيشن مقارنة بسعة القاعة المختارة
      const finalMaxStudents = maxStudents
        ? parseInt(maxStudents)
        : room.maxStudents;
      if (finalMaxStudents > room.maxStudents) {
        return res.status(400).json({
          error: `عذراً هندسة، السعة المدخلة للمجموعة (${finalMaxStudents}) تتخطى السعة الاستيعابية القصوى للقاعة المختارة وهي (${room.maxStudents} طالب)`,
        });
      }

      // حساب وقت النهاية تلقائياً لو مبعوتش من الفرونت إند
      const finalEndTime =
        endTime && endTime.trim()
          ? endTime.trim()
          : calculateDefaultEndTime(startTime.trim());

      // =====================================
      // منع حجز نفس القاعة في نفس الوقت
      // =====================================
      const roomSessions = await prisma.session.findMany({
        where: {
          roomId: Number(roomId),
        },
      });

      for (const existingSession of roomSessions) {
        const sameDay = existingSession.days.some((day) => days.includes(day));

        if (!sameDay) continue;

        const overlap = hasTimeOverlap(
          startTime.trim(),
          finalEndTime,
          existingSession.startTime,
          existingSession.endTime,
        );

        if (overlap) {
          return res.status(400).json({
            error: `القاعة محجوزة بالفعل بواسطة المجموعة "${existingSession.name}" من ${existingSession.startTime} إلى ${existingSession.endTime}`,
          });
        }
      }

      // 4. إنشاء الحصة بعد تخطي كافة حواجز الأمان الهندسية والمالية
      const newSession = await prisma.session.create({
        data: {
          name: name.trim(),
          teacherId: Number(teacherId),
          roomId: Number(roomId),
          days: days,
          startTime: startTime.trim(),
          endTime: finalEndTime,
          maxStudents: finalMaxStudents,
          stage,
          grade,
        },
        include: { teacher: true, room: true },
      });

      // تسجيل في الـ Activity Log
      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "CREATE_SESSION",
          targetType: "Session",
          targetId: newSession.id,
          details: JSON.stringify({
            name: newSession.name,
            teacher: newSession.teacher.name,
            room: newSession.room.name,
            maxStudents: finalMaxStudents,
            stage,
            grade,
          }),
        },
      });

      res.status(201).json({
        success: true,
        message:
          "تم إنشاء المجموعة بنجاح وتطبيق القيود الهندسية والمالية للسعة والاستحقاق ⏱️📅 ✅",
        session: newSession,
      });
    } catch (error) {
      console.error("❌ Error creating session:", error);
      res.status(500).json({ error: "حدث خطأ داخلي أثناء إنشاء الحصة" });
    }
  },
);
// =============================================
// 2. جلب الحصص مع السعة المتبقية والإيرادات الحية (ADMIN, SECRETARY)
// =============================================
router.get("/", commonGuards, requireRole(["ADMIN", "SECRETARY"]), async (req, res) => {
  try {
    const { centerId } = req.user;

    // جلب الحصص وتضمين الاشتراكات النشطة المرتبطة بها مباشرة بناءً على التعديل الجديد
    const sessions = await prisma.session.findMany({
      where: { teacher: { centerId } },
      include: {
        teacher: true,
        room: true,
        subscriptionItems: {
          where: {
            subscription: { status: "ACTIVE" },
          },
        },
      },
      orderBy: { startTime: "asc" },
    });

    // معالجة البيانات لحساب السعة المتبقية والإيرادات الفوقية بدقة 100% وبأعلى كفاءة
    const processedSessions = sessions.map((session) => {
      const studentCount = session.subscriptionItems.length;
      const remainingCapacity = Math.max(0, session.maxStudents - studentCount);

      // حساب إجمالي الدخل المجمع من لقطات الأسعار (priceSnapshot) للطلاب المشتركين بالسيشن حالياً
      const totalRevenue = session.subscriptionItems.reduce(
        (sum, item) => sum + item.priceSnapshot,
        0,
      );

      return {
        id: session.id,
        name: session.name,
        stage: session.stage,
        grade: session.grade,
        days: session.days,
        startTime: session.startTime,
        endTime: session.endTime,
        maxStudents: session.maxStudents,
        studentCount: studentCount, // عدد الطلاب الفعلي المسجلين في هذا الجروب
        remainingCapacity: remainingCapacity, // السعة المتبقية فورياً داخل القاعة للجروب ده
        estimatedRevenue: totalRevenue, // إجمالي إيراد المجموعة المباشر
        teacher: {
          id: session.teacher.id,
          name: session.teacher.name,
          subject: session.teacher.subject,
        },
        room: {
          id: session.room.id,
          name: session.room.name,
          maxRoomStudents: session.room.maxStudents,
        },
      };
    });

    res.json({
      success: true,
      count: processedSessions.length,
      sessions: processedSessions,
    });
  } catch (error) {
    console.error("❌ Error fetching sessions:", error);
    res.status(500).json({ error: "حدث خطأ أثناء جلب الحصص" });
  }
});

// =============================================
// 3. تعديل بيانات جدول حصة/مجموعة (ADMIN فقط 🔒)
// =============================================
router.put("/:id", commonGuards, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const { centerId, userId } = req.user;
    const {
      name,
      teacherId,
      roomId,
      startTime,
      endTime,
      days,
      maxStudents,
      stage,
      grade,
    } = req.body;

    if (isNaN(sessionId))
      return res.status(400).json({ error: "معرف المجموعة غير صحيح" });

    // 1. التأكد أن الحصة تابعة للسنتر
    const session = await prisma.session.findFirst({
      where: { id: sessionId, teacher: { centerId } },
      include: {
        subscriptionItems: { where: { subscription: { status: "ACTIVE" } } },
      },
    });
    if (!session)
      return res
        .status(404)
        .json({ error: "الحصة غير موجودة أو لا تملك صلاحية تعديلها" });

    const currentActiveStudents = session.subscriptionItems.length;
    const targetRoomId = roomId ? Number(roomId) : session.roomId;

    // 2. جلب بيانات القاعة (سواء الحالية أو الجديدة لتأكيد السعة)
    const targetRoom = await prisma.room.findFirst({
      where: { id: targetRoomId, centerId },
    });
    if (!targetRoom)
      return res
        .status(404)
        .json({ error: "القاعة المحددة غير موجودة بالسنتر" });

    let finalMaxStudents = session.maxStudents;

    // 3. التحقق الذكي في حالة محاولة تعديل السعة القصوى للسيشن
    if (maxStudents !== undefined && maxStudents !== null) {
      const parsedMax = parseInt(maxStudents);

      // أ. لا يمكن جعل سعة السيشن أكبر من سعة القاعة المستضيفة
      if (parsedMax > targetRoom.maxStudents) {
        return res.status(400).json({
          error: `لا يمكن تعديل السعة إلى (${parsedMax})، لأنها تتخطى السعة القصوى للقاعة المختارة وهي (${targetRoom.maxStudents} طالب)`,
        });
      }

      // ب. لا يمكن تقليل سعة السيشن لتكون أقل من عدد الطلاب النشطين فيه حالياً!
      if (parsedMax < currentActiveStudents) {
        return res.status(400).json({
          error: `لا يمكن تقليل سعة السيشن إلى (${parsedMax})، لأن هناك عدد (${currentActiveStudents}) طالب مشتركين ونشطين في هذه المجموعة حالياً.`,
        });
      }
      finalMaxStudents = parsedMax;
    } else if (roomId) {
      // لو غير القاعة بس مغيرش السعة، نتأكد إن سعة السيشن الحالية متقفلش مع سعة القاعة الجديدة
      if (session.maxStudents > targetRoom.maxStudents) {
        return res.status(400).json({
          error: `لا يمكن نقل السيشن لهذه القاعة، لأن سعة السيشن الحالي (${session.maxStudents}) أكبر من سعة القاعة الجديدة (${targetRoom.maxStudents})`,
        });
      }
    }

    // حساب الأوقات الفروقات تلقائياً
    const finalStartTime =
      startTime && startTime.trim() ? startTime.trim() : session.startTime;
    let finalEndTime = session.endTime;

    if (startTime || endTime) {
      if (endTime && endTime.trim()) {
        finalEndTime = endTime.trim();
      } else if (startTime) {
        finalEndTime = calculateDefaultEndTime(finalStartTime);
      }
    }
    const roomSessions = await prisma.session.findMany({
      where: {
        roomId: targetRoomId,
        NOT: {
          id: sessionId,
        },
      },
    });

    const targetDays = days || session.days;

    for (const existingSession of roomSessions) {
      const sameDay = existingSession.days.some((day) =>
        targetDays.includes(day),
      );

      if (!sameDay) continue;

      const overlap = hasTimeOverlap(
        finalStartTime,
        finalEndTime,
        existingSession.startTime,
        existingSession.endTime,
      );

      if (overlap) {
        return res.status(400).json({
          error: `القاعة محجوزة بالفعل بواسطة المجموعة "${existingSession.name}" من ${existingSession.startTime} إلى ${existingSession.endTime}`,
        });
      }
    }
    // 4. تحديث البيانات الفعلي في الداتابيز
    const updatedSession = await prisma.session.update({
      where: { id: sessionId },
      data: {
        name: name ? name.trim() : session.name,
        teacherId: teacherId ? Number(teacherId) : session.teacherId,
        roomId: targetRoomId,
        days: days || session.days,
        startTime: finalStartTime,
        endTime: finalEndTime,
        maxStudents: finalMaxStudents,
        stage: stage || session.stage,
        grade: grade ? Number(grade) : session.grade,
      },
    });

    await prisma.activityLog.create({
      data: {
        centerId,
        userId,
        action: "UPDATE_SESSION",
        targetType: "Session",
        targetId: sessionId,
        details: JSON.stringify({
          name: updatedSession.name,
          maxStudents: finalMaxStudents,
          roomId: targetRoomId,
        }),
      },
    });

    res.json({
      success: true,
      message: "تم تحديث جدول المجموعة والتحقق من كامل السعات بنجاح ✅",
      session: updatedSession,
    });
  } catch (error) {
    console.error("❌ Error updating session:", error);
    res.status(500).json({ error: "حدث خطأ أثناء تعديل الحصة" });
  }
});

// =============================================
// 4. حذف حصة نهائياً من النظام (ADMIN فقط 🔒)
// =============================================
router.delete("/:id", commonGuards, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const { centerId, userId } = req.user;

    if (isNaN(sessionId))
      return res.status(400).json({ error: "معرف المجموعة غير صحيح" });

    // 1. التأكد أن الحصة تابعة للسنتر وتضمين عدد الطلاب المرتبطين بها
    const session = await prisma.session.findFirst({
      where: { id: sessionId, teacher: { centerId } },
      include: {
        _count: {
          select: { subscriptionItems: true, attendance: true },
        },
      },
    });
    if (!session)
      return res
        .status(404)
        .json({ error: "الحصة غير موجودة أو تم حذفها مسبقاً" });

    // 2. حماية هندسية مضافة ⚠️: منع حذف السيشن لو فيه طلاب مسجلين فيه أو ليه سجلات حضور وغياب
    if (session._count.subscriptionItems > 0) {
      return res.status(400).json({
        error: `عذراً، لا يمكن حذف هذه المجموعة لوجود عدد (${session._count.subscriptionItems}) طالب مسجلين بها حالياً. قم بنقل الطلاب أولاً.`,
      });
    }

    if (session._count.attendance > 0) {
      return res.status(400).json({
        error: `لا يمكن حذف المجموعة لأنها تمتلك سجلات حضور وغياب محفوظة في السيستم لعدد (${session._count.attendance}) حصة.`,
      });
    }

    // 3. الحذف بعد تخطي شروط الأمان
    await prisma.session.delete({ where: { id: sessionId } });

    await prisma.activityLog.create({
      data: {
        centerId,
        userId,
        action: "DELETE_SESSION",
        targetType: "Session",
        targetId: sessionId,
        details: JSON.stringify({ name: session.name }),
      },
    });

    res.json({
      success: true,
      message: "تم حذف المجموعة بالكامل وبأمان من النظام 🗑️",
    });
  } catch (error) {
    console.error("❌ Error deleting session:", error);
    res.status(500).json({ error: "حدث خطأ داخلي أثناء حذف الحصة" });
  }
});

module.exports = router;