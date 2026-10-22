-- Lot 6a-2 : PDF du devis sur le modèle commun. Un devis signé est figé en base (#161) : il
-- s'imprime donc depuis des copies prises à sa signature, et non depuis des données vivantes
-- (principe 6 de la proposition de paramétrage). La signature copie l'identité de l'émetteur
-- (ligne figée du lot 6a-1, avec son logo, sa couleur et son pied de page), la raison sociale du
-- client et son adresse de facturation (absente si le client n'a aucun site), et le fuseau de la
-- société, qui date le devis imprimé (création de la version, signature).
ALTER TABLE "DevisSignature"
  ADD COLUMN "identiteEmetteurId" TEXT,
  ADD COLUMN "clientRaisonSociale" TEXT,
  ADD COLUMN "clientAdresse" TEXT,
  ADD COLUMN "fuseauHoraire" TEXT;

CREATE INDEX "DevisSignature_identiteEmetteurId_idx" ON "DevisSignature"("identiteEmetteurId");

ALTER TABLE "DevisSignature"
  ADD CONSTRAINT "DevisSignature_identiteEmetteurId_fkey"
    FOREIGN KEY ("identiteEmetteurId") REFERENCES "IdentiteEmetteur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Une signature enregistrée à partir de ce lot porte ses copies. Les signatures antérieures,
-- sans copie, restent valides : elles sont déjà figées (devis_signature_figee refuse toute
-- modification), et rien ne doit inventer après coup ce qu'elles auraient imprimé. Les copies
-- nouvelles sont figées par le même garde.
CREATE FUNCTION exiger_copies_signature_devis() RETURNS trigger AS $$
BEGIN
  IF NEW."identiteEmetteurId" IS NULL OR NEW."clientRaisonSociale" IS NULL OR btrim(NEW."clientRaisonSociale") = ''
     OR NEW."fuseauHoraire" IS NULL OR btrim(NEW."fuseauHoraire") = '' THEN
    RAISE EXCEPTION 'Signature de devis : l’identité de l’émetteur, le client et le fuseau de la société doivent être copiés à la signature.';
  END IF;
  IF NEW."clientAdresse" IS NOT NULL AND btrim(NEW."clientAdresse") = '' THEN
    RAISE EXCEPTION 'Signature de devis : adresse du client vide.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER devis_signature_copies BEFORE INSERT ON "DevisSignature"
FOR EACH ROW EXECUTE FUNCTION exiger_copies_signature_devis();
