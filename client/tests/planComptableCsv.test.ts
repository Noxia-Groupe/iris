import assert from 'node:assert/strict';
import test from 'node:test';
import { parserPlanComptableCsv } from '../src/lib/planComptableCsv.ts';

test('préserve les séparateurs et guillemets échappés dans un libellé CSV à point-virgule', () => {
  assert.deepEqual(parserPlanComptableCsv('code;libelle;nature\n706123;"Ventes, pose; et ""entretien""";PRODUIT\n'), [
    { code: '706123', libelle: 'Ventes, pose; et "entretien"', nature: 'PRODUIT' },
  ]);
});

test('détecte la virgule hors des guillemets et accepte BOM, CRLF et saut de ligne dans un libellé', () => {
  assert.deepEqual(parserPlanComptableCsv('\uFEFFcode,libelle,nature\r\n706124,"Pose; installation\r\net entretien",PRODUIT\r\n'), [
    { code: '706124', libelle: 'Pose; installation\r\net entretien', nature: 'PRODUIT' },
  ]);
});

test('accepte un fichier sans en-tête et ignore les lignes vides finales', () => {
  assert.deepEqual(parserPlanComptableCsv('411123;Clients;ACTIF\n\n'), [
    { code: '411123', libelle: 'Clients', nature: 'ACTIF' },
  ]);
});

test('refuse les guillemets non fermés et les guillemets hors d’un champ cité', () => {
  assert.throws(() => parserPlanComptableCsv('code;libelle;nature\n411123;"Client;ACTIF'), /Ligne 2/);
  assert.throws(() => parserPlanComptableCsv('code;libelle;nature\n411123;Cli"ent;ACTIF'), /Ligne 2/);
  assert.throws(() => parserPlanComptableCsv('code;libelle;nature\n411123;"Client"x;ACTIF'), /Ligne 2/);
});

test('refuse une colonne manquante ou supplémentaire sans retourner de lignes partielles', () => {
  assert.throws(() => parserPlanComptableCsv('code;libelle;nature\n411123;Clients;ACTIF\n411124;Clients'), /Ligne 3/);
  assert.throws(() => parserPlanComptableCsv('code;libelle;nature\n411123;Clients;ACTIF;inattendu'), /Ligne 2/);
});

test('refuse un en-tête non conforme et un fichier vide', () => {
  assert.throws(() => parserPlanComptableCsv('code;libelle;autre\n411123;Clients;ACTIF'), /en-tête/i);
  assert.throws(() => parserPlanComptableCsv('\uFEFF\n'), /aucun compte/i);
});
