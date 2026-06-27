const express = require('express');
const { google } = require('googleapis');
const path = require('path');

const router = express.Router();

// 1. تحديد مسار ملف الحساب السري (موجود في جذر السيرفر الرئيسي لسهولة الإدارة)
const keyPath = path.join(process.cwd(), 'service-account.json');
let key;

try {
  key = require(keyPath);
} catch (err) {
  console.error("❌ [Google Indexing API]: ملف service-account.json غير موجود في جذر السيرفر!");
}

// 2. إعداد عميل الـ JWT وصلاحيات الوصول لجوجل
const jwtClient = new google.auth.JWT(
  key?.client_email,
  null,
  key?.private_key,
  ['https://www.googleapis.com/auth/indexing'],
  null
);

/**
 * 🚀 دالة داخلية ذكية لإرسال الرابط الواحد لجوجل
 */
async function sendToGoogle(url, type = 'URL_UPDATED') {
  await jwtClient.authorize();
  const response = await jwtClient.request({
    url: 'https://indexing.googleapis.com/v3/urlNotifications:publish',
    method: 'POST',
    data: { url, type }
  });
  return response.data;
}

/**
 * 📡 الـ Endpoint الرئيسي: يدعم إرسال رابط واحد أو مصفوفة روابط دفعة واحدة
 * المسار: POST /api/indexing/request-instant
 */
router.post('/request-instant', async (req, res) => {
  const { url, urls, type = 'URL_UPDATED' } = req.body;

  // تجميع الروابط المستقبلة في مصفوفة موحدة
  let urlsToProcess = [];
  if (url) urlsToProcess.push(url);
  if (urls && Array.isArray(urls)) urlsToProcess = [...urlsToProcess, ...urls];

  // التحقق من وجود روابط معالجة
  if (urlsToProcess.length === 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'برجاء تمرير الرابط المراد فهرسته في حقل url أو urls' 
    });
  }

  console.log(`⚡ [Sentryk Indexing Engine]: جاري بدء فهرسة ذكية لعدد (${urlsToProcess.length}) رابط...`);

  const results = [];
  
  // معالجة الروابط حلقة تلو الأخرى لضمان استقرار الطلبات وتفادي الـ Rate Limits
  for (const targetUrl of urlsToProcess) {
    try {
      const googleResponse = await sendToGoogle(targetUrl, type);
      results.push({
        url: targetUrl,
        status: 'success',
        meta: googleResponse.urlNotificationMetadata
      });
    } catch (error) {
      results.push({
        url: targetUrl,
        status: 'failed',
        error: error.response ? error.response.data : error.message
      });
    }
  }

  // فرز العمليات الناجحة والفاشلة لتسهيل قراءتها في الفرونت إند
  const totalSuccess = results.filter(r => r.status === 'success').length;
  const totalFailed = results.filter(r => r.status === 'failed').length;

  return res.status(200).json({
    success: totalFailed === 0,
    summary: {
      totalProcessed: urlsToProcess.length,
      successCount: totalSuccess,
      failedCount: totalFailed
    },
    results
  });
});

module.exports = router;