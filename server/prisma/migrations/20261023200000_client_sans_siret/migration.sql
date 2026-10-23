-- Lot 6a-2 bis : identité minimale du client pour signer un devis et émettre une facture.
-- Décisions de Nelson du 23-10-2026 : un client professionnel doit porter une raison sociale, une
-- adresse de facturation et un SIREN (« un SIREN suffit ») ; un particulier, signalé par la case
-- « pas de SIRET » de sa fiche, n'a besoin que de son nom complet et de son adresse. Iris restant
-- ouvert au B2B comme au B2C, la case est une donnée de la fiche, et non un réglage de la société.
--
-- Aucune reprise de données (règle 4 de la méthode) : les clients existants restent des
-- professionnels (case décochée), avec ou sans SIREN.
ALTER TABLE "Client" ADD COLUMN "sansSiret" BOOLEAN NOT NULL DEFAULT false;

-- Un client « pas de SIRET » n'a pas de SIREN : l'API refuse la contradiction (400), la base aussi.
ALTER TABLE "Client"
  ADD CONSTRAINT "Client_sansSiret_siren_check" CHECK (NOT ("sansSiret" AND "siren" IS NOT NULL));
