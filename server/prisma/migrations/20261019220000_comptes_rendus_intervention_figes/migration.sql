-- Lot pilote 3b (#223) : un compte rendu d'intervention est en ajout seul dès son enregistrement, et
-- la signature qui l'atteste est figée dès sa création. Jusqu'ici, la règle ne tenait que par
-- l'absence de route : en SQL, un compte rendu ou une signature se modifiait ou se supprimait. Une
-- correction passe par un nouveau compte rendu (migration 20260907140000 : « Les corrections futures
-- créent une nouvelle trace »).
CREATE FUNCTION refuser_modification_compte_rendu_intervention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Compte rendu d''intervention figé : ajout seul, ni modification ni suppression ; une correction passe par un nouveau compte rendu.';
END $$;

CREATE TRIGGER intervention_rapport_ajout_seul BEFORE UPDATE OR DELETE ON "InterventionRapport"
FOR EACH ROW EXECUTE FUNCTION refuser_modification_compte_rendu_intervention();

-- La signature atteste un compte rendu par son empreinte : la supprimer, puis en enregistrer une
-- autre, effacerait l'attestation d'origine.
CREATE FUNCTION figer_signature_intervention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Signature d''intervention figée : ni modification ni suppression.';
END $$;

CREATE TRIGGER intervention_signature_figee BEFORE UPDATE OR DELETE ON "InterventionSignature"
FOR EACH ROW EXECUTE FUNCTION figer_signature_intervention();

-- TRUNCATE ne déclenche pas les triggers de ligne : le vidage est refusé à part, avec la fonction de
-- la migration 20261019120000, dont le message nomme la table refusée.
CREATE TRIGGER intervention_rapport_sans_vidage BEFORE TRUNCATE ON "InterventionRapport" FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_sans_suppression();
CREATE TRIGGER intervention_signature_sans_vidage BEFORE TRUNCATE ON "InterventionSignature" FOR EACH STATEMENT EXECUTE FUNCTION refuser_vidage_sans_suppression();

-- Une intervention qui porte un compte rendu ne se supprime plus en cascade : la clé étrangère la
-- refuse explicitement, comme pour un devis signé. Aucune route ne supprime d'intervention.
ALTER TABLE "InterventionRapport" DROP CONSTRAINT "InterventionRapport_interventionId_fkey";
ALTER TABLE "InterventionRapport" ADD CONSTRAINT "InterventionRapport_interventionId_fkey"
  FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
