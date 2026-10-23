-- Lot pilote 5, décisions de Nelson du 22-10-2026 (questions (a) et (c) de la passation).

-- (a) La génération automatique des visites est désactivée au démarrage : une nouvelle instance
-- n'a pas d'anticipation tant que la société ne l'a pas réglée. La ligne de paramètres déjà
-- créée garde sa valeur (sans objet tant qu'aucune instance réelle n'existe).
ALTER TABLE "Parametres" ALTER COLUMN "anticipationVisitesJours" DROP DEFAULT;

-- (c) Compte système : il porte les écritures automatiques (génération des visites), au lieu
-- d'un auteur vide. Il ne se connecte jamais : inactif, sans mot de passe, d'une adresse
-- réservée (.invalid, qui ne peut être un domaine vérifié d'Entra ID ; une connexion qui la
-- présenterait resterait refusée, le compte étant inactif), d'un type de compte qu'aucune route
-- n'accorde et qui ne donne aucun droit.
INSERT INTO "User" ("id", "email", "name", "role", "actif", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000001', 'systeme@iris.invalid', 'Iris (automatique)', 'SYSTEME', false, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Le type SYSTEME n'appartient qu'à ce compte, et ce compte ne change ni ne disparaît.
ALTER TABLE "User" ADD CONSTRAINT "User_role_systeme_check"
  CHECK (("role" = 'SYSTEME') = ("id" = '00000000-0000-4000-8000-000000000001'));

CREATE FUNCTION figer_compte_systeme() RETURNS trigger AS $$
BEGIN
  IF OLD."id" = '00000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'Compte système : ni modification ni suppression.';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER compte_systeme_fige BEFORE UPDATE OR DELETE ON "User"
FOR EACH ROW EXECUTE FUNCTION figer_compte_systeme();

-- Journal SAV : toute nouvelle écriture désigne un compte, le compte système pour la génération
-- automatique. Comme l'exception qu'elle remplace, la contrainte borne ce que le compte système
-- écrit : la création de la visite d'un contrat et l'avancement de son échéance, rien d'autre.
-- Les écritures déjà faites sans compte, au nom « Génération automatique », restent telles
-- quelles : la contrainte ne vérifie que les lignes nouvelles ou modifiées (NOT VALID).
ALTER TABLE "JournalSaisieChantier" DROP CONSTRAINT "JournalSaisieChantier_auteur_generation_check";
ALTER TABLE "JournalSaisieChantier" ADD CONSTRAINT "JournalSaisieChantier_auteur_check"
  CHECK (
    "auteurId" IS NOT NULL
    AND (
      "auteurId" <> '00000000-0000-4000-8000-000000000001'
      OR ("cible" = 'INTERVENTION' AND "action" = 'CREATION_CONTRAT')
      OR ("cible" = 'CONTRAT' AND "action" = 'AVANCEMENT_ECHEANCE')
    )
  ) NOT VALID;

-- Passages de la génération : le passage automatique est lui aussi au nom du compte système.
-- Les passages automatiques déjà enregistrés, sans auteur, restent tels quels (NOT VALID).
ALTER TABLE "ExecutionGenerationVisites" DROP CONSTRAINT "ExecutionGenerationVisites_coherence_check";
ALTER TABLE "ExecutionGenerationVisites" ADD CONSTRAINT "ExecutionGenerationVisites_coherence_check"
  CHECK (
    "statut" IN ('EN_COURS', 'REUSSIE', 'ECHEC')
    AND "anticipationJours" BETWEEN 0 AND 365
    AND "visitesCreees" >= 0 AND "echeancesAvancees" >= 0
    AND (
      ("declenchement" = 'AUTOMATIQUE' AND "cleJourAutomatique" IS NOT DISTINCT FROM to_char("jour", 'YYYY-MM-DD')
        AND "auteurId" IS NOT DISTINCT FROM '00000000-0000-4000-8000-000000000001' AND "auteurNom" IS NOT NULL)
      OR ("declenchement" = 'MANUEL' AND "cleJourAutomatique" IS NULL AND "auteurId" IS NOT NULL
        AND "auteurId" <> '00000000-0000-4000-8000-000000000001' AND "auteurNom" IS NOT NULL)
    )
  ) NOT VALID;
