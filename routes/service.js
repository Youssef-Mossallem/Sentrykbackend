const express = require('express');
const { google } = require('googleapis');

const router = express.Router();

// ==========================================
// 🔑 إعداد واعتماد مفاتيح الوصول الداخلية (Hardcoded Engine)
// ==========================================

const authMode = 'EMBEDDED_HARDCODED_KEYS';

// البيانات الجديدة مدمجة كلياً هنا (تم الاستغناء تماماً عن الملفات الخارجية ومتغيرات البيئة)
const googleCredentials = {
  client_email: "indexing-bot@sentryk2026.iam.gserviceaccount.com",
  private_key: `-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDW97s3giI+BU9W\nBfSEUBxIrLvH56+HCyIQu7XD92zdAwb1MHSLRu43ysuAgbXGDKq6LEqaDCjpREsg\nc4gH9tcR8BVUdhoOMVxsP6RSvI6jSHkcXxRGhfCe0tw7a5J3kI6ppR0h7p8kELqC\n5qoDf/i0vF5PfLQzHWBaqmwyxs0kXlz8M+sTr+QMAtK/nz7mZVXa1E8uzfxEcQ3z\nxhwCPFf0h5SNIueQs+IhqrlYhIFR/6OyBQCSIB2jhVkDy905LoN5K4PPjZLcR0u6\nPRiILYAQNr5kPXYeOHbAEAC3/lZQauS2MnXDJAOEW6VY9dQukLhmQeQKaa/fy83h\nBPUhE6FBAgMBAAECggEAVLd5kRUYcI/AJdsf81rs4pksQcplKtew255WMj4aqXjt\nb4hijZbs/5DMpT65B61rRQZ6ef4ry04uO0I8jELznC6dAVWvzAMY9NIZ7L9BiUjg\n7dTslSRo4Pahc0tgA/20s1eORRaYoepzzm2f99Qhi/ymQDYZgAFmPSTnkhU1uEw8\n5v5Vn+Fw7+lgkbHatDXU6czBSsNr6LLXOR0p7BgeaDUK9oS148/4HgbiW13ZU+Eg\n/J1Ri90QauQr7CPiw7aQuEn04v3KB1f//suI1aXvRoYHIFgRie6dpAxBZTBjOOoV\n+V9InJq/JWSWK54VTFag3ij3gwH4tTVA/SYq8caKJwKBgQDxjuFGQu7UrOjj+qNZ\nFZnpu+tcPA8G8AVHUun+FhEPMKAAxLNebPRzCngsc3Ts17oB11c5Vkl44PWgK+Az\nmennXfd51g3CQZcyNzAMJ2+es+YKQ4G3QQa6OoznxNso5DiGjpdwFklMqyQZF/DP\n533glw7Y+mewGe1pVxT8+RdcWwKBgQDj0eB6KY8uHWCR9WJ2VzHj+ChcDdK7GyHy\noLecZqZ0Y6pUcfjqb02B0HN+kIo328GRNGnPhzjxNgeGNdU5E4lVsEHFKqaVymOB\xb41Kye9hkT2IzWdHSyWIY0saY/qv0U5795I2rVRrmAYzYxYTT1SzGu1OwVOvAL+\n1/FOeYQbkwKBgH0n7oic/Wmr/S7CGgh6LLjx6MxtQcvyaIm/6AUCIeyg4QYE5Hq0\MSO59PHzEE32qCV0EXlfv8mlpR5MHWofARYjlanGwnI30cLu3TIu7KJpy3Ld70On\nqXisBX3AfVz+glsVXllw8qGKurVVtivCYXIQUl0RwM95X40I1ZMM7JGpAoGBAKIJ\nQ8T/zDO7d1U5F+gdyoFfnq0is9Ca0sF0aEPYiunbfWmEisuLkLAVKCBMA9MI/Zse\nkWemwOxnRmDB5z8qUxLcQ1tOI6AEjFPf5pKAeEqHtoLuthJijrTVdkixaEhJ9J3p\nstcq3xGL1lU0U542XYLqUwEh5jhhqvlwV7UdQ77AoGBALNlI2Lh30DJIdPMO93g\nKcqEdHDplWD5GIAh+bGlVqDUCWHYWqkn7Lu/l3+1lBWEMyy0Bt/9mUxPcxGF6QDI\nXQBcAHYnzRtlqmoJ96Y/0tIVHh3hxInpAd0b7kCe2gKWVyGXMrSaTf5C6Dorl9gv\nYXHPmlhLGl8iq0EXYgiWWmxR\n-----END PRIVATE KEY-----\n`.replace(/\\n/g, '\n')
};

// بناء عميل المصادقة المحدث Object-based
let jwtClient = new google.auth.JWT({
  email: googleCredentials.client_email,
  key: googleCredentials.private_key,
  scopes: ['https://www.googleapis.com/auth/indexing']
});

console.log(`✅ [Sentryk Indexing Engine]: تم تشغيل المصادقة الداخلية الحصرية بنجاح [${authMode}].`);

/**
 * 🚀 دالة إرسال الرابط الفردي لجوجل
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

  console.log(`⚡ [Sentryk Indexing Engine]: جاري بدء الفهرسة الحصرية لعدد (${urlsToProcess.length}) رابط...`);

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
