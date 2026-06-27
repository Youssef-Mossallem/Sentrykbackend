const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { PrismaClient } = require("@prisma/client");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// ===========================================================================
// 1. إعداد البريد الإلكتروني (Nodemailer مع Elastic Email SMTP)
// ===========================================================================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.elasticemail.com",
  port: Number(process.env.SMTP_PORT) || 2525,
  secure: false, // false لـ 2525 أو 587، و true لـ 465 فقط
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  connectionTimeout: 6000,
  greetingTimeout: 6000,
  socketTimeout: 6000,
});

// ===========================================================================
// 2. [POST] /api/auth/signup - إنشاء حساب سنتر جديد (مع دعم الإحالة والحدود)
// ===========================================================================
router.post("/signup", async (req, res) => {
  try {
    const { centerName, phone, adminName, email, password, referredByCode } = req.body;

    // أ: التحقق الصارم من المدخلات الأساسية
    if (
      !centerName?.trim() ||
      !phone?.trim() ||
      !adminName?.trim() ||
      !email?.includes("@") ||
      !password || password.length < 8
    ) {
      return res.status(400).json({
        success: false,
        error: "البيانات غير كاملة أو غير صالحة (يجب ألا تقل كلمة المرور عن 8 أحرف)",
      });
    }

    // ب: التحقق من عدم تكرار البريد الإلكتروني قبل فتح المعاملة
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() }
    });
    if (existingUser) {
      return res.status(409).json({ success: false, error: "البريد الإلكتروني مستخدم بالفعل لنظام آخر" });
    }

    let invitingCenter = null;
    // ج: فحص كود الإحالة إذا أرسله الفرونت إند
    if (referredByCode?.trim()) {
      invitingCenter = await prisma.center.findUnique({
        where: { referralCode: referredByCode.trim() },
      });
      if (!invitingCenter) {
        return res.status(400).json({ success: false, error: "كود الإحالة المدخل غير صحيح أو غير متاح" });
      }
    }

    // د: تشفير كلمة المرور
    const hashedPassword = await bcrypt.hash(password, 10);

    // هـ: توليد كود إحالة فريد خاص بالسنتر الجديد (8 بايت عشوائي = 16 حرف)
    const newCenterReferralCode = crypto.randomBytes(8).toString("hex");

    // و: تنفيذ المعاملة البرمجية الموحدة (Prisma $transaction) لضمان سلامة البنية التحتية للبيانات
    const result = await prisma.$transaction(async (tx) => {
      
      // 1. إنشاء السنتر وضبط خطة التجربة (TRIAL) والحدود الافتراضية
      const center = await tx.center.create({
        data: {
          name: centerName.trim(),
          phone: phone.trim(),
          plan: "null", // سيتم تحديدها لاحقًا بعد التحقق من الاشتراك الفعلي
          trialUsed: false,
          trialStartedAt: new Date(),
          maxStudents: 0, // سعة الباقة التجريبية من الطلاب
          maxUsers: 0,       // عدد المشرفين الأقصى المسموح للباقة التجريبية
          referralCode: newCenterReferralCode,
          referredById: invitingCenter ? invitingCenter.id : null,
          referralMilestoneAchieved: false, // تظل معلقة ولا تفعل المكافأة إلا بعد الدفع الحقيقي الأول
        },
      });

      // 2. تحديث عداد الإحالات للسنتر الداعي (إن وجد) بشكل تلقائي وآمن
      // if (invitingCenter) {
      //   await tx.center.update({
      //     where: { id: invitingCenter.id },
      //     data: { referralCount: { increment: 1 } },
      //   });
      // }

      // 3. تأسيس محفظة الواتساب الـ الابتداية للسنتر برصيد (0) لمنع مشاكل الـ Null عند المزامنة أو الحضور
      await tx.whatsAppWallet.create({
        data: {
          centerId: center.id,
          balance: 0,
        },
      });

      // 4. إنشاء الحساب الإداري الرئيسي (ADMIN) وربطه بالسنتر
      const admin = await tx.user.create({
        data: {
          name: adminName.trim(),
          email: email.toLowerCase().trim(),
          password: hashedPassword,
          role: "ADMIN",
          centerId: center.id,
          isActive: true,
        },
      });

      return { center, admin };
    });

    // ز: توليد توكن الأمان الصارم للمنصة (7 أيام)
    const token = jwt.sign(
      { userId: result.admin.id, centerId: result.center.id, role: "ADMIN" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // ح: الاستجابة النهائية المهيأة للفرونت إند لبناء واجهة المستخدم اللحظية
    return res.status(201).json({
      success: true,
      message: "تم تأسيس السنتر وإنشاء حساب المدير بنجاح ✅",
      token,
      user: {
        id: result.admin.id,
        name: result.admin.name,
        email: result.admin.email,
        role: result.admin.role,
      },
      center: {
        id: result.center.id,
        name: result.center.name,
        phone: result.center.phone,
        plan: result.center.plan,
        maxStudents: result.center.maxStudents,
        maxUsers: result.center.maxUsers,
        referralCode: result.center.referralCode,
        trialUsed: result.center.trialUsed,       //  تأكيد إرسال الحقل للفرونت إند
        trialStartedAt: result.center.trialStartedAt //  تأكيد إرسال التاريخ للفرونت إند
      },
    });

  } catch (error) {
    console.error("❌ Critical Signup Error:", error);
    if (error.code === "P2002") {
      return res.status(409).json({ success: false, error: "البريد الإلكتروني أو كود الإحالة مستخدم بالفعل" });
    }
    return res.status(500).json({ success: false, error: "حدث خطأ داخلي في خادم الهوية والتسجيل" });
  }
});

