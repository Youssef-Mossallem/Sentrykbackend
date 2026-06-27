const express = require('express');
const { google } = require('googleapis');

const router = express.Router();

// 1. بناء كائن الاعتمادات من متغيرات البيئة (Environment Variables)
const googleCredentials = {
  type: process.env.GOOGLE_SERVICE_ACCOUNT_TYPE,
  project_id: process.env.GOOGLE_PROJECT_ID,
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
  // استبدال الـ \n النصية بكسر سطر حقيقي لضمان سلامة المفتاح عند التشغيل على السيرفر
  private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  client_id: process.env.GOOGLE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.GOOGLE_CLIENT_EMAIL || '')}`,
  universe_domain: "googleapis.com"
};

// 2. إعداد عميل الـ JWT وصلاحيات الوصول لجوجل
const jwtClient = new google.auth.JWT(
  googleCredentials.client_email,
  null,
  googleCredentials.private_key,
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

  // التحقق من وجود المفتاح السري في البيئة
  if (!googleCredentials.private_key) {
    return res.status(500).json({ success: false, error: "فشل في تحميل مفاتيح الاعتماد السرية من السيرفر." });
  }

  console.log(`⚡ [Sentryk Indexing Engine]: جاري بدء فهرسة ذكية لعدد (${urlsToProcess.length}) رابط...`);

  const results = [];
  
  // معالجة الروابط لضمان استقرار الطلبات
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
