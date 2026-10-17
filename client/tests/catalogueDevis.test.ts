import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ligneAEnvoyer, ligneDepuisCatalogue, ligneEnEdition, ligneVierge, type FicheCatalogueDevis } from '../src/lib/catalogueDevis.ts';

const fiche: FicheCatalogueDevis = { famille: 'articles', id: 'fiche-1', reference: 'CAB-01', nom: 'Câble', unite: 'm', nature: 'FOURNITURE', prixVenteHt: 2.5, tauxTva: 20, prixAchatHt: 0.8 };

test('une fiche devient une ligne copiée ; le prix d’achat n’est repris que pour qui le voit', () => {
  assert.deepEqual(ligneDepuisCatalogue(fiche, true), {
    designation: 'Câble', nature: 'FOURNITURE', quantite: 1, prixUnitaireHt: 2.5, tauxTva: 20, unite: 'm',
    reference: 'CAB-01', catalogueFamille: 'articles', catalogueId: 'fiche-1', prixAchatUnitaireHt: '0,8',
  });
  assert.ok(!('prixAchatUnitaireHt' in ligneDepuisCatalogue(fiche, false)));
  assert.equal(ligneDepuisCatalogue({ ...fiche, prixAchatHt: null }, true).prixAchatUnitaireHt, '');
});

test('corps envoyé : pas de prix d’achat sans droit d’écriture, ni de référence ; vide = effacé', () => {
  const ligne = ligneDepuisCatalogue(fiche, true);
  const sansDroit = ligneAEnvoyer(ligne, false);
  assert.ok(!('prixAchatUnitaireHt' in sansDroit));
  assert.ok(!('reference' in sansDroit));
  assert.deepEqual([sansDroit.catalogueFamille, sansDroit.catalogueId, sansDroit.unite], ['articles', 'fiche-1', 'm']);
  assert.equal(ligneAEnvoyer(ligne, true).prixAchatUnitaireHt, '0,8');
  assert.equal(ligneAEnvoyer({ ...ligne, prixAchatUnitaireHt: '  ' }, true).prixAchatUnitaireHt, null);
  const libre = ligneAEnvoyer({ designation: 'Libre', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 10, tauxTva: 20, unite: ' ' }, false);
  assert.ok(!('catalogueFamille' in libre) && !('ligneId' in libre));
  assert.equal(libre.unite, null);
});

test('ligne existante remise en édition : son identifiant suit, le prix d’achat seulement pour qui le voit', () => {
  const existante = { id: 'ligne-1', designation: 'Câble', nature: 'FOURNITURE' as const, quantite: 10, prixUnitaireHt: 2.5, tauxTva: 20, unite: 'm', reference: 'CAB-01', catalogueFamille: 'articles' as const, catalogueId: 'fiche-1', prixAchatUnitaireHt: 0.8 };
  const pourAdmin = ligneEnEdition(existante, true);
  assert.deepEqual([pourAdmin.ligneId, pourAdmin.reference, pourAdmin.prixAchatUnitaireHt], ['ligne-1', 'CAB-01', '0,8']);
  assert.ok(!('prixAchatUnitaireHt' in ligneEnEdition(existante, false)));
  assert.equal(ligneAEnvoyer(pourAdmin, true).ligneId, 'ligne-1');
});

test('seule une ligne vierge est remplacée par la première fiche ajoutée', () => {
  assert.equal(ligneVierge({ designation: '', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 0, tauxTva: 20 }), true);
  assert.equal(ligneVierge({ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 0, tauxTva: 20 }), false);
  assert.equal(ligneVierge({ designation: '', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 5, tauxTva: 20 }), false);
  assert.equal(ligneVierge({ ligneId: 'l', designation: '', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 0, tauxTva: 20 }), false);
});
