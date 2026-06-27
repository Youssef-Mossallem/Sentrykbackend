-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "billingCycle" "BillingCycle",
ADD COLUMN     "durationMonths" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "planPrice" DOUBLE PRECISION,
ADD COLUMN     "processedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Payment_merchantReference_idx" ON "Payment"("merchantReference");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");
