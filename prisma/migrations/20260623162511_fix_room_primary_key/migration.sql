-- AlterTable
ALTER TABLE "Center" ADD COLUMN     "activePromoCodeId" INTEGER,
ADD COLUMN     "promoAppliedAt" TIMESTAMP(3),
ADD COLUMN     "promoMonthsUsed" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "Center" ADD CONSTRAINT "Center_activePromoCodeId_fkey" FOREIGN KEY ("activePromoCodeId") REFERENCES "PromoCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
