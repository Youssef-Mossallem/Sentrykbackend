/*
  Warnings:

  - You are about to alter the column `amount` on the `SmsTransaction` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Integer`.
  - You are about to alter the column `balance` on the `SmsWallet` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Integer`.
  - A unique constraint covering the columns `[paymobIntentionId]` on the table `Payment` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "merchantReference" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "paymobIntentionId" TEXT,
ALTER COLUMN "paymentMethod" SET DEFAULT 'PAYMOB_FLASH';

-- AlterTable
ALTER TABLE "SmsTransaction" ALTER COLUMN "amount" SET DATA TYPE INTEGER;

-- AlterTable
ALTER TABLE "SmsWallet" ALTER COLUMN "balance" SET DEFAULT 0,
ALTER COLUMN "balance" SET DATA TYPE INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_paymobIntentionId_key" ON "Payment"("paymobIntentionId");
