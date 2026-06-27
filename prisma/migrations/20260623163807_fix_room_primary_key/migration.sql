-- AlterTable
ALTER TABLE "Center" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "isPromoPaused" BOOLEAN NOT NULL DEFAULT false;