// ===========================================================================
// 3. [POST] /api/auth/login - تسجيل الدخول ومصادقة المستخدمين
// ===========================================================================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: "البريد الإلكتروني وكلمة المرور مطلوبان" });
    }

    // جلب المستخدم مع بيانات السنتر والمحفظة للتأكد من الحالة الإجمالية
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { 
        center: {
          include: { whatsappWallet: true }
        } 
      },
    });

    // فحص التطابق والحماية من الهجمات التخمينية
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ success: false, error: "بيانات الاعتماد غير صحيحة، يرجى التثبت من المدخلات" });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, error: "هذا الحساب تم تجميده من قبل الإدارة، يرجى مراجعة الدعم" });
    }

    // توليد توكن المصادقة المشفر
    const token = jwt.sign(
      { userId: user.id, centerId: user.centerId, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      success: true,
      message: "تمت المصادقة بنجاح، مرحباً بك في منصة سنترك ⚡",
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
    console.error("❌ Login Error:", error);
    return res.status(500).json({ success: false, error: "خطأ داخلي بالسيرفر أثناء معالجة المصادقة" });
  }
});

// ===========================================================================
// 4. [POST] /api/auth/forgot-password - طلب استعادة كلمة المرور وإرسال إيميل آمن
// ===========================================================================
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: "يرجى تحديد البريد الإلكتروني المستهدف" });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

    // لحماية أمن البيانات ومنع صيد البريد الإلكتروني (Email Harvesting)، نرد دائماً بالنجاح
    if (!user) {
      return res.json({
        success: true,
        message: "إذا كان الحساب مسجلاً لدينا، فقد أرسلنا رابط إعادة التعيين إلى بريدك الإلكتروني بنجاح.",
      });
    }

    // توليد التوكن الخام والنسخة المشفرة للحفظ بالداتابيز لحماية الروابط المنتهية
    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken: hashedToken,
        resetTokenExpiry: new Date(Date.now() + 3600000), // الرابط صالح لمدة (ساعة واحدة) فقط حماية للمستخدم
      },
    });

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

    const mailOptions = {
      from: process.env.SMTP_FROM || "no-reply@sentryk.com",
      to: user.email,
      subject: "إعادة تعيين كلمة المرور لحسابك في منصة سنترك",
      html: `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; direction: rtl; text-align: right; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; padding: 24px; border-radius: 12px; background-color: #ffffff;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="color: #2563eb; font-size: 28px; margin: 0;">SENTRYK • سَنْتِرك</h1>
            <p style="color: #64748b; font-size: 14px;">النظام السحابي المتكامل لإدارة السناتر والمجموعات التعليمية</p>
          </div>
          <hr style="border: 0; border-top: 1px solid #edf2f7; margin-bottom: 24px;">
          <h2 style="color: #1e293b; font-size: 20px;">مرحباً ${user.name || "عزيزي المشترك"}،</h2>
          <p style="font-size: 16px; color: #475569; line-height: 1.6;">
            تلقينا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك على المنصة. إذا لم تقم بهذا الطلب بنفسك، فيمكنك تجاهل هذا البريد الإلكتروني بأمان.
          </p>
          <p style="font-size: 16px; color: #475569; margin-bottom: 30px;">
            لتعيين كلمة مرور جديدة ومتابعة العمل على نظامك، يرجى الضغط على الزر المباشر أدناه:
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: bold; font-size: 16px; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2);">
              إعادة تعيين كلمة المرور اللحظية
            </a>
          </div>
          <p style="font-size: 13px; color: #94a3b8; background-color: #f8fafc; padding: 12px; border-radius: 6px; border-right: 4px solid #cbd5e1;">
            ⚠️ تنبيه أمني: هذا الرابط مشفر وصالح للاستخدام لمرة واحدة فقط وينتهي تلقائياً بعد مرور <b>ساعة واحدة</b> من صدوره.
          </p>
          <hr style="border: 0; border-top: 1px solid #edf2f7; margin-top: 30px; margin-bottom: 20px;">
          <p style="font-size: 14px; color: #64748b; margin: 0; text-align: center;">مع تحيات فريق الهندسة والأمن السيبراني لـ سنترك</p>
        </div>
      `,
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`📧 [Reset Mail] تم شحن رابط الاستعادة بنجاح إلى: ${user.email}`);
    } catch (mailError) {
      console.error("❌ Mail Transport Error:", mailError.message);
      // في وضع التطوير المحلي طباعة الرابط لتسهيل القيادة والتجربة
      console.log("Local Debug Reset URL:", resetUrl);
    }

    return res.json({
      success: true,
      message: "إذا كان الحساب مسجلاً لدينا، فقد أرسلنا رابط إعادة التعيين إلى بريدك الإلكتروني بنجاح.",
    });

  } catch (error) {
    console.error("❌ Forgot Password Critical Error:", error);
    return res.status(500).json({ success: false, error: "فشل في معالجة طلب استعادة الحساب" });
  }
});

