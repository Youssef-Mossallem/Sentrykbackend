const express = require("express");
const { PrismaClient } = require("@prisma/client");
// الميدلوير للحماية
const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
} = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// ميدلوير التحقق من إدخال المجموعة
const validateGroupInput = (req, res, next) => {
  const { name, parentGroupId, maxStudents } = req.body;

  if (req.method === "POST" || req.method === "PUT") {
    if (!name?.trim()) {
      return res.status(400).json({
        error: "اسم المجموعة مطلوب ولا يمكن أن يكون فارغًا",
      });
    }

    if (parentGroupId !== undefined && parentGroupId !== null) {
      if (typeof parentGroupId !== "number" || parentGroupId <= 0) {
        return res.status(400).json({
          error: "معرف المجموعة الأم يجب أن يكون رقم موجب صحيح",
        });
      }
    }

    if (maxStudents !== undefined && maxStudents !== null) {
      if (typeof maxStudents !== "number" || maxStudents < 1) {
        return res.status(400).json({
          error: "الحد الأقصى للطلاب يجب أن يكون رقم موجب (1 أو أكثر)",
        });
      }
    }
  }

  next();
};

/**
 * دالة مساعدة لجلب الهيكل الشجري وتجميع الطلاب تراكمياً
 */
const buildGroupsTree = async (groups, parentId = null) => {
  const result = [];

  for (const group of groups) {
    if (group.parentGroupId === parentId) {
      const subGroups = await buildGroupsTree(groups, group.id);

      const directStudents = group.students.map((s) => ({
        id: s.id,
        name: s.name,
        phone: s.phone,
        stage: s.stage,
        subscriptions: s.subscriptions,
      }));

      let allSubStudents = [];
      for (const sub of subGroups) {
        allSubStudents = [...allSubStudents, ...sub.students];
      }

      const totalStudentsList = [...directStudents, ...allSubStudents];

      const node = {
        id: group.id,
        name: group.name,
        parentGroupId: group.parentGroupId,
        maxStudents: group.maxStudents,
        studentCount: totalStudentsList.length,
        students: totalStudentsList,
        subGroups: subGroups,
      };

      result.push(node);
    }
  }

  return result;
};

// POST /api/groups - إنشاء مجموعة جديدة مع نظام الحصص والـ Activity Log
router.post(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN", "SECRETARY"]),
  requireCenterAccess,
  validateGroupInput,
  async (req, res) => {
    try {
      const { name, parentGroupId, maxStudents } = req.body;
      const { centerId, userId } = req.user;

      if (parentGroupId) {
        const parent = await prisma.group.findFirst({
          where: { id: Number(parentGroupId), centerId },
          include: { subGroups: true },
        });

        if (!parent) return res.status(404).json({ error: "المجموعة الأم غير موجودة" });

        // منطق الحصص: إذا كانت الأم محددة السعة، يجب تحديد سعة للفرع
        if (parent.maxStudents) {
          if (!maxStudents) {
            return res.status(400).json({
              error: `بما أن المجموعة الأم لها حد أقصى (${parent.maxStudents})، فيجب تحديد حد أقصى لهذه المجموعة الفرعية أيضاً.`,
            });
          }

          const currentSubGroupsTotal = parent.subGroups.reduce(
            (sum, g) => sum + (g.maxStudents || 0),
            0,
          );

          if (currentSubGroupsTotal + maxStudents > parent.maxStudents) {
            return res.status(400).json({
              error: `فشل التوزيع: مجموع سعة المجموعات الفرعية سيتخطى سعة المجموعة الأم المحددة بـ ${parent.maxStudents}`,
            });
          }
        }
      }

      const newGroup = await prisma.group.create({
        data: {
          name: name.trim(),
          centerId,
          parentGroupId: parentGroupId ? Number(parentGroupId) : null,
          maxStudents: maxStudents || null,
        },
      });

      // تسجيل النشاط (Activity Log)
      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "CREATE_GROUP",
          targetType: "Group",
          targetId: newGroup.id,
          details: JSON.stringify({
            name: newGroup.name,
            parentGroupId: newGroup.parentGroupId,
            maxStudents: newGroup.maxStudents,
          }),
        },
      });

      res.status(201).json({ message: "تم إنشاء المجموعة بنجاح", group: newGroup });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "خطأ في السيرفر" });
    }
  },
);

// GET /api/groups - عرض المجموعات بالشجرة
router.get(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId } = req.user;
      const allGroups = await prisma.group.findMany({
        where: { centerId },
        include: {
          students: {
            include: {
              subscriptions: { where: { status: "ACTIVE" } },
            },
          },
        },
        orderBy: { name: "asc" },
      });

      const tree = await buildGroupsTree(allGroups, null);
      res.json({ success: true, data: tree });
    } catch (error) {
      res.status(500).json({ error: "خطأ في السيرفر" });
    }
  },
);

