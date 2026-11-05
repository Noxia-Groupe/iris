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

test('les autres champs du journal se lisent en clair, le type de compte sous son libellé unique (#203)', () => {
  assert.equal(lisible('ADMIN', 'role'), 'Administrateur');
  assert.equal(lisible('SUPERADMIN', 'role'), 'Super administrateur');
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

// PR A4 du lot « anomalies d'écran », #206 ; N4 du contrôle de #491 (A3). Choix par défaut, à confirmer : depuis que
// roleLabel rend '' pour un rôle absent ou inconnu (menu et « Connecté en tant que » n'affichent rien), le journal
// d'administration garde sa propre lecture, celle de son commentaire : un code connu sous son libellé, un code inconnu tel
// quel, une valeur vide « — », comme toute valeur vide du journal.
test('au journal, le type de compte se lit sous son libellé ; un code inconnu reste tel quel, et un type vide s’affiche « — » (#206)', () => {
  // Code connu : son libellé, et non son code.
  assert.equal(lisible('CONDUCTEUR_TRAVAUX', 'role'), 'Conducteur de travaux');
  assert.equal(lisible('TECHNICIEN', 'role'), 'Technicien');
  // Code inconnu : tel quel. Lectures écartées : '' (une cellule vide, roleLabel seul) et « Conducteur » (ancien repli).
  for (const code of ['INCONNU', 'superadmin', 'Administrateur', 'constructor', 'toString']) {
    assert.equal(lisible(code, 'role'), code, code);
  }
  // Type vide ou absent : « — ». Lectures écartées : '' (cellule vide) et « Conducteur » (ancien repli).
  for (const vide of ['', null, undefined]) {
    assert.equal(lisible(vide, 'role'), '—', JSON.stringify(vide) ?? 'undefined');
  }
  // Même tiret que les autres champs vides : une seule convention dans le journal.
  assert.equal(lisible('', 'role'), lisible('', 'nom'));
});
