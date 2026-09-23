-- Une écriture Travaux est soit active, soit archivée avec un auteur et un motif exploitable.
-- Les trois informations d'archivage forment un ensemble atomique, y compris en écriture SQL directe.
ALTER TABLE "AchatReel"
  ADD CONSTRAINT "AchatReel_archivage_complet_check"
  CHECK (
    ("archivedAt" IS NULL AND "archivedById" IS NULL AND "motifArchivage" IS NULL)
    OR
    ("archivedAt" IS NOT NULL AND "archivedById" IS NOT NULL AND "motifArchivage" IS NOT NULL AND char_length(btrim("motifArchivage")) BETWEEN 3 AND 500)
  );

ALTER TABLE "PointageHeure"
  ADD CONSTRAINT "PointageHeure_archivage_complet_check"
  CHECK (
    ("archivedAt" IS NULL AND "archivedById" IS NULL AND "motifArchivage" IS NULL)
    OR
    ("archivedAt" IS NOT NULL AND "archivedById" IS NOT NULL AND "motifArchivage" IS NOT NULL AND char_length(btrim("motifArchivage")) BETWEEN 3 AND 500)
  );
