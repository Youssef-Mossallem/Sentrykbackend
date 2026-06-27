/*
  Warnings:

  - A unique constraint covering the columns `[studentId,windowId]` on the table `Attendance` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Attendance_studentId_sessionId_key";

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_studentId_windowId_key" ON "Attendance"("studentId", "windowId");
