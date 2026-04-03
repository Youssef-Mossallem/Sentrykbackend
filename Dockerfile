# استخدام نسخة Node مستقرة
FROM node:18

# تحديد مجلد العمل داخل الحاوية
WORKDIR /app

# نسخ ملفات الـ package
COPY package*.json ./
COPY prisma ./prisma/

# تثبيت المكتبات
RUN npm install

# توليد ملفات Prisma Client
RUN npx prisma generate

# نسخ باقي ملفات المشروع
COPY . .

# تحديد البورت
EXPOSE 3000

# أمر التشغيل
CMD ["node", "index.js"]
