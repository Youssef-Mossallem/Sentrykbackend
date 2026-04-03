// const express = require("express");
// const { PrismaClient } = require("@prisma/client");
// const crypto = require("crypto");
// const {
//   authenticateToken,
//   requireRole,
//   requireCenterAccess,
// } = require("../middleware/auth");

// const router = express.Router();
// const prisma = new PrismaClient();

// // الإعدادات من ملف .env
// const PAYMOB_SECRET_KEY = process.env.PAYMOB_SECRET_KEY;
// const PAYMOB_PUBLIC_KEY = process.env.PAYMOB_PUBLIC_KEY;
// const PAYMOB_INTEGRATION_ID = process.env.PAYMOB_INTEGRATION_ID;
// const SMS_PRICE = parseFloat(process.env.CHARGE_SMS_PRICE_PER_MESSAGE || "0.23");

// // دالة مساعدة لحساب تاريخ الانتهاء
// const calculateEndDate = (currentEndDate, plan) => {
//   let date = currentEndDate && new Date(currentEndDate) > new Date()
//       ? new Date(currentEndDate)
//       : new Date();

//   if (plan === "YEARLY") date.setFullYear(date.getFullYear() + 1);
//   else if (plan === "TRIAL") date.setDate(date.getDate() + 14);
//   else date.setDate(date.getDate() + 30); // الافتراضي شهري
  
//   return date;
// };

// // =============================================
// // [1] إنشاء طلب دفع (Paymob Intention) باستخدام Fetch
// // =============================================
// router.post("/create", authenticateToken, requireCenterAccess, requireRole(["ADMIN"]), async (req, res) => {
//   try {
//     const { type, plan, amount, smsCount } = req.body;
//     const { centerId, userId, email, name } = req.user;

//     const center = await prisma.center.findUnique({ where: { id: centerId } });

//     // 1. التعامل مع الفترة التجريبية
//     if (plan === "TRIAL") {
//       if (center.trialUsed) return res.status(400).json({ error: "استخدمت الفترة التجريبية مسبقاً" });

//       const result = await prisma.$transaction(async (tx) => {
//         const payment = await tx.payment.create({
//           data: { centerId, amount: 0, plan: "TRIAL", status: "SUCCESS", createdBy: userId, paymentMethod: "SYSTEM" }
//         });
//         await tx.center.update({ where: { id: centerId }, data: { trialUsed: true, trialStartedAt: new Date(), plan: "TRIAL" } });
//         await tx.centerSubscription.create({
//           data: { centerId, startDate: new Date(), endDate: calculateEndDate(null, "TRIAL"), isActive: true }
//         });
//         return payment;
//       });
//       return res.json({ success: true, message: "تم تفعيل الفترة التجريبية", paymentId: result.id });
//     }

//     // 2. حساب المبلغ (بالقرش)
//     const finalAmount = type === "SMS" ? parseInt(smsCount) * SMS_PRICE : parseFloat(amount);
//     const amountInCents = Math.round(finalAmount * 100);

//     // 3. سجل الدفع المبدئي
//     const paymentRecord = await prisma.payment.create({
//       data: {
//         centerId,
//         amount: finalAmount,
//         plan: plan || null,
//         status: "PENDING",
//         createdBy: userId,
//         metadata: { type, smsCount: type === "SMS" ? parseInt(smsCount) : 0 }
//       }
//     });

//     // 4. طلب الـ Intention من Paymob باستخدام Fetch
//     const paymobResponse = await fetch("https://accept.paymob.com/v1/intention/", {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         "Authorization": `Token ${PAYMOB_SECRET_KEY}`
//       },
//       body: JSON.stringify({
//         amount: amountInCents,
//         currency: "EGP",
//         payment_methods: [parseInt(PAYMOB_INTEGRATION_ID)],
//         items: [
//             {
//                 name: type === "SMS" ? "SMS Bundle" : `Subscription Plan: ${plan}`,
//                 amount: amountInCents,
//                 description: `Payment for center ${center.name}`
//             }
//         ],
//         billing_data: {
//           first_name: name?.split(" ")[0] || "User",
//           last_name: name?.split(" ")[1] || "Customer",
//           email: email || "no-email@provided.com",
//           phone_number: center.phone || "01000000000",
//           apartment: "NA", floor: "NA", building: "NA", street: "NA", city: "NA", country: "EG", state: "NA"
//         },
//         special_reference: paymentRecord.id.toString(),
//         notification_url: process.env.PAYMOB_NOTIFICATION_URL
//       })
//     });

//     const paymobData = await paymobResponse.json();

//     if (!paymobResponse.ok) {
//       throw new Error(paymobData.detail || "Paymob API Error");
//     }

//     // تحديث السجل بـ Intention ID
//     await prisma.payment.update({
//       where: { id: paymentRecord.id },
//       data: { paymobIntentionId: paymobData.id }
//     });

