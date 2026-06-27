// src/routes/whatsappWallet.js
const express = require("express");
const { PrismaClient } = require("@prisma/client");

const {
  authenticateToken,
  requireCenterAccess,
  requireActiveSubscription,
} = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// جلب سعر الرسالة الموحد للواتساب من متغيرات البيئة أو تعيين القيمة الافتراضية
const PRICE_PER_MESSAGE = parseFloat(process.env.CHARGE_WHATSAPP_PRICE_PER_MESSAGE) || 0.40;

// =============================================
// 1️⃣ GET /api/whatsapp-wallet - عرض بيانات ورصيد محفظة الواتساب اللحظي
// =============================================
router.get(
  "/",
  authenticateToken,
  requireActiveSubscription,
  requireCenterAccess,
  async (req, res) => {
    try {
      const centerId = req.user?.centerId;

      if (!centerId) {
        return res.status(400).json({
          success: false,
          error: "معرف السنتر غير موجود في بيانات المصادقة الخاصة بك",
        });
      }

      // البحث عن المحفظة الإلكترونية المرتبطة بالسنتر - مطابقة تماماً لـ schema.prisma
      let wallet = await prisma.whatsAppWallet.findUnique({
        where: { centerId: Number(centerId) },
      });

      // إذا كان السنتر جديداً ولم تُنشأ له محفظة بعد، يتم توليدها له تلقائياً برصيد صفري لمنع أي خطأ
      if (!wallet) {
        wallet = await prisma.whatsAppWallet.create({
          data: {
            centerId: Number(centerId),
            balance: 0,
          },
        });
      }

      // حساب القيمة المالية المقابلة لعدد الرسائل المتاحة بدقة
      const balanceInMoney = (wallet.balance * PRICE_PER_MESSAGE).toFixed(2);

      return res.json({
        success: true,
        wallet: {
          id: wallet.id,
          messages: wallet.balance, // متوافق تماماً مع واجهة الفرونت إند messages
          balanceInMoney: balanceInMoney,
          pricePerMessage: PRICE_PER_MESSAGE,
          lastUpdated: wallet.updatedAt,
        },
      });
    } catch (err) {
      console.error("❌ Critical Error In Fetching WhatsApp Wallet Data:", err);
      return res.status(500).json({
        success: false,
        error: "فشل النظام في استدعاء السجلات المالية للمحفظة السحابية",
      });
    }
  }
);

// =============================================
// 2️⃣ GET /api/whatsapp-wallet/transactions - جلب سجل المعاملات المالي المحدث والمقسم لصفحات (Pagination)
// =============================================
router.get(
  "/transactions",
  authenticateToken,
  requireActiveSubscription,
  requireCenterAccess,
  async (req, res) => {
    try {
      const centerId = req.user?.centerId;

      if (!centerId) {
        return res.status(400).json({
          success: false,
          error: "معرف السنتر غير صالح أو مفقود",
        });
      }
      
      // التطهير الصارم لبيانات التقسيم (Strict Integer Sanitization) لمنع انهيار البريسما
      let page = parseInt(req.query.page, 10);
      let limit = parseInt(req.query.limit, 10);

      if (isNaN(page) || page < 1) page = 1;
      if (isNaN(limit) || limit < 1) limit = 10;
      
      const skip = (page - 1) * limit;

      // العثور على المحفظة أولاً باستخدام التسمية الصحيحةwhatsAppWallet
      const wallet = await prisma.whatsAppWallet.findUnique({
        where: { centerId: Number(centerId) },
      });

      // إذا لم تكن هناك محفظة بعد، نرجع مصفوفة فارغة ببنية متوافقة مع جداول العرض
      if (!wallet) {
        return res.json({
          success: true,
          transactions: [],
          pagination: {
            total: 0,
            page,
            limit,
            totalPages: 1,
          },
        });
      }

      // جلب السجلات والعد التراكمي الفوري بشكل متوازي (Parallel Execution) لتسريع الأداء لأقصى درجة
      const [transactions, total] = await Promise.all([
        prisma.whatsAppTransaction.findMany({
          where: { walletId: wallet.id },
          orderBy: { createdAt: "desc" },
          skip: skip,
          take: limit,
        }),
        prisma.whatsAppTransaction.count({
          where: { walletId: wallet.id },
        }),
      ]);

      return res.json({
        success: true,
        transactions: transactions.map((tx) => ({
          id: tx.id,
          amount: tx.amount,
          type: tx.type, // CHARGE أو SEND مطابق للـ Enum بالبريسما والفرونت إند
          description: tx.description || "معاملة آلية معالجة بواسطة النظام",
          createdAt: tx.createdAt,
        })),
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit) || 1,
        },
      });
    } catch (err) {
      console.error("❌ Fetch WhatsApp Transactions Error:", err);
      return res.status(500).json({
        success: false,
        error: "حدث خطأ أثناء فحص واستدعاء كشف الحساب التاريخي للمحفظة",
      });
    }
  }
);

module.exports = router;