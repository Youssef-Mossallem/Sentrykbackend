const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// استيراد ميدلوير الصلاحيات
const { requireRole } = require("../middleware/auth");

// =============================================
// 1. إضافة قاعة جديدة (ADMIN, SECRETARY)
// =============================================
router.post("/", requireRole(["ADMIN", "SECRETARY"]), async (req, res) => {
  try {
    const { name, maxStudents } = req.body;
    const centerId = req.user.centerId; // مأخوذ من توكن تسجيل الدخول

    // 1. التحقق من المدخلات الأساسية
    if (!name || name.trim() === "") {
      return res.status(400).json({ error: "اسم القاعة مطلوب ولا يمكن أن يكون فارغاً" });
    }

    // 2. معالجة السعة القصوى لضمان عدم إدخال null أو قيم سالبة بناءً على السكيما الجديدة
    let parsedMaxStudents = 60; // القيمة الافتراضية للسيستم
    if (maxStudents !== undefined && maxStudents !== null && maxStudents !== "") {
      parsedMaxStudents = parseInt(maxStudents);
      if (isNaN(parsedMaxStudents) || parsedMaxStudents <= 0) {
        return res.status(400).json({ error: "السعة القصوى للقاعة يجب أن تكون رقماً صحيحاً أكبر من الصفر" });
      }
    }

    // 3. التحقق من عدم تكرار اسم القاعة داخل نفس السنتر
    const existingRoom = await prisma.room.findFirst({
      where: {
        name: name.trim(),
        centerId: centerId,
      },
    });

    if (existingRoom) {
      return res.status(400).json({ error: "عذراً، يوجد قاعة أخرى مسجلة بنفس هذا الاسم في مركزك" });
    }

    // 4. إنشاء القاعة
    const newRoom = await prisma.room.create({
      data: {
        name: name.trim(),
        maxStudents: parsedMaxStudents,
        centerId: centerId,
      },
    });

    res.status(201).json({
      success: true,
      message: "تم إنشاء القاعة بنجاح يا هندسة 🏛️",
      room: newRoom,
    });
  } catch (error) {
    console.error("❌ Error creating room:", error);
    res.status(500).json({ error: "حدث خطأ أثناء إنشاء القاعة" });
  }
});

// =============================================
// 2. جلب جميع قاعات السنتر (ADMIN, SECRETARY)
// =============================================
router.get("/", requireRole(["ADMIN", "SECRETARY"]), async (req, res) => {
  try {
    const centerId = req.user.centerId;

    const rooms = await prisma.room.findMany({
      where: { centerId: centerId },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, count: rooms.length, rooms });
  } catch (error) {
    console.error("❌ Error fetching rooms:", error);
    res.status(500).json({ error: "حدث خطأ أثناء جلب القاعات" });
  }
});

// =============================================
// 3. جلب تفاصيل قاعة محددة بالـ ID مع الحصص التابعة لها (ADMIN, SECRETARY)
// =============================================
router.get("/:id", requireRole(["ADMIN", "SECRETARY"]), async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const centerId = req.user.centerId;

    if (isNaN(roomId)) {
      return res.status(400).json({ error: "معرف القاعة غير صحيح" });
    }

    const room = await prisma.room.findFirst({
      where: {
        id: roomId,
        centerId: centerId, // حماية لضمان عدم وصول سنتر لقاعات سنتر آخر
      },
      include: {
        sessions: {
          select: {
            id: true,
            name: true,
            maxStudents: true,
            startTime: true,
            endTime: true,
            teacher: {
              select: { name: true, subject: true }
            }
          }
        }
      }
    });

    if (!room) {
      return res.status(404).json({ error: "القاعة المطلوبة غير موجودة أو لا تملك صلاحية الوصول إليها" });
    }

    res.json({ success: true, room });
  } catch (error) {
    console.error("❌ Error fetching room details:", error);
    res.status(500).json({ error: "حدث خطأ أثناء جلب تفاصيل القاعة" });
  }
});

