-- Lot P0 (décision de Nelson du 21-10-2026 : « il ne doit plus y avoir de noxia groupe dans
-- l’application, c’est une application ouverte a toute les entreprise ») : la migration
-- 20260904210000_parametres_remuneration avait inséré les barèmes et les primes d'une société.
-- Aucun calcul ne les lit depuis #159 (commissions fermées tant qu'aucun plan commercial n'est
-- attribué) : les vider ne change aucun montant.
--
-- Chaque colonne n'est vidée que si elle garde la valeur insérée : une valeur déjà saisie par
-- un super administrateur est conservée. Le libellé du barème réduit, générique, est conservé.
UPDATE "ParametresRemuneration"
SET
    "baremeStandard" = CASE
        WHEN "baremeStandard" = '[{"plafond":20000,"taux":16},{"plafond":30000,"taux":20},{"plafond":null,"taux":25}]'::jsonb
        THEN '[]'::jsonb ELSE "baremeStandard" END,
    "baremeReduit" = CASE
        WHEN "baremeReduit" = '[{"plafond":20000,"taux":8},{"plafond":30000,"taux":10},{"plafond":null,"taux":12.5}]'::jsonb
        THEN '[]'::jsonb ELSE "baremeReduit" END,
    "objectifCaMensuel" = CASE WHEN "objectifCaMensuel" = 70000 THEN 0 ELSE "objectifCaMensuel" END,
    "primeObjectifCa" = CASE WHEN "primeObjectifCa" = 450 THEN 0 ELSE "primeObjectifCa" END,
    "objectifMargeMensuel" = CASE WHEN "objectifMargeMensuel" = 17000 THEN 0 ELSE "objectifMargeMensuel" END,
    "primeObjectifMarge" = CASE WHEN "primeObjectifMarge" = 450 THEN 0 ELSE "primeObjectifMarge" END,
    "primeSuiviAdministratif" = CASE WHEN "primeSuiviAdministratif" = 250 THEN 0 ELSE "primeSuiviAdministratif" END,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'singleton'
  AND (
    "baremeStandard" = '[{"plafond":20000,"taux":16},{"plafond":30000,"taux":20},{"plafond":null,"taux":25}]'::jsonb
    OR "baremeReduit" = '[{"plafond":20000,"taux":8},{"plafond":30000,"taux":10},{"plafond":null,"taux":12.5}]'::jsonb
    OR "objectifCaMensuel" = 70000 OR "primeObjectifCa" = 450 OR "objectifMargeMensuel" = 17000
    OR "primeObjectifMarge" = 450 OR "primeSuiviAdministratif" = 250
  );
