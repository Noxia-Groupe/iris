-- Lot pilote 4 suite, décisions de Nelson des 22 et 23-10-2026 : un devis converti en deux choses
-- parmi chantier, intervention et contrat de maintenance ; annulation du devis en cascade.
-- Aucune reprise de données (règle 4) : chaque dossier n'a aujourd'hui qu'une conversion, qui prend
-- le rang 1 par défaut.

-- Une affaire (dossier) se convertit au plus deux fois, en deux cibles de types différents : un
-- type par dossier et par devis, et un rang 1 ou 2 unique par dossier. L'application contrôle ces
-- règles sous le verrou du devis ; la base les garantit si deux écritures se croisaient malgré tout.
DROP INDEX "DevisConversion_devisId_key";
DROP INDEX "DevisConversion_dossierId_key";

ALTER TABLE "DevisConversion" ADD COLUMN     "rang" INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX "DevisConversion_devisId_cibleType_key" ON "DevisConversion"("devisId", "cibleType");
CREATE UNIQUE INDEX "DevisConversion_dossierId_cibleType_key" ON "DevisConversion"("dossierId", "cibleType");
CREATE UNIQUE INDEX "DevisConversion_dossierId_rang_key" ON "DevisConversion"("dossierId", "rang");

ALTER TABLE "DevisConversion" ADD CONSTRAINT "DevisConversion_rang_check" CHECK ("rang" IN (1, 2));
ALTER TABLE "DevisConversion" ADD CONSTRAINT "DevisConversion_cibleType_check" CHECK ("cibleType" IN ('CHANTIER', 'INTERVENTION', 'CONTRAT'));

-- Contrat de maintenance annulé avec le devis dont il est issu : statut ANNULE, avec la date,
-- l'auteur et le motif, exigés ensemble (un motif fait d'espaces ne compte pas) ; un contrat qui
-- n'est pas annulé n'en porte aucun.
ALTER TABLE "ContratMaintenance" ADD COLUMN     "annuleLe" TIMESTAMP(3),
ADD COLUMN     "annuleParId" TEXT,
ADD COLUMN     "motifAnnulation" TEXT;

ALTER TABLE "ContratMaintenance" ADD CONSTRAINT "ContratMaintenance_annulation_check"
  CHECK (
    ("statut" = 'ANNULE' AND "annuleLe" IS NOT NULL AND "annuleParId" IS NOT NULL AND "motifAnnulation" IS NOT NULL AND btrim("motifAnnulation") <> '')
    OR ("statut" <> 'ANNULE' AND "annuleLe" IS NULL AND "annuleParId" IS NULL AND "motifAnnulation" IS NULL)
  );

-- L'annulation est terminale : un contrat annulé ne se modifie plus (ni statut, ni couverture, ni
-- échéance). Seule une suppression reste possible, que l'application n'offre pas ; le nettoyage
-- d'une base jetable de test en a besoin.
CREATE FUNCTION figer_contrat_annule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."statut" = 'ANNULE' THEN
    RAISE EXCEPTION 'Contrat de maintenance annulé : il ne se modifie plus.';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER contrat_annule_fige BEFORE UPDATE ON "ContratMaintenance"
FOR EACH ROW EXECUTE FUNCTION figer_contrat_annule();