//     // 5. رابط التوجيه
//     const checkoutUrl = `https://accept.paymob.com/unifiedcheckout/?publicKey=${PAYMOB_PUBLIC_KEY}&clientSecret=${paymobData.client_secret}`;

//     res.json({ success: true, checkoutUrl, paymentId: paymentRecord.id });

//   } catch (err) {
//     console.error("❌ Payment Creation Error:", err.message);
//     res.status(500).json({ error: "فشل في إنشاء عملية الدفع: " + err.message });
//   }
// });

// // =============================================
// // [2] WEBHOOK - استقبال النتيجة من Paymob
// // =============================================
// router.post("/webhook", async (req, res) => {
//   try {
//     const { obj } = req.body;
//     if (!obj) return res.sendStatus(400);

//     const success = obj.success === true || obj.success === "true";
//     // نحاول الحصول على ID العملية من الـ special_reference الذي أرسلناه
//     const paymentIdInDb = parseInt(obj.special_reference || obj.payment_key_claims?.extra_description);

//     console.log(`⚡ [Webhook Received] DB_ID: ${paymentIdInDb} | Success: ${success}`);

//     if (!paymentIdInDb) return res.sendStatus(200); // تجاهل العمليات المجهولة

//     const payment = await prisma.payment.findUnique({
//       where: { id: paymentIdInDb },
//       include: { center: true }
//     });

//     if (!payment || payment.status === "SUCCESS") return res.sendStatus(200);

//     const metadata = payment.metadata || {};

//     await prisma.$transaction(async (tx) => {
//       // 1. تحديث حالة الدفع
//       await tx.payment.update({
//         where: { id: payment.id },
//         data: {
//           status: success ? "SUCCESS" : "FAILED",
//           transactionId: obj.id.toString(),
//           paidAt: success ? new Date() : null,
//         }
//       });

//       if (!success) return;

//       // 2. تفعيل الاشتراك
//       if (payment.plan) {
//         const existingSub = await tx.centerSubscription.findFirst({
//           where: { centerId: payment.centerId, isActive: true },
//         });
//         const endDate = calculateEndDate(existingSub?.endDate, payment.plan);

//         if (existingSub) {
//           await tx.centerSubscription.update({
//             where: { id: existingSub.id },
//             data: { endDate }
//           });
//         } else {
//           await tx.centerSubscription.create({
//             data: { centerId: payment.centerId, startDate: new Date(), endDate, isActive: true }
//           });
//         }
//         await tx.center.update({ where: { id: payment.centerId }, data: { plan: payment.plan } });
//       } 
      
//       // 3. شحن الـ SMS
//       if (metadata.type === "SMS") {
//         const count = parseInt(metadata.smsCount) || 0;
//         const wallet = await tx.smsWallet.upsert({
//           where: { centerId: payment.centerId },
//           update: { balance: { increment: count } },
//           create: { centerId: payment.centerId, balance: count },
//         });
//         await tx.smsTransaction.create({
//           data: { 
//             walletId: wallet.id, 
//             amount: count, 
//             type: "CHARGE", 
//             paymentId: payment.id, 
//             description: "شحن رصيد تلقائي عبر Paymob" 
//           }
//         });
//       }
//     });

//     res.sendStatus(200);
//   } catch (err) {
//     console.error("❌ Webhook Error:", err.message);
//     res.sendStatus(500);
//   }
// });

// module.exports = router;











const express = require("express");
const { PrismaClient } = require("@prisma/client");
const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
} = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// البيانات المطلوبة للتفعيل (يفضل وضعها في الـ .env)
const ADMIN_MOCK_EMAIL = process.env.ADMIN_MOCK_EMAIL || "ymslm120@gmail.com";
const ADMIN_MOCK_PASSWORD = process.env.ADMIN_MOCK_PASSWORD || "Youssef2011";
const SMS_PRICE = parseFloat(process.env.CHARGE_SMS_PRICE_PER_MESSAGE || "0.23");

// دالة حساب التاريخ لتجديد أو بدء الاشتراك
const calculateEndDate = (currentEndDate, plan) => {
  let date = currentEndDate && new Date(currentEndDate) > new Date()
      ? new Date(currentEndDate)
      : new Date();
      
  if (plan === "YEARLY") date.setFullYear(date.getFullYear() + 1);
  else if (plan === "TRIAL") date.setDate(date.getDate() + 14);
  else date.setDate(date.getDate() + 30); // الشهري
  
  return date;
};

// =============================================
// [1] جلب تفاصيل عملية دفع محددة (لصفحة الـ Checkout)
// =============================================
router.get("/details/:id", authenticateToken, async (req, res) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: parseInt(req.params.id) },
      select: {
        id: true,
        amount: true,
        plan: true,
        status: true,
        metadata: true,
        centerId: true
      }
    });

    if (!payment) {
      return res.status(404).json({ error: "العملية غير موجودة" });
    }

    if (payment.centerId !== req.user.centerId) {
        return res.status(403).json({ error: "غير مصرح لك بالوصول لهذه العملية" });
    }

    res.json(payment);
  } catch (err) {
    res.status(500).json({ error: "خطأ في جلب بيانات العملية: " + err.message });
  }
});

