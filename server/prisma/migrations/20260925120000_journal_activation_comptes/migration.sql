CREATE TABLE "JournalCompteComptable" (
    "id" TEXT NOT NULL,
    "compteId" TEXT NOT NULL,
    "auteurId" TEXT NOT NULL,
    "auteurNom" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "avant" BOOLEAN NOT NULL,
    "apres" BOOLEAN NOT NULL,
    "motif" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JournalCompteComptable_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JournalCompteComptable_transition_check" CHECK (
      ("action" = 'DESACTIVATION' AND "avant" = true AND "apres" = false)
      OR ("action" = 'REACTIVATION' AND "avant" = false AND "apres" = true)
    ),
    CONSTRAINT "JournalCompteComptable_motif_check" CHECK (char_length(btrim("motif")) BETWEEN 3 AND 500 AND "motif" = btrim("motif") AND "motif" !~ '[[:cntrl:]]')
);
CREATE INDEX "JournalCompteComptable_compteId_createdAt_idx" ON "JournalCompteComptable"("compteId", "createdAt");
CREATE INDEX "JournalCompteComptable_auteurId_idx" ON "JournalCompteComptable"("auteurId");
ALTER TABLE "JournalCompteComptable" ADD CONSTRAINT "JournalCompteComptable_compteId_fkey" FOREIGN KEY ("compteId") REFERENCES "CompteComptable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JournalCompteComptable" ADD CONSTRAINT "JournalCompteComptable_auteurId_fkey" FOREIGN KEY ("auteurId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE FUNCTION "refuser_mutation_journal_compte"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Journal comptable immuable : modification ou suppression interdite';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "journal_compte_append_only" BEFORE UPDATE OR DELETE ON "JournalCompteComptable"
FOR EACH ROW EXECUTE FUNCTION "refuser_mutation_journal_compte"();
