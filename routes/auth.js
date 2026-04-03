const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { PrismaClient } = require("@prisma/client");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// إعداد nodemailer مع Elastic Email SMTP
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.elasticemail.com",
  port: Number(process.env.SMTP_PORT) || 2525,
  secure: false, // استخدم false لـ 2525/587، true لـ 465 فقط
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  // إضافة timeout وتجربة إعادة إرسال لو عايز (اختياري)
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 5000,
});

// POST /api/auth/signup - إنشاء حساب جديد (سنتر + أدمن)
// POST /api/auth/signup - إنشاء حساب جديد (سنتر + أدمن)
router.post("/signup", async (req, res) => {
  try {
    const { centerName, phone, adminName, email, password } = req.body;

    if (
      !centerName?.trim() ||
      !phone?.trim() ||
      !adminName?.trim() ||
      !email?.includes("@") ||
      password?.length < 8
    ) {
      return res.status(400).json({
        error: "البيانات غير كاملة أو غير صالحة (كلمة المرور 8 أحرف على الأقل)",
      });
    }

    // تحقق من الإيميل قبل أي حاجة
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({ error: "الإيميل مستخدم من قبل" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // إنشاء السنتر أولاً
    const newCenter = await prisma.center.create({
      data: { name: centerName.trim(), phone: phone.trim() },
    });

    // توليد كود الإحالة (16 حرف hex عشوائي)
    const referralCode = crypto.randomBytes(8).toString("hex");

    // تحديث السنتر بالكود
    await prisma.center.update({
      where: { id: newCenter.id },
      data: { referralCode },
    });

    // إنشاء الأدمن
    const newAdmin = await prisma.user.create({
      data: {
        name: adminName.trim(),
        email,
        password: hashedPassword,
        role: "ADMIN",
        centerId: newCenter.id,
        isActive: true,
      },
    });

    // توليد توكن
    const token = jwt.sign(
      { userId: newAdmin.id, centerId: newCenter.id, role: "ADMIN" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // الـ response النهائي
    res.status(201).json({
      message: "تم إنشاء الحساب بنجاح",
      token,
      user: {
        id: newAdmin.id,
        name: newAdmin.name,
        email: newAdmin.email,
        role: newAdmin.role,
      },
      center: {
        id: newCenter.id,
        name: newCenter.name,
        phone: newCenter.phone,
        referralCode, // الكود بيترجع هنا للأدمن الأول
      },
    });
  } catch (error) {
    console.error("خطأ في signup:", error);

    // لو الخطأ في Prisma (مثل duplicate email)
    if (error.code === "P2002") {
      return res.status(409).json({ error: "الإيميل مستخدم من قبل" });
    }

    // أي خطأ تاني
    res.status(500).json({ error: "حصل خطأ داخلي في السيرفر" });
  }
});

// POST /api/auth/login - تسجيل الدخول
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "الإيميل وكلمة المرور مطلوبين" });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { center: true },
    });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "الحساب معطل، تواصل مع الأدمن" });
    }

    const token = jwt.sign(
      { userId: user.id, centerId: user.centerId, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.json({
      message: "تم تسجيل الدخول بنجاح",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
      },
      center: user.center,
    });
  } catch (error) {
    console.error("خطأ في login:", error);
    res.status(500).json({ error: "خطأ داخلي في السيرفر" });
  }
});

// POST /api/auth/forgot-password - نسيت كلمة المرور (مع Elastic Email)
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "الإيميل مطلوب" });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.json({
        message: "إذا كان الإيميل موجود، تم إرسال رابط إعادة التعيين",
      });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken: hashedToken,
        resetTokenExpiry: new Date(Date.now() + 3600000), // ساعة
      },
    });

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

    const mailOptions = {
      from: process.env.SMTP_FROM || "no-reply@center.com",
      to: email,
      subject: "إعادة تعيين كلمة المرور - سنترك",
      html: `
        <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb;">مرحباً ${user.name || "عزيزي"}!</h2>
          <p style="font-size: 16px; color: #374151;">
            تلقينا طلبًا لإعادة تعيين كلمة المرور لحسابك.
          </p>
          <p style="font-size: 16px; color: #374151;">
            اضغط على الزر أدناه لتعيين كلمة مرور جديدة:
          </p>
          <a href="${resetUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 20px 0;">
            إعادة تعيين كلمة المرور
          </a>
          <p style="font-size: 14px; color: #6b7280;">
            الرابط صالح لمدة ساعة واحدة فقط.<br>
            لو لم تطلب هذا الإجراء، تجاهل الرسالة بأمان.
          </p>
          <p style="margin-top: 30px;">مع تحيات فريق سنترك</p>
        </div>
      `,
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log("تم إرسال الإيميل بنجاح إلى:", email);
    } catch (mailError) {
      console.error("خطأ في إرسال الإيميل:", mailError.message);
      // طباعة الرابط للاختبار لو فشل الإرسال
      console.log("Reset URL (للاختبار):", resetUrl);
    }

    res.json({
      message: "إذا كان الإيميل موجود، تم إرسال رابط إعادة التعيين",
    });
  } catch (error) {
    console.error("خطأ في forgot-password:", error);
    res.status(500).json({ error: "حصل خطأ في السيرفر" });
  }
});

// POST /api/auth/reset-password/:token - إعادة تعيين كلمة المرور
router.post("/reset-password/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 8) {
      return res
        .status(400)
        .json({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await prisma.user.findFirst({
      where: {
        resetToken: hashedToken,
        resetTokenExpiry: { gt: new Date() },
      },
    });

    if (!user) {
      return res
        .status(400)
        .json({ error: "الرابط غير صالح أو منتهي الصلاحية" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    res.json({
      message: "تم تغيير كلمة المرور بنجاح، يمكنك تسجيل الدخول الآن",
    });
  } catch (error) {
    console.error("خطأ في reset-password:", error);
    res.status(500).json({ error: "حصل خطأ في السيرفر" });
  }
});

// GET /api/auth/verify-status
// الراوت ده بيستخدمه الفرونت إند كل 5 دقائق أو عند عمل Refresh للتأكد من حالة الحساب والاشتراك
router.get("/verify-status", authenticateToken, async (req, res) => {
  try {
    // 1. جلب بيانات المستخدم والسنتر بناءً على الـ ID الموجود في التوكن
    // استخدمنا userId لأن الميدلوير بتاعك بيخزنها باسم req.user.userId
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: { 
        center: true // عشان نجيب الـ plan والـ trialStartedAt والـ referralCode
      },
    });

    // 2. التحقق من وجود المستخدم وصلاحية حسابه
    if (!user) {
      return res.status(401).json({ error: "المستخدم غير موجود" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "هذا الحساب معطل حالياً" });
    }

    // 3. توليد توكن جديد (Token Rotation) لضمان استمرارية الجلسة
    const newToken = jwt.sign(
      { userId: user.id, centerId: user.centerId, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // 4. الرد النهائي المتوافق تماماً مع الـ Interface في الفرونت إند
    res.json({
      success: true,
      message: "تم التحقق من الحالة بنجاح",
      token: newToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        centerId: user.centerId,
        isActive: user.isActive,
      },
      center: user.center // بيرجع الـ Object كامل (id, name, plan, trialStartedAt, etc.)
    });

  } catch (error) {
    console.error("Error in verify-status:", error);
    res.status(500).json({ error: "خطأ داخلي في السيرفر أثناء التحقق" });
  }
});

module.exports = router;
