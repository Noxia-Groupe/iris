-- Lot 6a-4d : envoi du compte rendu d'intervention et du contrat de maintenance par la messagerie de
-- l'utilisateur (choix par défaut, à confirmer). Le journal des envois du lot 6a-3 (migration
-- 20261023120000) s'étend à ces deux documents, sans être recréé : deux colonnes facultatives, chacune
-- avec sa clé étrangère et son index, et la contrainte « exactement un document » sur quatre colonnes.
--
-- Les trois déclencheurs du journal restent en place, ni supprimés ni recréés, et s'appliquent aux
-- nouvelles lignes : envoi_document_ajout_seul (ni modification ni suppression), envoi_document_sans_vidage
-- (ni vidage) et envoi_document_horodatage (horodatage imposé par la base). Le canal reste MESSAGERIE seul.
--
-- Les lignes existantes portent un devis ou une facture : les deux colonnes ajoutées y restent vides,
-- sans réécriture ni déclencheur de ligne, et la contrainte recréée les accepte telles quelles.
ALTER TABLE "EnvoiDocument" ADD COLUMN "interventionId" TEXT;
ALTER TABLE "EnvoiDocument" ADD COLUMN "contratMaintenanceId" TEXT;

-- Exactement un document : un devis, une facture (un avoir est une facture de type AVOIR), une
-- intervention (son compte rendu) ou un contrat de maintenance. Même nom que celle du lot 6a-3.
-- L'envoi du rapport de chantier viendra avec le lot 6a-4e et sa propre migration.
ALTER TABLE "EnvoiDocument" DROP CONSTRAINT "EnvoiDocument_un_document";
ALTER TABLE "EnvoiDocument" ADD CONSTRAINT "EnvoiDocument_un_document" CHECK (num_nonnulls("devisId", "factureId", "interventionId", "contratMaintenanceId") = 1);

CREATE INDEX "EnvoiDocument_interventionId_createdAt_idx" ON "EnvoiDocument"("interventionId", "createdAt");
CREATE INDEX "EnvoiDocument_contratMaintenanceId_createdAt_idx" ON "EnvoiDocument"("contratMaintenanceId", "createdAt");

-- Une intervention ou un contrat qui porte un envoi ne se supprime pas : le journal garde son document.
-- ON UPDATE CASCADE reste celui de Prisma, comme pour le devis et la facture ; changer l'identifiant
-- d'un document envoyé est refusé par le déclencheur envoi_document_ajout_seul, qui refuse toute
-- modification d'une ligne du journal.
ALTER TABLE "EnvoiDocument" ADD CONSTRAINT "EnvoiDocument_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EnvoiDocument" ADD CONSTRAINT "EnvoiDocument_contratMaintenanceId_fkey" FOREIGN KEY ("contratMaintenanceId") REFERENCES "ContratMaintenance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
