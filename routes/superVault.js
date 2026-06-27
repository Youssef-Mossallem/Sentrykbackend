const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { PrismaClient, PaymentStatus } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

// ===========================================================================
// Infrastructure Security Utilities (محركات الحماية الذاتية)
// ===========================================================================

function generateNanoidToken() {
  return crypto.randomBytes(15).toString("base64url").substring(0, 20);
}

const loginAttemptsTracker = new Map();
function rateLimiterGuard(req, res, next) {
  const ip = req.ip || req.headers["x-forwarded-for"];
  const currentTime = Date.now();
  
  if (loginAttemptsTracker.has(ip)) {
    const data = loginAttemptsTracker.get(ip);
    if (currentTime - data.lastAttempt < 60000 && data.count >= 5) {
      return res.status(429).json({
        success: false,
        error: "🛡️ تم قفل الوصول مؤقتاً.. محاولات مشبوهة متكررة. انتظر دقيقة وأعد المحاولة."
      });
    }
    if (currentTime - data.lastAttempt >= 60000) {
      loginAttemptsTracker.set(ip, { count: 1, lastAttempt: currentTime });
    } else {
      data.count++;
    }
  } else {
    loginAttemptsTracker.set(ip, { count: 1, lastAttempt: currentTime });
  }
  next();
}

function verifyTOTPToken(secret, token) {
  try {
    const cleanToken = token.trim().replace(/\s+/g, "");
    if (cleanToken.length !== 6 || isNaN(cleanToken)) return false;

    const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (let i = 0; i < secret.length; i++) {
      const val = base32chars.indexOf(secret[i].toUpperCase());
      if (val !== -1) bits += val.toString(2).padStart(5, "0");
    }
    const secretBytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      secretBytes.push(parseInt(bits.substr(i, 8), 2));
    }

    const epoch = Math.floor(Date.now() / 1000);
    const counter = Math.floor(epoch / 30);

    for (let errorWindow = -1; errorWindow <= 1; errorWindow++) {
      const currentCounter = counter + errorWindow;
      const buffer = Buffer.alloc(8);
      let tmp = currentCounter;
      for (let i = 7; i >= 0; i--) {
        buffer[i] = tmp & 0xff;
        tmp >>= 8;
      }

      const hmac = crypto.createHmac("sha1", Buffer.from(secretBytes));
      hmac.update(buffer);
      const hmacResult = hmac.digest();

      const offset = hmacResult[hmacResult.length - 1] & 0xf;
      const code =
        ((hmacResult[offset] & 0x7f) << 24) |
        ((hmacResult[offset + 1] & 0xff) << 16) |
        ((hmacResult[offset + 2] & 0xff) << 8) |
        (hmacResult[offset + 3] & 0xff);

      const calculatedToken = (code % 1000000).toString().padStart(6, "0");
      if (calculatedToken === cleanToken) return true;
    }
    return false;
  } catch (err) {
    console.error("TOTP Internal Validation Engine Error:", err);
    return false;
  }
}

function authenticateSuperAdminSession(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ success: false, error: "صلاحيات غير كافية: الدخول للخزنة محرم برمجياً 🛡️" });
  }

  jwt.verify(token, process.env.SUPER_ADMIN_JWT_SECRET, (err, decodedPayload) => {
    if (err || !decodedPayload.isSuperAdmin) {
      return res.status(403).json({ success: false, error: "انتهت صلاحية الجلسة الأمنية أو التوكن غير شرعي 🔒" });
    }
    req.superAdmin = decodedPayload;
    next();
  });
}

// ===========================================================================
// 1. مجموعة راوتات الحماية وبوابة الدخول (Auth & Gateway)
// ===========================================================================

