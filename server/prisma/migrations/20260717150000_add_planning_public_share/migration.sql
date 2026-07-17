-- CreateTable
CREATE TABLE "PlanningPublicShare" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "token" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanningPublicShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanningPublicShare_token_key" ON "PlanningPublicShare"("token");

