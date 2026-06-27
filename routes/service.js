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

// الخيار الأول: قراءة ملف الـ JSON الخارجي من الجذر (Root)
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
      authMode = 'EXTERNAL_JSON_FILE';
    }
  } catch (fileError) {
    console.error(`❌ [Sentryk Indexing Engine]: فشل في تحليل ملف service-account.json الخارجي:`, fileError.message);
  }
}

// الخيار الثاني والبديل الإستراتيجي: إذا لم يتواجد الملف، يتم تحميل البيانات يدوياً ومباشرة من داخل الكود
if (!googleCredentials) {
  console.log(`⚠️ [Sentryk Indexing Engine]: لم يتم العثور على ملف خارجي صالحة. جاري التحميل من البيانات المدمجة يدويًا...`);
  
  googleCredentials = {
    client_email: "indexing-bot@sentryk2026.iam.gserviceaccount.com",
    private_key: `-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDNZ4boHt5pmVWB\nIEbJK8QoCQqg6hngCnl83cH12/ztFv6Mopo/xDyOV6Y/1bl67e4PIReAkQjRR8bL\nodC0hzd8LPGoY3K42ye7n7Mbta1YbVi56orT+6kDagfTiIdvB4AMbdQjvTm8Dp6g\nk2+Kdj9QYeTqhSsdSb3D4it/4vKEjuqeUyhwBhCpktIukUss1tdD63thcJWBaZu/\nOW2Q0PpiNtqRDbOcnmHj/sV17xIyaaLwQyk9q1cd77ycuh5LhnUvqMnQ4VC6vaOB\nMjHG4rqhA0YcvHVgdfAqPZt6FqW7bBEVNRdS70rdIZXRaGe79bXIrzhlemRUr9+e\nUEzi0QKDAgMBAAECggEADVxpmxm+7/GIbVDTKezN4qjL5zGzIy6rPmMSZdK8fhOb\n1TwSeoliQwQSjV5ypTtq29MUO0mz4CEiHkbVU5jkFBC8W260nK+swvidZvUHZJQg\nTF+kTiu1j8JK5gigfqlnO+e8/+IkKkZtLRbKD6Cnd6wWfubQqiQM0vwYRkZV7idb\n3T9LlU9s3qXFweZY1JWgzjwNPBSR3lkvV70K/ztlyou1SPP1qNRbLHSl09ax5umc\nXa/qz/JMiKsc1O74HJBUsfBlKO0fTKcbODhlLYrxrq3+WER0uT2no+CH/+x3GCHv\nmmpgfz4g/Y9GFD9ngjkQfMSXns+rUjb30ji0yQx7CQKBgQDyE60s2NNNISvinFqK\nm8ejyGSGGMihSK0A4wEaiiWGlBkTPppG07+aCNbjSJ28eDWwUrzGtCbH/LjdJ+9S\nPoMG2FR7ATefwUd/k61dJkIeZUEhzU3+6y8YfmasVZ+JHD0X1b8uoorb9dNQC9j6\nwq100i6f9ypneTAwzcPE9Okf1QKBgQDZN+M+30J8jCWTSqBHclhwza+0eu5WaTH2\n3Shd0Z7XEufNaFrjGVakvLhpJNGuRFnS1IPkjp2SX96RJWp4uiz4n6+j8e91LTOc\nXyjeHoxcADTmJCVwxXuijb5SBSaFfv53wWnYBHyuGLZdGbk8eXU/87w0D3k8OAVb\nCAFFWMgc9wKBgDIM22tAUT/LMfWieh3aY4Z7cj0/dovSKOLcDGheU6/lguG1udQX\nB7BjT3qikupauE8CbEFxEeubVuVy0kpg3lpV8/GSqNuA7LV15QwzUsxSBwtkFVI1\ncgFQcQ4Ejf2dNwxshyCvPqKHyu7r5CrEgXR72GP+iGfoaIxOnsFkGacZAoGBAMUp\no0zIHXMrSlf9Xqo7MeeB60AobPlmFoH6j89Im6KgeGLLm+OSdkClQ8W8M864H8fs\nOaNVh9T6y+x3R8M5SeSKHUT0LuPvGW+QOGoU1FYVoe5bVNidh/EuM1gDcMmvUY6l\nskrvF7R2neC3npkzradUtrmSafqs5r+P7odhZJJVAoGBAIfQenYpZDzL4dDq9QcA\ndg/cv9peHNY7HK0JYXQpZttEd3NEPcmaKc+KMYMAXN6WpvOrVVrr1v4jIw/+nLPI\nwMgPCD4kc8wkqLY55la+0j3YQCrh04s3U8QOnJTjQAMaP/zL2hfPKFhUF0NMO23y\nP+2Mde20Xy+ytS91rCA1Wt82\n-----END PRIVATE KEY-----\n`.replace(/\\n/g, '\n'),
  };
  authMode = 'EMBEDDED_HARDCODED_KEYS';
}

// 🔑 بناء وتكوين عميل JWT المحدث ليتوافق مع الإصدارات الجديدة كـ Object
let jwtClient = null;

if (googleCredentials && googleCredentials.client_email && googleCredentials.private_key) {
  // 🔥 [التحديث الجوهري لحل المشكلة]: تمرير البيانات داخل Object مفتاحي
  jwtClient = new google.auth.JWT({
    email: googleCredentials.client_email,
    key: googleCredentials.private_key,
    scopes: ['https://www.googleapis.com/auth/indexing']
  });
  console.log(`✅ [Sentryk Indexing Engine]: تم تشغيل وتأمين نظام الفهرسة بنجاح عبر وضع [${authMode}].`);
} else {
  console.error(`❌ [Sentryk Indexing Engine]: خطأ حرج! فشل بناء عميل مفاتيح الاعتماد بالكامل.`);
}

/**
 * 🚀 دالة داخلية لإرسال الرابط الواحد لجوجل عبر بروتوكول الـ JWT المعتمد
 */
async function sendToGoogle(url, type = 'URL_UPDATED') {
  if (!jwtClient) {
    throw new Error("لم يتم تهيئة مفاتيح Google API بشكل صحيح على السيرفر.");
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
 * 📡 الـ Endpoint الرئيسي لفهرسة الروابط اللحظية
 * المسار: POST /api/indexing/request-instant
 */
router.post('/request-instant', async (req, res) => {
  const { url, urls, type = 'URL_UPDATED' } = req.body;

  let urlsToProcess = [];
  if (url) urlsToProcess.push(url);
  if (urls && Array.isArray(urls)) urlsToProcess = [...urlsToProcess, ...urls];

  if (urlsToProcess.length === 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'برجاء تمرير الرابط المراد فهرسته في حقل url أو urls' 
    });
  }

  if (!jwtClient) {
    return res.status(500).json({ 
      success: false, 
      error: "فشل نظام المصادقة الداخلي للسيرفر. تواصل مع مسؤول النظام." 
    });
  }

  console.log(`⚡ [Sentryk Indexing Engine]: جاري بدء فهرسة ذكية لعدد (${urlsToProcess.length}) رابط...`);

  const results = [];
  
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