router.post("/request-link", rateLimiterGuard, async (req, res) => {
  try {
    const { ownerName, masterPassphrase, otpCode } = req.body;

    if (
      ownerName !== process.env.SUPER_ADMIN_OWNER_NAME ||
      masterPassphrase !== process.env.SUPER_ADMIN_MASTER_PASSPHRASE
    ) {
      return res.status(401).json({ success: false, error: "مزيج بيانات الدخول غير متطابق تماماً ❌" });
    }

    const isTotpValid = verifyTOTPToken(process.env.SUPER_ADMIN_TOTP_SECRET, otpCode);
    if (!isTotpValid) {
      return res.status(401).json({ success: false, error: "كود الأمان المتغير (OTP) خاطئ أو انتهت صلاحيته الزمنية 📱" });
    }

    const secureToken = generateNanoidToken();
    const expirationTime = new Date(Date.now() + 3 * 60 * 1000); 

    await prisma.superAdminGateway.create({
      data: {
        token: secureToken,
        isUsed: false,
        expiresAt: expirationTime
      }
    });

    const frontendBase = process.env.FRONTEND_URL || "http://localhost:5173";
    const finalDestinationUrl = `${frontendBase}/super-vault/verify?token=${secureToken}`;

    return res.json({
      success: true,
      message: "تم فتح البوابة الزمنية وتوليد الرابط بنجاح الفاش المباشر ⚡",
      gatewayUrl: finalDestinationUrl,
      expiresInSeconds: 180
    });
  } catch (error) {
    console.error("CRITICAL VAULT INTRUSION OR SYSTEM ERROR:", error);
    return res.status(500).json({ success: false, error: "خطأ داخلي في المنظومة التحتية للخزنة الكبرى" });
  }
});

router.post("/verify-gate", async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ success: false, error: "التوكن الأمني مفقود من ترويسة الطلب" });
  }

  try {
    const resultMatrix = await prisma.$transaction(async (tx) => {
      const gateRecord = await tx.superAdminGateway.findUnique({
        where: { token: token }
      });

      if (!gateRecord) {
        return { isValid: false, error: "كود العبور هذا غير مسجل بالبنية التحتية للنظام 🛡️" };
      }

      if (gateRecord.isUsed) {
        return { isValid: false, error: "تم استخدام هذا الرابط مسبقاً وتدميره ذاتياً لمنع الاختراقات المتكررة ⚠️" };
      }

      if (new Date(gateRecord.expiresAt) < new Date()) {
        return { isValid: false, error: "انتهت الصلاحية الزمنية للرابط (3 دقائق)، يرجى إصدار رابط جديد" };
      }

      await tx.superAdminGateway.update({
        where: { id: gateRecord.id },
        data: { isUsed: true }
      });

      return { isValid: true };
    });

    if (!resultMatrix.isValid) {
      return res.status(403).json({ success: false, error: resultMatrix.error });
    }

    const superAdminSessionToken = jwt.sign(
      {
        identity: process.env.SUPER_ADMIN_OWNER_NAME,
        isSuperAdmin: true,
        scope: "TOTAL_PLATFORM_OVERLORD"
      },
      process.env.SUPER_ADMIN_JWT_SECRET,
      { expiresIn: "1h" }
    );

    return res.json({
      success: true,
      message: "تم التحقق وإهلاك الرابط وتأمين جلسة العمل الحالية بنجاح ✅",
      token: superAdminSessionToken
    });
  } catch (error) {
    console.error("GATE VERIFICATION CRITICAL BLOW:", error);
    return res.status(500).json({ success: false, error: "فشل السيرفر في معالجة مصفوفة العبور الأمنية" });
  }
});

router.post("/logout", authenticateSuperAdminSession, (req, res) => {
  return res.json({
    success: true,
    message: "تم إنهاء الجلسة، وتطهير المسارات الأمنية للخزنة بنجاح 🛡️"
  });
});

// ===========================================================================
// 2. مجموعة راوتات التحكم بالسناتر والبيانات (Platform Management)
// ===========================================================================

