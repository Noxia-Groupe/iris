import { test } from 'node:test';
import assert from 'node:assert/strict';
// Ce module se charge sous tsx --test : il n'importe pas roles.ts, qui charge api.ts et lit
// import.meta.env, introuvable ici, mais lib/droits.ts (V-N6). Son import seul le prouve.
import { CHAMPS_JOURNAL, lisible } from '../src/lib/journalAdministration.ts';

// Lot 6b-2, « Journal d'administration » (cadrage du lot 6b, version 8 ; C-N1 de #410, N3) : le réglage
// du mode d'envoi des documents se lit en clair, « Mode d’envoi des documents », et ses valeurs
// « Microsoft 365 » et « Messagerie seule », jamais leurs codes. CHAMPS_JOURNAL et lisible() sortent de
// JournalAdministration.tsx sans changer pour les autres champs.

test('le mode d’envoi des documents se lit en clair dans le journal d’administration', () => {
  assert.equal(CHAMPS_JOURNAL.modeEnvoi, 'Mode d’envoi des documents');
  assert.equal(lisible('MICROSOFT_365', 'modeEnvoi'), 'Microsoft 365');
  assert.equal(lisible('MESSAGERIE', 'modeEnvoi'), 'Messagerie seule');
  // Le champ est celui de la ligne du serveur (administration/routes.ts, valeurs { modeEnvoi }) : le
  // planning garde son propre libellé.
  assert.equal(CHAMPS_JOURNAL.planningActif, 'Planning');
});

test('les autres champs du journal se lisent comme avant le déplacement de lisible()', () => {
  assert.equal(lisible('ADMIN', 'role'), 'Admin');
  assert.equal(lisible('SUPERADMIN', 'role'), 'Super Admin');
  assert.equal(lisible(true, 'planningActif'), 'oui');
  assert.equal(lisible(false, 'planningActif'), 'non');
  assert.equal(lisible(null, 'joursSansSaisie'), '—');
  assert.equal(lisible('', 'nom'), '—');
  assert.equal(lisible(17, 'joursSansSaisie'), '17');
  assert.equal(lisible([], 'permissions'), 'aucune');
  assert.equal(lisible(['clients:read', 'devis:write'], 'permissions'), 'clients:read, devis:write');
  assert.equal(lisible({ a: 1 }, 'detail'), '{"a":1}');
  // Le libellé du mode ne vaut que pour son champ : ailleurs, « MESSAGERIE » reste la valeur reçue.
  assert.equal(lisible('MESSAGERIE', 'nom'), 'MESSAGERIE');
  assert.equal(lisible('MICROSOFT_365'), 'MICROSOFT_365');
  assert.equal(CHAMPS_JOURNAL.role, 'Type de compte');
  assert.equal(CHAMPS_JOURNAL.joursSansSaisie, 'Jours sans saisie');
  assert.equal(CHAMPS_JOURNAL.prixVenteHt, 'Prix de vente HT à l’heure, hors contrat');
});