// ===========================================================================
// 5. [POST] /api/auth/reset-password/:token - تطبيق كلمة المرور الجديدة في قاعدة البيانات
// ===========================================================================
router.post("/reset-password/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, error: "يجب ألا تقل كلمة المرور الجديدة عن 8 أحرف" });
    }

    // تشفير التوكن القادم لمطابقته بالنسخة المخزنة بالـ DB
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await prisma.user.findFirst({
      where: {
        resetToken: hashedToken,
        resetTokenExpiry: { gt: new Date() }, // التحقق من عدم انتهاء الصلاحية الزمنية
      },
    });

    if (!user) {
      return res.status(400).json({ success: false, error: "الرابط غير صالح، أو تم استخدامه مسبقاً، أو انتهت صلاحيته الزمنية" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // تحديث كلمة المرور وتصفير حقول الاستعادة لغلق الثغرة الأمنية فوراً
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    return res.json({
      success: true,
      message: "تم تحديث وتغيير كلمة المرور بنجاح 🔒 يمكنك الآن تسجيل الدخول بالنظام بأمان.",
    });

  } catch (error) {
    console.error("❌ Reset Password Route Error:", error);
    return res.status(500).json({ success: false, error: "خطأ داخلي بالسيرفر أثناء حفظ كلمة المرور الجديدة" });
  }
});

// ===========================================================================
// 6. [GET] /api/auth/verify-status - الفحص الدوري وحقن التدوير المستمر للتوكن (Token Rotation)
// ===========================================================================
router.get("/verify-status", authenticateToken, async (req, res) => {
  try {
    // جلب أحدث بيانات المستخدم والسنتر والمحفظة بناء على التوكن المفكوك بالميدلوير
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: {
        center: {
          include: { whatsappWallet: true }
        }
      },
    });

    if (!user) {
      return res.status(401).json({ success: false, error: "مستند المستخدم لم يعد متوفراً بالنظام الحالي" });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, error: "تم تعطيل حسابك بشكل لحظي أثناء تشغيل الجلسة" });
    }

    // تدوير التوكن وتوليد واحد جديد بمدة صلاحية ممتدة (Token Rotation) لحماية الجلسات المستمرة للسنتر
    const rotatedToken = jwt.sign(
      { userId: user.id, centerId: user.centerId, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      success: true,
      message: "تم تحديث وضمان استقرار حالة الحساب والاشتراك اللحظي بنجاح ✅",
      token: rotatedToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        centerId: user.centerId,
        isActive: user.isActive,
      },
      center: user.center, // الكائن كاملاً يرجع للفرونت (الخطة، الإحالات، المحفظة، الحدود القصوى) لبناء الـ Dashboard بسلاسة
    });

  } catch (error) {
    console.error("❌ Verify Status Architectural Error:", error);
    return res.status(500).json({ success: false, error: "فشل السيرفر في إتمام الفحص الدوري وحالة الجلسة مجهولة" });
  }
});

module.exports = router;