// =============================================
// [2] إنشاء طلب دفع يدوي (يوجه لصفحة الـ Checkout)
// =============================================
router.post("/create", authenticateToken, requireCenterAccess, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const { type, plan, amount, smsCount } = req.body;
    const { centerId, userId } = req.user;

    const center = await prisma.center.findUnique({ where: { id: centerId } });

    if (plan === "TRIAL") {
      if (center.trialUsed) return res.status(400).json({ error: "استخدمت الفترة التجريبية مسبقاً" });
      
      const result = await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.create({
          data: { 
            centerId, 
            amount: 0, 
            plan: "TRIAL", 
            status: "SUCCESS", 
            createdBy: userId, 
            paymentMethod: "SYSTEM",
            paidAt: new Date()
          }
        });
        
        await tx.center.update({ where: { id: centerId }, data: { trialUsed: true, trialStartedAt: new Date(), plan: "TRIAL" } });
        
        await tx.centerSubscription.create({
          data: { centerId, startDate: new Date(), endDate: calculateEndDate(null, "TRIAL"), isActive: true }
        });
        
        return payment;
      });
      return res.json({ success: true, message: "تم تفعيل الفترة التجريبية", paymentId: result.id });
    }

    const finalAmount = type === "SMS" ? parseInt(smsCount) * SMS_PRICE : parseFloat(amount);

    const paymentRecord = await prisma.payment.create({
      data: {
        centerId,
        amount: finalAmount,
        plan: plan || null,
        status: "PENDING",
        createdBy: userId,
        paymentMethod: "MANUAL_TRANSFER",
        metadata: { 
            type, 
            smsCount: type === "SMS" ? parseInt(smsCount) : 0 
        }
      }
    });

    res.json({ 
        success: true, 
        checkoutUrl: `/checkout?paymentId=${paymentRecord.id}`, 
        paymentId: paymentRecord.id 
    });

  } catch (err) {
    res.status(500).json({ error: "خطأ: " + err.message });
  }
});

// =============================================
// [3] تفعيل العملية يدوياً من قبل الأدمن (بدون توكن)
// =============================================
router.post("/activate-manual", async (req, res) => {
  try {
    const { paymentId, adminEmail, adminPassword } = req.body;

    // التحقق من بيانات الإدارة يدوياً بدلاً من التوكن
    if (adminEmail !== ADMIN_MOCK_EMAIL || adminPassword !== ADMIN_MOCK_PASSWORD) {
        return res.status(401).json({ 
            success: false, 
            error: "بيانات الإدارة غير صحيحة" 
        });
    }

    const payment = await prisma.payment.findUnique({
      where: { id: parseInt(paymentId) },
      include: { center: true }
    });

    if (!payment || payment.status === "SUCCESS") {
        return res.status(400).json({ error: "العملية غير صالحة أو مفعلة مسبقاً" });
    }

    const metadata = payment.metadata || {};

    await prisma.$transaction(async (tx) => {
      // 1. تحديث حالة الدفع إلى نجاح
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: "SUCCESS",
          paidAt: new Date(),
          transactionId: `MANUAL-${Date.now()}`
        }
      });

      // 2. إذا كان الدفع لاشتراك سنتر
      if (payment.plan) {
        const existingSub = await tx.centerSubscription.findFirst({
          where: { centerId: payment.centerId, isActive: true },
          orderBy: { endDate: 'desc' }
        });
        
        const endDate = calculateEndDate(existingSub?.endDate, payment.plan);

        if (existingSub) {
          await tx.centerSubscription.update({
            where: { id: existingSub.id },
            data: { endDate, isActive: true }
          });
        } else {
          await tx.centerSubscription.create({
            data: { centerId: payment.centerId, startDate: new Date(), endDate, isActive: true }
          });
        }
        await tx.center.update({ where: { id: payment.centerId }, data: { plan: payment.plan } });
      } 
      
      // 3. إذا كان الدفع لشحن SMS
      if (metadata.type === "SMS") {
        const count = parseInt(metadata.smsCount) || 0;
        const wallet = await tx.smsWallet.upsert({
          where: { centerId: payment.centerId },
          update: { balance: { increment: count } },
          create: { centerId: payment.centerId, balance: count },
        });
        
        await tx.smsTransaction.create({
          data: { 
            walletId: wallet.id, 
            amount: count, 
            type: "CHARGE", 
            paymentId: payment.id, 
            description: `شحن رصيد ${count} رسالة - تحويل يدوي` 
          }
        });
      }
    });

    res.json({ 
        success: true, 
        message: "تم التفعيل بنجاح",
        redirectTo: metadata.type === "SMS" ? "/sms-wallet" : "/dashboard"
    });

  } catch (err) {
    res.status(500).json({ error: "خطأ في التفعيل: " + err.message });
  }
});

module.exports = router;