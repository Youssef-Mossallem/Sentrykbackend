/*
  Warnings:

  - You are about to drop the column `teacherId` on the `SubscriptionItem` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[subscriptionId,sessionId]` on the table `SubscriptionItem` will be added. If there are existing duplicate values, this will fail.
  - Made the column `maxStudents` on table `Room` required. This step will fail if there are existing NULL values in that column.
  - Made the column `maxStudents` on table `Session` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `sessionId` to the `SubscriptionItem` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "SubscriptionItem" DROP CONSTRAINT "SubscriptionItem_teacherId_fkey";

-- AlterTable
ALTER TABLE "Room" ALTER COLUMN "maxStudents" SET NOT NULL,
ALTER COLUMN "maxStudents" SET DEFAULT 60;

-- AlterTable
ALTER TABLE "Session" ALTER COLUMN "maxStudents" SET NOT NULL;

-- AlterTable
ALTER TABLE "SubscriptionItem" DROP COLUMN "teacherId",
ADD COLUMN     "sessionId" INTEGER NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionItem_subscriptionId_sessionId_key" ON "SubscriptionItem"("subscriptionId", "sessionId");

-- AddForeignKey
ALTER TABLE "SubscriptionItem" ADD CONSTRAINT "SubscriptionItem_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
