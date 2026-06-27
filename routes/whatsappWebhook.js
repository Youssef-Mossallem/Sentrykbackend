// backend/routes/whatsappWebhook.js
const express = require("express");
const router = express.Router();

// الرمز السري اللي هتكتبه بإيدك في لوحة تحكم فيسبوك (يفضل وضعه في الـ .env)
const WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "Sentryk_Super_Secret_Token_2026";

// 🌐 1. استقبال طلب التحقق من فيسبوك (GET) - بيشتغل مرة واحدة وقت الربط
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
      console.log("✅ [WHATSAPP WEBHOOK] تم التحقق من الرابط بنجاح بواسطة Meta!");
      return res.status(200).send(challenge);
    } else {
      console.warn("❌ [WHATSAPP WEBHOOK] محاولة تحقق فاشلة! الـ Token غير متطابق.");
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
});

// 📥 2. استقبال أحداث الرسائل من فيسبوك (POST) - (حالات الإرسال، القراءة، أو ردود المستخدمين)
router.post("/", (express.json()), (req, res) => {
  const body = req.body;

  // التحقق من أن الطلب قادم من تطبيق واتساب معتمد
  if (body.object === "whatsapp_business_account") {
    try {
      if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value) {
        const changeValue = body.entry[0].changes[0].value;

        // حالة أيراد تغيير في حالة الرسالة (Statuses: sent, delivered, read)
        if (changeValue.statuses && changeValue.statuses[0]) {
          const statusObj = changeValue.statuses[0];
          const messageStatus = statusObj.status; // sent, delivered, read
          const recipientId = statusObj.recipient_id; // رقم هاتف المستلم

          console.log(`📊 [WhatsApp Status Update] الرسالة المتجهة إلى ${recipientId} حالتها الآن: ${messageStatus.toUpperCase()}`);
          
          // 💡 هنا مستقبلاً تقدر تحدث حالة الرسالة في قاعدة البيانات لو تحب!
        }

        // حالة استقبال رسالة نصية قادمة من عميل أو ولي أمر (Messages)
        if (changeValue.messages && changeValue.messages[0]) {
          const messageObj = changeValue.messages[0];
          const fromPhone = messageObj.from; // رقم الراسل
          const messageText = messageObj.text?.body || "[محتوى غير نصي]";

          console.log(`📩 [WhatsApp Incoming Message] رسالة قادمة من ${fromPhone}: ${messageText}`);
          
          // 💡 هنا تقدر تبني الـ Chatbot أو الدعم الفني التلقائي للرد على أولياء الأمور!
        }
      }
    } catch (err) {
      console.error("❌ Error parsing WhatsApp Webhook body:", err.message);
    }

    // يجب دائماً الرد بـ 200 OK لـ فيسبوك فوراً عشان ما يوقفش الـ Webhook
    return res.status(200).send("EVENT_RECEIVED");
  } else {
    return res.sendStatus(404);
  }
});

module.exports = router;