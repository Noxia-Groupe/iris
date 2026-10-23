-- Lot 6a-3 : envoi d'un devis ou d'une facture par la messagerie de l'utilisateur, et journal des
-- envois (choix par défaut, à confirmer). Iris prépare le courriel (lien mailto, le PDF étant
-- téléchargé en même temps et joint à la main) sans savoir s'il est parti : chaque ligne dit qu'un
-- envoi a été préparé, pour quel document, à qui, sous quel objet et par quel compte.
--
-- Le journal est en ajout seul, garanti en base comme le journal des factures et les comptes rendus
-- d'intervention : ni modification, ni suppression, ni vidage ; l'horodatage est imposé par la base.
-- Le compte n'a pas de clé étrangère (comme JournalFacture.acteurId) : son nom est copié à
-- l'enregistrement, et le journal reste lisible si le compte est renommé ou supprimé.
CREATE TABLE "EnvoiDocument" (
    "id" TEXT NOT NULL,
    "devisId" TEXT,
    "factureId" TEXT,
    "canal" TEXT NOT NULL,
    "destinataire" TEXT NOT NULL,
    "objet" TEXT NOT NULL,
    "auteurId" TEXT NOT NULL,
    "auteurNom" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvoiDocument_pkey" PRIMARY KEY ("id"),
    -- Exactement un document : un devis, ou une facture (un avoir est une facture de type AVOIR).
    CONSTRAINT "EnvoiDocument_un_document" CHECK (num_nonnulls("devisId", "factureId") = 1),
    -- Seul canal d'aujourd'hui ; le lot 6b ajoutera MICROSOFT_365 par une nouvelle migration.
    CONSTRAINT "EnvoiDocument_canal" CHECK ("canal" IN ('MESSAGERIE')),
    CONSTRAINT "EnvoiDocument_destinataire_renseigne" CHECK (btrim("destinataire") <> ''),
    CONSTRAINT "EnvoiDocument_objet_renseigne" CHECK (btrim("objet") <> ''),
    CONSTRAINT "EnvoiDocument_auteur_nomme" CHECK (btrim("auteurNom") <> '')
);

CREATE INDEX "EnvoiDocument_devisId_createdAt_idx" ON "EnvoiDocument"("devisId", "createdAt");
CREATE INDEX "EnvoiDocument_factureId_createdAt_idx" ON "EnvoiDocument"("factureId", "createdAt");

-- Un devis ou une facture qui porte un envoi ne se supprime pas : le journal garde son document.
-- ON UPDATE CASCADE reste celui de Prisma ; changer l'identifiant d'un document envoyé est refusé
-- par le garde ci-dessous, qui refuse toute modification d'une ligne du journal.
ALTER TABLE "EnvoiDocument" ADD CONSTRAINT "EnvoiDocument_devisId_fkey" FOREIGN KEY ("devisId") REFERENCES "Devis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EnvoiDocument" ADD CONSTRAINT "EnvoiDocument_factureId_fkey" FOREIGN KEY ("factureId") REFERENCES "Facture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Ajout seul : une ligne du journal ne se modifie ni ne se supprime.
CREATE FUNCTION refuser_modification_envoi_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Journal des envois : ajout seul, un envoi enregistré ne se modifie ni ne se supprime.';
END $$;

CREATE TRIGGER envoi_document_ajout_seul BEFORE UPDATE OR DELETE ON "EnvoiDocument"
FOR EACH ROW EXECUTE FUNCTION refuser_modification_envoi_document();

-- TRUNCATE ne déclenche pas les triggers de ligne : le vidage est refusé à part, avec la fonction de
-- la migration 20261019120000, dont le message nomme la table refusée.
CREATE TRIGGER envoi_document_sans_vidage BEFORE TRUNCATE ON "EnvoiDocument"
FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_sans_suppression();

-- Horodatage imposé par la base, comme pour les comptes rendus d'intervention (migration
-- 20261020140000) : une ligne figée dès son insertion ne pourrait plus corriger une date fournie
-- par l'application.
CREATE FUNCTION horodater_envoi_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER envoi_document_horodatage BEFORE INSERT ON "EnvoiDocument"
FOR EACH ROW EXECUTE FUNCTION horodater_envoi_document();
