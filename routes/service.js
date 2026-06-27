const express = require('express');
const { google } = require('googleapis');

const router = express.Router();

// ==========================================
// 🔑 إعداد وتأمين مفاتيح الوصول الداخلية الحصرية
// ==========================================

const authMode = 'EMBEDDED_HARDCODED_KEYS';

// تفكيك المفتاح الجديد لأسطر صريحة لحل مشكلة الـ Decoder تماماً وبشكل جذري
const cleanPrivateKey = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDW97s3giI+BU9W",
  "BfSEUBxIrLvH56+HCyIQu7XD92zdAwb1MHSLRu43ysuAgbXGDKq6LEqaDCjpREsg",
  "c4gH9tcR8BVUdhoOMVxsP6RSvI6jSHkcXxRGhfCe0tw7a5J3kI6ppR0h7p8kELqC",
  "5qoDf/i0vF5PfLQzHWBaqmwyxs0kXlz8M+sTr+QMAtK/nz7mZVXa1E8uzfxEcQ3z",
  "xhwCPFf0h5SNIueQs+IhqrlYhIFR/6OyBQCSIB2jhVkDy905LoN5K4PPjZLcR0u6",
  "PRiILYAQNr5kPXYeOHbAEAC3/lZQauS2MnXDJAOEW6VY9dQukLhmQeQKaa/fy83h",
  "BPUhE6FBAgMBAAECggEAVLd5kRUYcI/AJdsf81rs4pksQcplKtew255WMj4aqXjt",
  "b4hijZbs/5DMpT65B61rRQZ6ef4ry04uO0I8jELznC6dAVWvzAMY9NIZ7L9BiUjg",
  "7dTslSRo4Pahc0tgA/20s1eORRaYoepzzm2f99Qhi/ymQDYZgAFmPSTnkhU1uEw8",
  "5v5Vn+Fw7+lgkbHatDXU6czBSsNr6LLXOR0p7BgeaDUK9oS148/4HgbiW13ZU+Eg",
  "/J1Ri90QauQr7CPiw7aQuEn04v3KB1f//suI1aXvRoYHIFgRie6dpAxBZTBjOOoV",
  "+V9InJq/JWSWK54VTFag3ij3gwH4tTVA/SYq8caKJwKBgQDxjuFGQu7UrOjj+qNZ",
  "FZnpu+tcPA8G8AVHUun+FhEPMKAAxLNebPRzCngsc3Ts17oB11c5Vkl44PWgK+Az",
  "mennXfd51g3CQZcyNzAMJ2+es+YKQ4G3QQa6OoznxNso5DiGjpdwFklMqyQZF/DP",
  "533glw7Y+mewGe1pVxT8+RdcWwKBgQDj0eB6KY8uHWCR9WJ2VzHj+ChcDdK7GyHy",
  "oLecZqZ0Y6pUcfjqb02B0HN+kIo328GRNGnPhzjxNgeGNdU5E4lVsEHFKqaVymOB",
  "xb41Kye9hkT2IzWdHSyWIY0saY/qv0U5795I2rVRrmAYzYxYTT1SzGu1OwVOvAL+",
  "1/FOeYQbkwKBgH0n7oic/Wmr/S7CGgh6LLjx6MxtQcvyaIm/6AUCIeyg4QYE5Hq0",
  "MSO59PHzEE32qCV0EXlfv8mlpR5MHWofARYjlanGwnI30cLu3TIu7KJpy3Ld70On",
  "qXisBX3AfVz+glsVXllw8qGKurVVtivCYXIQUl0RwM95X40I1ZMM7JGpAoGBAKIJ",
  "Q8T/zDO7d1U5F+gdyoFfnq0is9Ca0sF0aEPYiunbfWmEisuLkLAVKCBMA9MI/Zse",
  "kWemwOxnRmDB5z8qUxLcQ1tOI6AEjFPf5pKAeEqHtoLuthJijrTVdkixaEhJ9J3p",
  "qstcq3xGL1lU0U542XYLqUwEh5jhhqvlwV7UdQ77AoGBALNlI2Lh30DJIdPMO93g",
  "KcqEdHDplWD5GIAh+bGlVqDUCWHYWqkn7Lu/l3+1lBWEMyy0Bt/9mUxPcxGF6QDI",
  "XQBcAHYnzRtlqmoJ96Y/0tIVHh3hxInpAd0b7kCe2gKWVyGXMrSaTf5C6Dorl9gv",
  "YXHPmlhLGl8iq0EXYgiWWmxR",
  "-----END PRIVATE KEY-----"
].join('\n');

const googleCredentials = {
  client_email: "indexing-bot@sentryk2026.iam.gserviceaccount.com",
  private_key: cleanPrivateKey
};

// بناء عميل المصادقة المحدث Object-based المتوافق مع الإصدارات الحديثة
const jwtClient = new google.auth.JWT({
  email: googleCredentials.client_email,
  key: googleCredentials.private_key,
  scopes: ['https://www.googleapis.com/auth/indexing']
});

console.log(`✅ [Sentryk Indexing Engine]: تم تفعيل المحرك الحصري بنجاح [${authMode}].`);

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
