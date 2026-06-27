/*
  Warnings:

  - You are about to drop the column `groupId` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `subjectId` on the `SubscriptionItem` table. All the data in the column will be lost.
  - You are about to drop the `Group` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Subject` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SubjectPrice` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[qrToken]` on the table `Student` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `grade` to the `Student` table without a default value. This is not possible if the table is not empty.
  - The required column `qrToken` was added to the `Student` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - Added the required column `teacherId` to the `SubscriptionItem` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE');

-- AlterEnum
ALTER TYPE "SubscriptionType" ADD VALUE 'PER_SESSION';

-- DropForeignKey
ALTER TABLE "Group" DROP CONSTRAINT "Group_centerId_fkey";

-- DropForeignKey
ALTER TABLE "Group" DROP CONSTRAINT "Group_parentGroupId_fkey";

-- DropForeignKey
ALTER TABLE "Student" DROP CONSTRAINT "Student_groupId_fkey";

-- DropForeignKey
ALTER TABLE "Subject" DROP CONSTRAINT "Subject_centerId_fkey";

-- DropForeignKey
ALTER TABLE "SubjectPrice" DROP CONSTRAINT "SubjectPrice_subjectId_fkey";

-- DropForeignKey
ALTER TABLE "SubscriptionItem" DROP CONSTRAINT "SubscriptionItem_subjectId_fkey";

-- AlterTable
ALTER TABLE "Student" DROP COLUMN "groupId",
ADD COLUMN     "grade" INTEGER NOT NULL,
ADD COLUMN     "qrToken" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "SubscriptionItem" DROP COLUMN "subjectId",
ADD COLUMN     "teacherId" INTEGER NOT NULL;

-- DropTable
DROP TABLE "Group";

-- DropTable
DROP TABLE "Subject";

-- DropTable
DROP TABLE "SubjectPrice";

-- CreateTable
CREATE TABLE "Room" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "maxStudents" INTEGER,
    "centerId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Teacher" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "phone" TEXT,
    "centerId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Teacher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "teacherId" INTEGER NOT NULL,
    "roomId" INTEGER NOT NULL,
    "days" TEXT[],
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "maxStudents" INTEGER,
    "stage" "Stage" NOT NULL,
    "grade" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceConfiguration" (
    "id" SERIAL NOT NULL,
    "teacherId" INTEGER NOT NULL,
    "stage" "Stage" NOT NULL,
    "grades" INTEGER[],
    "subscriptionType" "SubscriptionType" NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyReportLog" (
    "id" SERIAL NOT NULL,
    "studentId" INTEGER NOT NULL,
    "centerId" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "totalPresent" INTEGER NOT NULL,
    "totalAbsent" INTEGER NOT NULL,
    "totalLate" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,

    CONSTRAINT "MonthlyReportLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" SERIAL NOT NULL,
    "studentId" INTEGER NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "centerId" INTEGER NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "scannedAt" TIMESTAMP(3),
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "autoMarked" BOOLEAN NOT NULL DEFAULT false,
    "windowId" INTEGER,
    "markedBySystem" BOOLEAN NOT NULL DEFAULT false,
    "lateMinutes" INTEGER,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionAttendanceWindow" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "autoCloseMinutes" INTEGER NOT NULL DEFAULT 10,
    "manualClosedBy" INTEGER,

    CONSTRAINT "SessionAttendanceWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceScan" (
    "id" SERIAL NOT NULL,
    "studentId" INTEGER NOT NULL,
    "centerId" INTEGER NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonthlyReportLog_centerId_idx" ON "MonthlyReportLog"("centerId");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyReportLog_studentId_month_year_key" ON "MonthlyReportLog"("studentId", "month", "year");

-- CreateIndex
CREATE INDEX "Attendance_sessionId_idx" ON "Attendance"("sessionId");

-- CreateIndex
CREATE INDEX "Attendance_status_idx" ON "Attendance"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_studentId_sessionId_key" ON "Attendance"("studentId", "sessionId");

-- CreateIndex
CREATE INDEX "SessionAttendanceWindow_date_idx" ON "SessionAttendanceWindow"("date");

-- CreateIndex
CREATE INDEX "SessionAttendanceWindow_isClosed_idx" ON "SessionAttendanceWindow"("isClosed");

-- CreateIndex
CREATE UNIQUE INDEX "SessionAttendanceWindow_sessionId_date_key" ON "SessionAttendanceWindow"("sessionId", "date");

-- CreateIndex
CREATE INDEX "AttendanceScan_studentId_idx" ON "AttendanceScan"("studentId");

-- CreateIndex
CREATE INDEX "AttendanceScan_centerId_idx" ON "AttendanceScan"("centerId");

-- CreateIndex
CREATE INDEX "AttendanceScan_scannedAt_idx" ON "AttendanceScan"("scannedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Student_qrToken_key" ON "Student"("qrToken");

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceConfiguration" ADD CONSTRAINT "PriceConfiguration_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyReportLog" ADD CONSTRAINT "MonthlyReportLog_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyReportLog" ADD CONSTRAINT "MonthlyReportLog_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionItem" ADD CONSTRAINT "SubscriptionItem_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "SessionAttendanceWindow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionAttendanceWindow" ADD CONSTRAINT "SessionAttendanceWindow_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceScan" ADD CONSTRAINT "AttendanceScan_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceScan" ADD CONSTRAINT "AttendanceScan_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;
