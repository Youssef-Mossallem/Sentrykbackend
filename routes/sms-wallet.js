const express = require("express");
const { PrismaClient } = require("@prisma/client");

const {
  authenticateToken,
  requireRole,
  requireCenterAccess,
  requireActiveSubscription,
} = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

const PRICE_PER_MESSAGE =
  parseFloat(process.env.CHARGE_SMS_PRICE_PER_MESSAGE) || 0.23;

// =============================================
// GET /api/sms-wallet - عرض الرصيد
// =============================================
router.get(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId } = req.user;

      const wallet = await prisma.smsWallet.findUnique({
        where: { centerId },
      });

      if (!wallet) {
        return res.json({
          success: true,
          wallet: {
            messages: 0,
            balanceInMoney: 0,
            pricePerMessage: PRICE_PER_MESSAGE,
          },
        });
      }

      res.json({
        success: true,
        wallet: {
          messages: wallet.balance, // عدد الرسائل
          balanceInMoney: (wallet.balance * PRICE_PER_MESSAGE).toFixed(2),
          pricePerMessage: PRICE_PER_MESSAGE,
          lastUpdated: wallet.updatedAt,
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "خطأ في جلب المحفظة" });
    }
  },
);

// =============================================
// POST /api/sms-wallet/send - إرسال رسالة
// =============================================
router.post(
  "/send",
  authenticateToken,
  requireActiveSubscription,
  requireCenterAccess,
  async (req, res) => {
    try {
      const { phone, message } = req.body;
      const { centerId, userId } = req.user;

      if (!phone || !message?.trim()) {
        return res.status(400).json({
          error: "رقم الهاتف والرسالة مطلوبين",
        });
      }

      // --- تعديل منطق حساب عدد الرسائل ---
      // كل 60 حرف تحسب رسالة واحدة (SMS Part)
      const messageLength = message.trim().length;
      const requiredSmsParts = Math.ceil(messageLength / 60);

      if (messageLength > 1600) {
        return res.status(400).json({
          error: "الرسالة طويلة جدًا (الحد الأقصى 1600 حرف)",
        });
      }

      const wallet = await prisma.smsWallet.findUnique({
        where: { centerId },
      });

      // التحقق من كفاية الرصيد لعدد الأجزاء المطلوب
      if (!wallet || wallet.balance < requiredSmsParts) {
        return res.status(400).json({
          error: `رصيد غير كافٍ. الرسالة تتكون من ${requiredSmsParts} أجزاء ورصيدك الحالي ${wallet?.balance || 0}`,
        });
      }

      // خصم عدد الأجزاء الفعلي من المحفظة
      const updatedWallet = await prisma.smsWallet.update({
        where: { centerId },
        data: {
          balance: { decrement: requiredSmsParts },
        },
      });

      // تسجيل العملية بخصم عدد الأجزاء
      const transaction = await prisma.smsTransaction.create({
        data: {
          walletId: wallet.id,
          amount: -requiredSmsParts, // القيمة هنا سالبة لتعبر عن الخصم
          type: "SEND",
          description: `إرسال رسالة (${requiredSmsParts} أجزاء) إلى ${phone}`,
        },
      });

      // MOCK (لحد ما تربط API حقيقي)
      console.log(`[SMS MOCK] إلى ${phone}: ${message} | الأجزاء المحسومة: ${requiredSmsParts}`);

      // تسجيل activity
      await prisma.activityLog.create({
        data: {
          centerId,
          userId,
          action: "SEND_SMS",
          targetType: "SmsTransaction",
          targetId: transaction.id,
          details: JSON.stringify({
            phone,
            messageLength,
            smsParts: requiredSmsParts,
            remainingMessages: updatedWallet.balance,
          }),
        },
      });

      res.json({
        success: true,
        message: `تم إرسال الرسالة بنجاح (استهلاك ${requiredSmsParts} من الرصيد)`,
        remainingMessages: updatedWallet.balance,
        smsParts: requiredSmsParts
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "خطأ في إرسال الرسالة" });
    }
  },
);

// =============================================
// GET /api/sms-wallet/transactions
// =============================================
router.get(
  "/transactions",
  authenticateToken,
  requireActiveSubscription,
  requireCenterAccess,
  async (req, res) => {
    try {
      const { centerId } = req.user;
      const { page = 1, limit = 20 } = req.query;

      const wallet = await prisma.smsWallet.findUnique({
        where: { centerId },
      });

      if (!wallet) {
        return res.json({
          success: true,
          transactions: [],
          balance: 0,
        });
      }

      const skip = (Number(page) - 1) * Number(limit);

      const [transactions, total] = await Promise.all([
        prisma.smsTransaction.findMany({
          where: { walletId: wallet.id },
          orderBy: { createdAt: "desc" },
          skip,
          take: Number(limit),
        }),
        prisma.smsTransaction.count({
          where: { walletId: wallet.id },
        }),
      ]);

      res.json({
        success: true,
        balance: wallet.balance,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          totalPages: Math.ceil(total / limit),
        },
        transactions,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "خطأ في جلب العمليات" });
    }
  },
);

module.exports = router;