/*
  Warnings:

  - You are about to drop the `cms_owner_profiles` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "cms_owner_profiles" DROP CONSTRAINT "cms_owner_profiles_company_id_fkey";

-- DropTable
DROP TABLE "cms_owner_profiles";
