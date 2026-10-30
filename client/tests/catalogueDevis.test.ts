import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHeuresPrevues, ligneAEnvoyer, ligneDepuisCatalogue, ligneEnEdition, ligneVierge, type FicheCatalogueDevis } from '../src/lib/catalogueDevis.ts';
import { FORFAITS, LIBELLES_QUANTITE_FORFAIT, REFUS_FORFAIT_TEMPS_PASSE, TARIFS_FORFAIT, UNITES_FORFAIT, erreurForfait, ligneForfait, prixDuForfait } from '../src/lib/forfaitMainOeuvre.ts';

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
  // Une ligne sans le champ (chargée pour un compte qui ne le voyait pas) n'efface rien.
  const { prixAchatUnitaireHt: _absent, ...sansChamp } = ligne;
  assert.ok(!('prixAchatUnitaireHt' in ligneAEnvoyer(sansChamp, true)));
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

test('total des heures prévues d’un devis : en heures, deux décimales au plus, à la française', () => {
  assert.equal(formatHeuresPrevues(8), '8 h');
  assert.equal(formatHeuresPrevues(2.5), '2,5 h');
  assert.equal(formatHeuresPrevues(0.75), '0,75 h');
  assert.equal(formatHeuresPrevues(0), '0 h');
});

// Ligne de main d'œuvre au jour ou à la demi-journée (lot « budget et heures prévues du chantier », troisième PR).
const mainOeuvre: FicheCatalogueDevis = {
  famille: 'prestations', id: 'mo-1', reference: 'MO-ELEC', nom: 'Électricien', unite: 'heure', nature: 'MAIN_OEUVRE', prixVenteHt: 45, tauxTva: 20,
  estMainOeuvre: true, prixHeureSousContratHt: 40, prixJourHorsContratHt: 300, prixJourSousContratHt: 280, prixDemiJourneeHorsContratHt: 160, prixDemiJourneeSousContratHt: null,
};

test('forfait : le prix de la fiche selon le forfait et le tarif ; aucun sans prix de la demi-journée ni pour une prestation ordinaire', () => {
  assert.deepEqual(FORFAITS.flatMap((f) => TARIFS_FORFAIT.map((t) => prixDuForfait(mainOeuvre, f, t))), [300, 280, 160, null]);
  assert.equal(prixDuForfait({ ...mainOeuvre, estMainOeuvre: undefined }, 'JOUR', 'HORS_CONTRAT'), null);
  assert.equal(prixDuForfait({ ...mainOeuvre, prixDemiJourneeHorsContratHt: undefined }, 'DEMI_JOURNEE', 'HORS_CONTRAT'), null);
  assert.equal(ligneForfait(mainOeuvre, 'DEMI_JOURNEE', 'SOUS_CONTRAT'), null);
});

test('forfait : la nouvelle ligne, d’une unité, au prix et à l’unité de la fiche ; envoyée sans référence ni prix d’achat', () => {
  const ligne = ligneForfait(mainOeuvre, 'DEMI_JOURNEE', 'HORS_CONTRAT')!;
  assert.deepEqual(ligne, {
    forfaitMainOeuvre: 'DEMI_JOURNEE', tarifForfait: 'HORS_CONTRAT', designation: 'Électricien — à la demi-journée, hors contrat',
    nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 160, tauxTva: 20, unite: 'demi-journée', reference: 'MO-ELEC', catalogueFamille: 'prestations', catalogueId: 'mo-1',
  });
  assert.deepEqual([ligneForfait(mainOeuvre, 'JOUR', 'SOUS_CONTRAT')!.designation, ligneForfait(mainOeuvre, 'JOUR', 'SOUS_CONTRAT')!.unite], ['Électricien — au jour, sous contrat', 'jour']);
  assert.equal(ligneVierge(ligne), false);
  // L'administration, qui écrit le prix d'achat prévu, ne l'envoie pas non plus pour cette ligne.
  assert.deepEqual(ligneAEnvoyer({ ...ligne, prixAchatUnitaireHt: '12' }, true), {
    forfaitMainOeuvre: 'DEMI_JOURNEE', tarifForfait: 'HORS_CONTRAT', designation: 'Électricien — à la demi-journée, hors contrat', nature: 'MAIN_OEUVRE',
    quantite: 1, prixUnitaireHt: 160, tauxTva: 20, catalogueFamille: 'prestations', catalogueId: 'mo-1',
  });
});

test('forfait : une ligne existante remise en édition garde son identifiant, son forfait et son tarif, jamais de prix d’achat', () => {
  const existante = {
    id: 'ligne-9', designation: 'Électricien — au jour', nature: 'MAIN_OEUVRE' as const, quantite: 2, prixUnitaireHt: 300, tauxTva: 20, unite: 'jour', reference: 'MO-ELEC',
    catalogueFamille: 'prestations' as const, catalogueId: 'mo-1', prixAchatUnitaireHt: null, forfaitMainOeuvre: 'JOUR' as const, tarifForfait: 'HORS_CONTRAT' as const,
  };
  const enEdition = ligneEnEdition(existante, true);
  assert.deepEqual([enEdition.ligneId, enEdition.forfaitMainOeuvre, enEdition.tarifForfait, enEdition.unite, 'prixAchatUnitaireHt' in enEdition], ['ligne-9', 'JOUR', 'HORS_CONTRAT', 'jour', false]);
  const envoyee = ligneAEnvoyer(enEdition, true);
  assert.deepEqual([envoyee.ligneId, envoyee.forfaitMainOeuvre, envoyee.tarifForfait, envoyee.prixUnitaireHt, 'prixAchatUnitaireHt' in envoyee], ['ligne-9', 'JOUR', 'HORS_CONTRAT', 300, false]);
  // Une ligne ordinaire n'envoie ni forfait ni tarif.
  const ordinaire = ligneAEnvoyer(ligneEnEdition({ ...existante, forfaitMainOeuvre: null, tarifForfait: null }, false), false);
  assert.ok(!('forfaitMainOeuvre' in ordinaire) && !('tarifForfait' in ordinaire));
});

test('forfait : refusé avant l’envoi sur un devis au temps passé', () => {
  const ligne = ligneForfait(mainOeuvre, 'JOUR', 'HORS_CONTRAT')!;
  assert.equal(erreurForfait(true, [ligne]), REFUS_FORFAIT_TEMPS_PASSE);
  assert.equal(erreurForfait(false, [ligne]), null);
  assert.equal(erreurForfait(true, [{ designation: 'Câble', nature: 'FOURNITURE', quantite: 1, prixUnitaireHt: 2, tauxTva: 20 }]), null);
  assert.deepEqual([UNITES_FORFAIT.JOUR, UNITES_FORFAIT.DEMI_JOURNEE, LIBELLES_QUANTITE_FORFAIT.JOUR, LIBELLES_QUANTITE_FORFAIT.DEMI_JOURNEE], ['jour', 'demi-journée', 'Jours', 'Demi-journées']);
});