// GET /api/groups/:id - تفاصيل مجموعة واحدة
router.get(
  "/:id",
  authenticateToken,
  requireActiveSubscription,
  requireCenterAccess,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { centerId } = req.user;

      const allGroups = await prisma.group.findMany({
        where: { centerId },
        include: {
          students: { select: { id: true, name: true, phone: true, stage: true } },
        },
      });

      const targetGroup = allGroups.find((g) => g.id === Number(id));
      if (!targetGroup) return res.status(404).json({ error: "المجموعة غير موجودة" });

      const getAllChildStudents = (groupId) => {
        let currentGroup = allGroups.find((g) => g.id === groupId);
        let students = currentGroup ? currentGroup.students : [];
        const children = allGroups.filter((g) => g.parentGroupId === groupId);
        for (const child of children) {
          students = [...students, ...getAllChildStudents(child.id)];
        }
        return students;
      };

      const totalStudents = getAllChildStudents(Number(id));

      res.json({
        success: true,
        group: {
          ...targetGroup,
          students: totalStudents,
          studentCount: totalStudents.length,
        },
      });
    } catch (error) {
      res.status(500).json({ error: "خطأ في السيرفر" });
    }
  },
);

// PUT /api/groups/:id - تعديل مجموعة مع نظام الحصص والـ Activity Log
router.put(
  "/:id",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  validateGroupInput,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { name, parentGroupId, maxStudents } = req.body;
      const { centerId, userId } = req.user;

      const group = await prisma.group.findFirst({
        where: { id: Number(id), centerId },
      });

      if (!group) return res.status(404).json({ error: "المجموعة غير موجودة" });

      const finalParentId = parentGroupId !== undefined ? parentGroupId : group.parentGroupId;
      const finalMaxStudents = maxStudents !== undefined ? maxStudents : group.maxStudents;

      if (finalParentId) {
        const parent = await prisma.group.findFirst({
          where: { id: Number(finalParentId), centerId },
          include: { subGroups: true },
        });

        if (parent && parent.maxStudents) {
          if (!finalMaxStudents) {
            return res.status(400).json({
              error: "لا يمكن جعل سعة هذه المجموعة مفتوحة لأن المجموعة الأم لها حد أقصى.",
            });
          }

          const brothersTotal = parent.subGroups
            .filter((g) => g.id !== Number(id))
            .reduce((sum, g) => sum + (g.maxStudents || 0), 0);

          if (brothersTotal + finalMaxStudents > parent.maxStudents) {
            return res.status(400).json({
              error: `تعديل مرفوض: إجمالي سعات الفروع سيصبح ${brothersTotal + finalMaxStudents} وهو أكبر من سعة الأم (${parent.maxStudents})`,
            });
          }
        }
      }

      const updatedGroup = await prisma.group.update({
        where: { id: Number(id) },
        data: {
          name: name?.trim() || group.name,
          parentGroupId: parentGroupId !== undefined ? (parentGroupId ? Number(parentGroupId) : null) : group.parentGroupId,
          maxStudents: maxStudents !== undefined ? maxStudents || null : group.maxStudents,
        },
      });

      // تسجيل النشاط (Activity Log)
      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "UPDATE_GROUP",
          targetType: "Group",
          targetId: updatedGroup.id,
          details: JSON.stringify({
            oldValues: { name: group.name, maxStudents: group.maxStudents },
            newValues: { name: updatedGroup.name, maxStudents: updatedGroup.maxStudents },
          }),
        },
      });

      res.json({ message: "تم التعديل بنجاح", group: updatedGroup });
    } catch (error) {
      res.status(500).json({ error: "خطأ في السيرفر" });
    }
  },
);

// DELETE /api/groups/:id - حذف مجموعة مع الـ Activity Log
router.delete(
  "/:id",
  authenticateToken,
  requireActiveSubscription,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { centerId, userId } = req.user;

      const group = await prisma.group.findFirst({ where: { id: Number(id), centerId } });
      if (!group) return res.status(404).json({ error: "المجموعة غير موجودة" });

      const studentCount = await prisma.student.count({ where: { groupId: Number(id) } });
      if (studentCount > 0) return res.status(400).json({ error: "لا يمكن حذف مجموعة بها طلاب" });

      const subGroupsCount = await prisma.group.count({ where: { parentGroupId: Number(id) } });
      if (subGroupsCount > 0) return res.status(400).json({ error: "لا يمكن حذف مجموعة بها فروع تابعة" });

      await prisma.group.delete({ where: { id: Number(id) } });

      // تسجيل النشاط (Activity Log)
      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "DELETE_GROUP",
          targetType: "Group",
          targetId: Number(id),
          details: JSON.stringify({ name: group.name }),
        },
      });

      res.json({ message: "تم الحذف بنجاح" });
    } catch (error) {
      res.status(500).json({ error: "خطأ في السيرفر" });
    }
  },
);

module.exports = router;