-- Lot 6a-4e : envoi du rapport de chantier remis au client (PDF du lot 6a-4c, sans montant ni heures)
-- par la messagerie de l'utilisateur (choix par défaut, à confirmer). Le journal des envois du lot 6a-3
-- (migration 20261023120000), étendu par le lot 6a-4d (migration 20261031120000), s'étend au rapport
-- de chantier, sans être recréé : une colonne facultative, avec sa clé étrangère et son index, et la
-- contrainte « exactement un document » sur cinq colonnes.
--
-- Les trois déclencheurs du journal restent en place, ni supprimés ni recréés, et s'appliquent aux
-- nouvelles lignes : envoi_document_ajout_seul (ni modification ni suppression), envoi_document_sans_vidage
-- (ni vidage) et envoi_document_horodatage (horodatage imposé par la base). Le canal reste MESSAGERIE seul.
--
-- Les lignes existantes portent un devis, une facture, une intervention ou un contrat de maintenance :
-- la colonne ajoutée y reste vide, sans réécriture ni déclencheur de ligne, et la contrainte recréée
-- les accepte telles quelles.
ALTER TABLE "EnvoiDocument" ADD COLUMN "chantierId" TEXT;

-- Exactement un document : un devis, une facture (un avoir est une facture de type AVOIR), une
-- intervention (son compte rendu), un contrat de maintenance ou un chantier (son rapport remis au
-- client). Même nom que celle des lots 6a-3 et 6a-4d.
ALTER TABLE "EnvoiDocument" DROP CONSTRAINT "EnvoiDocument_un_document";
ALTER TABLE "EnvoiDocument" ADD CONSTRAINT "EnvoiDocument_un_document" CHECK (num_nonnulls("devisId", "factureId", "interventionId", "contratMaintenanceId", "chantierId") = 1);

CREATE INDEX "EnvoiDocument_chantierId_createdAt_idx" ON "EnvoiDocument"("chantierId", "createdAt");

-- Un chantier qui porte un envoi ne se supprime pas : le journal garde son document. Un chantier ne se
-- supprime déjà pas par l'API (410) ; la base le garantit en plus pour un chantier envoyé.
-- ON UPDATE CASCADE reste celui de Prisma, comme pour les autres documents ; changer l'identifiant
-- d'un chantier envoyé est refusé par le déclencheur envoi_document_ajout_seul, qui refuse toute
-- modification d'une ligne du journal.
ALTER TABLE "EnvoiDocument" ADD CONSTRAINT "EnvoiDocument_chantierId_fkey" FOREIGN KEY ("chantierId") REFERENCES "Chantier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
