-- Retrait de l'intégration ERP tierce : Iris interroge désormais sa seule base.
--
-- « AcquittementDevis » portait la marque « Vu » posée dans l'écran Suivi financier sur un
-- devis de vente tiers au règlement incomplet mais assumé. L'écran et la lecture externe
-- disparaissant, la table n'a plus ni producteur ni lecteur.
--
-- La facturation (phase 8) puis les paiements et le rapprochement bancaire (phase 9)
-- réintroduiront ces notions comme des modèles natifs — factures, avoirs, règlements —
-- et non comme une marque posée sur une référence externe.
DROP TABLE IF EXISTS "AcquittementDevis";
