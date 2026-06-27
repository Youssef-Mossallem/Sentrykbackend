const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// ==========================================
// 🛠️ إعداد واعتماد مفاتيح الوصول (Authentication Factory)
// ==========================================

let googleCredentials = null;
let authMode = 'NONE';

// 1. محاولة التحميل من متغيرات البيئة (Environment Variables) أولاً
if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  googleCredentials = {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
  authMode = 'ENV';
} 
// 2. خطة البديل الإستراتيجي (Fallback): قراءة ملف الـ JSON من الجذر (Root)
else {
  // الخروج خطوة للخلف لأن هذا الملف داخل مجلد 'routes' والملف المطلوب في الـ Root
  const jsonPath = path.join(__dirname, '..', 'service-account.json');

  if (fs.existsSync(jsonPath)) {
    try {
      const rawData = fs.readFileSync(jsonPath, 'utf8');
      const serviceAccount = JSON.parse(rawData);
      
      if (serviceAccount.client_email && serviceAccount.private_key) {
        googleCredentials = {
          client_email: serviceAccount.client_email,
          private_key: serviceAccount.private_key.replace(/\\n/g, '\n'),
        };
        authMode = 'JSON_FILE';
      }
    } catch (fileError) {
      console.error(`❌ [Sentryk Indexing Engine]: فشل في تحليل ملف service-account.json:`, fileError.message);
    }
  }
}

// 3. بناء وتكوين عميل JWT بناءً على البيانات المتوفرة (بدون تفجير السيرفر في حال عدم وجودها)
let jwtClient = null;

if (googleCredentials) {
  jwtClient = new google.auth.JWT(
    googleCredentials.client_email,
    null,
    googleCredentials.private_key,
    ['https://www.googleapis.com/auth/indexing'],
    null
  );
  console.log(`✅ [Sentryk Indexing Engine]: تم تحميل الاعتمادات بنجاح عبر نظام [${authMode}].`);
} else {
  console.warn(`⚠️ [Sentryk Indexing Engine]: تحذير! لم يتم العثور على مفاتيح اعتماد صالحة في الـ ENV أو في ملف JSON الخارجي. الطلبات ستفشل برمجياً عند استدعائها.`);
}

/**
 * 🚀 دالة داخلية ذكية لإرسال الرابط الواحد لجوجل
 */
async function sendToGoogle(url, type = 'URL_UPDATED') {
  if (!jwtClient) {
    throw new Error("لم يتم تهيئة مفاتيح Google API بشكل صحيح على السيرفر (مفقودة في الـ ENV والملف الخارجي).");
  }
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

  // فحص حالة العميل قبل بدء العمليات الطويلة (Early Return لمنع استهلاك الموارد)
  if (!jwtClient) {
    return res.status(500).json({ 
      success: false, 
      error: "فشل في تحميل مفاتيح الاعتماد السرية من السيرفر. تأكد من إعداد متغيرات البيئة أو إدخال ملف service-account.json في الجذر الرئيسي." 
    });
  }

  console.log(`⚡ [Sentryk Indexing Engine]: جاري بدء فهرسة ذكية لعدد (${urlsToProcess.length}) رابط...`);

  const results = [];
  
  // معالجة الروابط لضمان استقرار الطلبات (Sequential Execution Trace)
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
      failedCount: totalFailed,
      authMethodUsed: authMode
    },
    results
  });
});

module.exports = router;
