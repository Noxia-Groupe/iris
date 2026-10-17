-- Lot pilote 2 (décision A8 du 16-10-2026) : lignes de devis reprises du catalogue et copiées
-- figées dans le devis, prix d'achat prévu en option.

-- Prix d'achat facultatif des prestations et des équipements, comme celui des articles.
ALTER TABLE "CataloguePrestation" ADD COLUMN "prixAchatHt" DECIMAL(12,2);
ALTER TABLE "CatalogueEquipement" ADD COLUMN "prixAchatHt" DECIMAL(12,2);
ALTER TABLE "CataloguePrestation" ADD CONSTRAINT "catalogue_prestation_prix_achat_positif" CHECK ("prixAchatHt" IS NULL OR "prixAchatHt" >= 0);
ALTER TABLE "CatalogueArticle" ADD CONSTRAINT "catalogue_article_prix_achat_positif" CHECK ("prixAchatHt" IS NULL OR "prixAchatHt" >= 0);
ALTER TABLE "CatalogueEquipement" ADD CONSTRAINT "catalogue_equipement_prix_achat_positif" CHECK ("prixAchatHt" IS NULL OR "prixAchatHt" >= 0);

-- Copie du catalogue dans la ligne : référence, unité et traçabilité de la fiche d'origine.
ALTER TABLE "DevisLigne" ADD COLUMN "unite" TEXT;
ALTER TABLE "DevisLigne" ADD COLUMN "reference" TEXT;
ALTER TABLE "DevisLigne" ADD COLUMN "catalogueFamille" TEXT;
ALTER TABLE "DevisLigne" ADD COLUMN "catalogueId" TEXT;
ALTER TABLE "DevisLigne" ADD COLUMN "prixAchatUnitaireHt" DECIMAL(12,2);
ALTER TABLE "DevisLigne" ADD CONSTRAINT "devis_ligne_catalogue_coherent" CHECK (
  ("catalogueFamille" IS NULL AND "catalogueId" IS NULL)
  OR ("catalogueFamille" IN ('prestations', 'articles', 'equipements') AND "catalogueId" IS NOT NULL AND "reference" IS NOT NULL)
);
ALTER TABLE "DevisLigne" ADD CONSTRAINT "devis_ligne_prix_achat_positif" CHECK ("prixAchatUnitaireHt" IS NULL OR "prixAchatUnitaireHt" >= 0);
ALTER TABLE "DevisLigne" ADD CONSTRAINT "devis_ligne_nature" CHECK ("nature" IN ('MAIN_OEUVRE', 'FOURNITURE'));

-- Un devis signé est un document figé (règle 2) : ses lignes ne s'ajoutent, ne se modifient
-- ni ne se suppriment plus, et son contenu (client, objet, montants, acompte exigé) ne change
-- plus. Son cycle de vie (statut, acompte constaté, annulation) reste possible. Jusqu'ici,
-- seul le code de l'API l'assurait.
CREATE FUNCTION figer_lignes_devis_signe() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (SELECT 1 FROM "DevisSignature" WHERE "devisId" = OLD."devisId") THEN
    RAISE EXCEPTION 'Devis signé : ses lignes sont figées, créez une nouvelle révision.';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND EXISTS (SELECT 1 FROM "DevisSignature" WHERE "devisId" = NEW."devisId") THEN
    RAISE EXCEPTION 'Devis signé : ses lignes sont figées, créez une nouvelle révision.';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER devis_ligne_figee_si_signe BEFORE INSERT OR UPDATE OR DELETE ON "DevisLigne"
FOR EACH ROW EXECUTE FUNCTION figer_lignes_devis_signe();

CREATE FUNCTION figer_contenu_devis_signe() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "DevisSignature" WHERE "devisId" = OLD."id") THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Devis signé : il ne se supprime pas.';
  END IF;
  IF (NEW."dossierId", NEW."numero", NEW."version", NEW."clientId", NEW."objet", NEW."totalHt", NEW."totalTva", NEW."totalTtc", NEW."acompteExige", NEW."tauxAcompte")
     IS DISTINCT FROM
     (OLD."dossierId", OLD."numero", OLD."version", OLD."clientId", OLD."objet", OLD."totalHt", OLD."totalTva", OLD."totalTtc", OLD."acompteExige", OLD."tauxAcompte") THEN
    RAISE EXCEPTION 'Devis signé : client, objet, montants et acompte exigé sont figés, créez une nouvelle révision.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER devis_contenu_fige_si_signe BEFORE UPDATE OR DELETE ON "Devis"
FOR EACH ROW EXECUTE FUNCTION figer_contenu_devis_signe();
