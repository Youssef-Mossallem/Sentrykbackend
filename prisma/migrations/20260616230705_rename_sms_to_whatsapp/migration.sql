/*
  Warnings:

  - You are about to drop the `SmsTransaction` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SmsWallet` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "WhatsAppTransactionType" AS ENUM ('CHARGE', 'SEND');

-- DropForeignKey
ALTER TABLE "SmsTransaction" DROP CONSTRAINT "SmsTransaction_paymentId_fkey";

-- DropForeignKey
ALTER TABLE "SmsTransaction" DROP CONSTRAINT "SmsTransaction_walletId_fkey";

-- DropForeignKey
ALTER TABLE "SmsWallet" DROP CONSTRAINT "SmsWallet_centerId_fkey";

-- DropTable
DROP TABLE "SmsTransaction";

-- DropTable
DROP TABLE "SmsWallet";

-- DropEnum
DROP TYPE "SmsTransactionType";

-- CreateTable
CREATE TABLE "WhatsAppWallet" (
    "id" SERIAL NOT NULL,
    "centerId" INTEGER NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppTransaction" (
    "id" SERIAL NOT NULL,
    "walletId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" "WhatsAppTransactionType" NOT NULL,
    "description" TEXT,
    "paymentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppWallet_centerId_key" ON "WhatsAppWallet"("centerId");

-- AddForeignKey
ALTER TABLE "WhatsAppWallet" ADD CONSTRAINT "WhatsAppWallet_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppTransaction" ADD CONSTRAINT "WhatsAppTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "WhatsAppWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppTransaction" ADD CONSTRAINT "WhatsAppTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