router.get("/dashboard-stats", authenticateSuperAdminSession, async (req, res) => {
  try {
    const now = new Date();
    
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPreviousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfPreviousMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    const startOfCurrentYear = new Date(now.getFullYear(), 0, 1);

    const allSuccessfulPayments = await prisma.payment.findMany({
      where: { status: PaymentStatus.SUCCESS }
    });

    let totalRevenue = 0;
    let todayRevenue = 0;
    let weeklyRevenue = 0;
    let currentMonthRevenue = 0;
    let previousMonthRevenue = 0;
    let currentYearRevenue = 0;

    const dailyDistributionArray = {};

    allSuccessfulPayments.forEach((pay) => {
      const paymentDate = new Date(pay.paidAt || pay.createdAt);
      const amount = pay.amount || 0;

      totalRevenue += amount;

      if (paymentDate >= startOfToday) todayRevenue += amount;
      if (paymentDate >= startOfWeek) weeklyRevenue += amount;
      if (paymentDate >= startOfCurrentYear) currentYearRevenue += amount;
      
      if (paymentDate >= startOfCurrentMonth) {
        currentMonthRevenue += amount;
        const dayKey = paymentDate.toISOString().split("T")[0];
        dailyDistributionArray[dayKey] = (dailyDistributionArray[dayKey] || 0) + amount;
      }
      
      if (paymentDate >= startOfPreviousMonth && paymentDate <= endOfPreviousMonth) {
        previousMonthRevenue += amount;
      }
    });

    const totalCentersCount = await prisma.center.count();
    const activeCentersCount = await prisma.center.count({
      where: { plan: { not: "null" } } 
    });
    const frozenCentersCount = totalCentersCount - activeCentersCount;
    const totalStudentsInSystem = await prisma.student.count();

    return res.json({
      success: true,
      metrics: {
        revenue: {
          total: totalRevenue,
          today: todayRevenue,
          weekly: weeklyRevenue,
          currentMonth: currentMonthRevenue,
          previousMonth: previousMonthRevenue,
          currentYear: currentYearRevenue,
          monthlyGrowthPercent: previousMonthRevenue > 0 ? ((currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue) * 100 : 0
        },
        centers: {
          total: totalCentersCount,
          active: activeCentersCount,
          frozen: frozenCentersCount
        },
        students: {
          total: totalStudentsInSystem
        },
        charts: {
          timeSeriesRevenue: Object.keys(dailyDistributionArray).map((key) => ({
            date: key,
            amount: dailyDistributionArray[key]
          })).sort((a, b) => new Date(a.date) - new Date(b.date))
        }
      }
    });
  } catch (error) {
    console.error("FAILED TO GENERATE METRICS AND CHARTS MATRIX:", error);
    return res.status(500).json({ success: false, error: "فشل استخراج التحليلات المالية وقيم المقارنة" });
  }
});

router.get("/centers", authenticateSuperAdminSession, async (req, res) => {
  try {
    const centersList = await prisma.center.findMany({
      include: {
        users: {
          where: { role: "ADMIN" },
          select: { name: true, email: true }
        },
        activePromoCode: {
          select: { code: true, discountPercent: true }
        },
        _count: {
          select: { students: true, users: true }
        }
      },
      orderBy: { createdAt: "desc" }
    });

    const transformedCenters = centersList.map((center) => ({
      id: center.id,
      name: center.name,
      phone: center.phone,
      plan: center.plan,
      isActive: center.isActive, 
      trialUsed: center.trialUsed,
      maxStudentsLimit: center.maxStudents,
      currentStudentsCount: center._count.students,
      maxUsersLimit: center.maxUsers,
      currentUsersCount: center._count.users,
      isPromoPaused: center.isPromoPaused, // حقن حالة تجميد الخصم في الاستجابة
      activePromoCode: center.activePromoCode ? center.activePromoCode.code : null,
      ownerInfo: center.users[0] || { name: "غير مححدد", email: "لا يوجد" },
      referral: {
        code: center.referralCode,
        count: center.referralCount
      },
      createdAt: center.createdAt
    }));

    return res.json({
      success: true,
      centers: transformedCenters
    });
  } catch (error) {
    console.error("ERROR FETCHING PLATFORM CENTERS LIST:", error);
    return res.status(500).json({ success: false, error: "تعذر سحب مصفوفة السناتر الشاملة من النظام" });
  }
});

router.put("/centers/:id/control", authenticateSuperAdminSession, async (req, res) => {
  const centerId = parseInt(req.params.id);
  const { plan, maxStudents, maxUsers, isActive, isPromoPaused } = req.body;

  try {
    const targetCenter = await prisma.center.findUnique({ where: { id: centerId } });
    if (!targetCenter) {
      return res.status(404).json({ success: false, error: "السنتر المستهدف غير موجود بقاعدة البيانات الحالية" });
    }

    const updatePayload = {};
    if (plan !== undefined) updatePayload.plan = plan;
    if (maxStudents !== undefined) updatePayload.maxStudents = parseInt(maxStudents);
    if (maxUsers !== undefined) updatePayload.maxUsers = parseInt(maxUsers);
    if (isActive !== undefined) updatePayload.isActive = isActive;
    if (isPromoPaused !== undefined) updatePayload.isPromoPaused = isPromoPaused;

    const updatedCenter = await prisma.center.update({
      where: { id: centerId },
      data: updatePayload
    });

    return res.json({
      success: true,
      message: `تم تحديث حزمة بيانات السنتر [${updatedCenter.name}] وإعادة تعيين الصلاحيات والقيود بنجاح 🛡️`,
      center: updatedCenter
    });
  } catch (error) {
    console.error("FAILED TO EXECUTE ENTERPRISE CENTER CONTROL:", error);
    return res.status(500).json({ success: false, error: "حدث خطأ أثناء حفظ التعديلات الكبرى على السنتر" });
  }
});

/**
 * ✨ الراوت الذكي الجديد والمطلق لتعطيل/تفعيل خصم سنتر معين بكبسة زر واحدة
 * POST /api/super-vault/centers/:id/toggle-promo
 */
router.post("/centers/:id/toggle-promo", authenticateSuperAdminSession, async (req, res) => {
  const centerId = parseInt(req.params.id);
  
  try {
    const targetCenter = await prisma.center.findUnique({ where: { id: centerId } });
    if (!targetCenter) {
      return res.status(404).json({ success: false, error: "السنتر المستهدف غير موجود لتغيير صلاحية الخصم" });
    }

    // عكس الحالة الحالية تلقائياً (Toggle)
    const updatedCenter = await prisma.center.update({
      where: { id: centerId },
      data: { isPromoPaused: !targetCenter.isPromoPaused }
    });

    return res.json({
      success: true,
      isPromoPaused: updatedCenter.isPromoPaused,
      message: updatedCenter.isPromoPaused 
        ? `⛔ تم إيقاف وتجميد الخصومات لسنتر [${updatedCenter.name}] فوراً. فواتيره القادمة ستحسب بالسعر الكامل.`
        : `🍏 تم إعادة تفعيل الخصم النشط لسنتر [${updatedCenter.name}] بنجاح.`
    });
  } catch (error) {
    console.error("FAILED TO TOGGLE CENTER PROMO SYSTEM:", error);
    return res.status(500).json({ success: false, error: "فشل الخادم في معالجة طلب إيقاف/تشغيل خصم السنتر" });
  }
});

router.delete("/centers/:id", authenticateSuperAdminSession, async (req, res) => {
  const centerId = parseInt(req.params.id);

  try {
    const checkCenter = await prisma.center.findUnique({ where: { id: centerId } });
    if (!checkCenter) {
      return res.status(404).json({ success: false, error: "السنتر غير موجود أو تم حذفه مسبقاً" });
    }

    await prisma.center.delete({
      where: { id: centerId }
    });

    return res.json({
      success: true,
      message: `💥 تم مسح السنتر [${checkCenter.name}] بالكامل، واقتلاع كافة الجداول التابعة له والطلاب والملفات من جذورها بنجاح.`
    });
  } catch (error) {
    console.error("CRITICAL ERROR DURING HARD CENTER DELETION:", error);
    return res.status(500).json({ success: false, error: "فشل الحذف الهيكلي الصارم للسنتر، تحقق من القيود البرمجية" });
  }
});

module.exports = router;