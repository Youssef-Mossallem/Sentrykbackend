const express = require("express");
const { PrismaClient } = require("@prisma/client");

const {
  authenticateToken,
  requireCenterAccess,
} = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// =============================================
// GET /api/activity-log - عرض سجل النشاط (قوي ومرن)
// =============================================
router.get("/", authenticateToken, requireCenterAccess, async (req, res) => {
  try {
    const { centerId } = req.user;

    // فلاتر من الـ query
    const {
      page = 1,
      limit = 20,
      from, // تاريخ البداية (ISO string)
      to, // تاريخ النهاية (ISO string)
      userId, // يوزر معين
      action, // نوع العملية (مثل CREATE_STUDENT)
      targetType, // نوع الهدف (Student, Subscription, SmsWallet...)
      targetId, // ID الهدف
    } = req.query;

    const where = { centerId };

    // فلتر التاريخ
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    if (userId) where.userId = Number(userId);
    if (action) where.action = action;
    if (targetType) where.targetType = targetType;
    if (targetId) where.targetId = Number(targetId);

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        include: {
          user: { select: { name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.activityLog.count({ where }),
    ]);

    // تنسيق الرد بشكل مختصر وسهل القراءة
    const formattedLogs = logs.map((log) => ({
      id: log.id,
      time: log.createdAt.toLocaleString("ar-EG"),
      user: log.user ? `${log.user.name} (${log.user.email})` : "نظام",
      action: log.action,
      target: log.targetType
        ? `${log.targetType} #${log.targetId || "غير محدد"}`
        : null,
      details: log.details ? JSON.parse(log.details) : null,
    }));

    res.json({
      success: true,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / limit),
      },
      data: formattedLogs,
    });
  } catch (error) {
    console.error("خطأ في عرض سجل النشاط:", error);
    res.status(500).json({ error: "حصل خطأ داخلي" });
  }
});

module.exports = router;