// =============================================
// 4. تعديل بيانات قاعة (ADMIN فقط 🔒)
// =============================================
router.put("/:id", requireRole(["ADMIN"]), async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const centerId = req.user.centerId;
    const { name, maxStudents } = req.body;

    if (isNaN(roomId)) {
      return res.status(400).json({ error: "معرف القاعة غير صحيح" });
    }

    // 1. التأكد أولاً أن القاعة تابعة لهذا السنتر
    const room = await prisma.room.findFirst({
      where: { id: roomId, centerId: centerId },
    });

    if (!room) {
      return res.status(404).json({ error: "القاعة غير موجودة لتعديلها" });
    }

    const updateData = {};

    // 2. لو الاسم هيتعدل، نتأكد إنه مش متكرر لقاعة تانية في نفس السنتر
    if (name && name.trim() !== room.name) {
      const duplicateName = await prisma.room.findFirst({
        where: {
          name: name.trim(),
          centerId: centerId,
          NOT: { id: roomId },
        },
      });

      if (duplicateName) {
        return res.status(400).json({ error: "لا يمكن التعديل، يوجد قاعة أخرى تملك هذا الاسم بالفعل" });
      }
      updateData.name = name.trim();
    }

    // 3. ذكاء اصطناعي للسيستم 🧠: التحقق من السعة القصوى عند التعديل
    if (maxStudents !== undefined && maxStudents !== null && maxStudents !== "") {
      const parsedMax = parseInt(maxStudents);
      if (isNaN(parsedMax) || parsedMax <= 0) {
        return res.status(400).json({ error: "السعة القصوى يجب أن تكون رقماً صحيحاً أكبر من الصفر" });
      }

      // القيد الهندسي الفخم: بنشوف لو الأدمن بيحاول يقلل سعة القاعة لرقم أقل من سعة سيشن شغال فيها حالياً!
      const conflictingSession = await prisma.session.findFirst({
        where: {
          roomId: roomId,
          maxStudents: { gt: parsedMax }
        }
      });

      if (conflictingSession) {
        return res.status(400).json({ 
          error: `لا يمكن تقليل سعة القاعة إلى (${parsedMax}) طالب، لأن هناك مجموعة/سيشن مسجلة بالقاعة حالياً باسم "${conflictingSession.name}" وسعتها المحددة هي (${conflictingSession.maxStudents}) طالب. يرجى تعديل سعة المجموعة أولاً.` 
        });
      }

      updateData.maxStudents = parsedMax;
    }

    // 4. تحديث البيانات لو فيه تغييرات
    if (Object.keys(updateData).length === 0) {
      return res.json({ message: "لم يتم إجراء أي تغييرات على البيانات الحالية", room });
    }

    const updatedRoom = await prisma.room.update({
      where: { id: roomId },
      data: updateData,
    });

    res.json({
      success: true,
      message: "تم تحديث بيانات القاعة بنجاح يا هندسة ✅",
      room: updatedRoom,
    });
  } catch (error) {
    console.error("❌ Error updating room:", error);
    res.status(500).json({ error: "حدث خطأ أثناء تعديل القاعة" });
  }
});

// =============================================
// 5. حذف قاعة (ADMIN فقط 🔒)
// =============================================
router.delete("/:id", requireRole(["ADMIN"]), async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const centerId = req.user.centerId;

    if (isNaN(roomId)) {
      return res.status(400).json({ error: "معرف القاعة غير صحيح" });
    }

    // 1. التأكد أن القاعة تابعة للسنتر
    const room = await prisma.room.findFirst({
      where: { id: roomId, centerId: centerId },
    });

    if (!room) {
      return res.status(404).json({ error: "القاعة غير موجودة أو تم حذفها مسبقاً" });
    }

    // 2. منع الحذف الكارثي ⚠️: التأكد إن القاعة مش مربوطة بمجموعات/سيشنز شغالة حالياً
    const activeSessionsCount = await prisma.session.count({
      where: { roomId: roomId }
    });

    if (activeSessionsCount > 0) {
      return res.status(400).json({ 
        error: `عذراً هندسة، لا يمكن حذف هذه القاعة نظراً لأنها تحتوي على عدد (${activeSessionsCount}) مجموعة/سيشن نشطة حالياً. قم بنقل المجموعات لقاعات أخرى أولاً.` 
      });
    }

    // 3. الحذف الفعلي بعد تخطي الأمان
    await prisma.room.delete({
      where: { id: roomId },
    });

    res.json({ success: true, message: "تم حذف القاعة بنجاح من النظام 🗑️" });
  } catch (error) {
    console.error("❌ Error deleting room:", error);
    res.status(500).json({ error: "حدث خطأ أثناء حذف القاعة" });
  }
});

module.exports = router;