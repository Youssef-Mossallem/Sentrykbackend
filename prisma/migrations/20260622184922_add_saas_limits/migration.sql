/*
  Warnings:

  - Changed the type of `stage` on the `Student` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY', 'BOTH');

-- AlterTable
ALTER TABLE "Center" ADD COLUMN     "maxStudents" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "maxUsers" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "referralMilestoneAchieved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "referredById" INTEGER;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "promoCodeId" INTEGER;

-- AlterTable
ALTER TABLE "Student" DROP COLUMN "stage",
ADD COLUMN     "stage" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "PromoCode" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "discountPercent" DOUBLE PRECISION NOT NULL,
    "durationMonths" INTEGER NOT NULL DEFAULT 1,
    "applicableCycle" "BillingCycle" NOT NULL DEFAULT 'BOTH',
    "maxUses" INTEGER NOT NULL DEFAULT 100,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_code_key" ON "PromoCode"("code");

-- CreateIndex
CREATE INDEX "PromoCode_code_idx" ON "PromoCode"("code");

-- AddForeignKey
ALTER TABLE "Center" ADD CONSTRAINT "Center_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "Center"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
