import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dureeTempsPasse, erreurTempsPasse, formatPrix, ligneTempsPasse, mentionTempsPasse, prixDuTarif, refusQuantiteTempsPasse, REFUS_QUANTITE, REFUS_QUANTITE_POSITIVE, REFUS_SANS_LIGNE } from '../src/lib/tempsPasse.ts';
import { ligneAEnvoyer, ligneEnEdition, type FicheCatalogueDevis } from '../src/lib/catalogueDevis.ts';

const mainOeuvre: FicheCatalogueDevis = { famille: 'prestations', id: 'mo-1', reference: 'MO-ELEC', nom: 'Électricien', unite: 'heure', nature: 'MAIN_OEUVRE', prixVenteHt: 45.5, tauxTva: 20, estMainOeuvre: true, prixHeureSousContratHt: 40 };
const prestation: FicheCatalogueDevis = { famille: 'prestations', id: 'p-1', reference: 'POSE', nom: 'Pose', unite: 'forfait', nature: 'MAIN_OEUVRE', prixVenteHt: 250, tauxTva: 20 };

test('prix de l’heure : hors contrat, le prix de vente ; sous contrat, le prix à l’heure sous contrat ; jamais pour une prestation ordinaire', () => {
  assert.equal(prixDuTarif(mainOeuvre, 'HORS_CONTRAT'), 45.5);
  assert.equal(prixDuTarif(mainOeuvre, 'SOUS_CONTRAT'), 40);
  assert.equal(prixDuTarif(prestation, 'HORS_CONTRAT'), null);
  assert.equal(ligneTempsPasse(prestation, 'HORS_CONTRAT'), null);
});

test('ligne créée à une heure, à l’heure, au prix et à la TVA de la main d’œuvre ; le corps envoyé porte le prix affiché, sans prix d’achat', () => {
  const ligne = ligneTempsPasse(mainOeuvre, 'SOUS_CONTRAT')!;
  assert.deepEqual(ligne, {
    tempsPasse: true, tarifTempsPasse: 'SOUS_CONTRAT', designation: 'Main d’œuvre au temps passé — Électricien',
    nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 40, tauxTva: 20, unite: 'heure', reference: 'MO-ELEC', catalogueFamille: 'prestations', catalogueId: 'mo-1',
  });
  assert.deepEqual(ligneAEnvoyer({ ...ligne, prixAchatUnitaireHt: '3' }, true), {
    tempsPasse: true, designation: 'Main d’œuvre au temps passé — Électricien', quantite: 1, prixUnitaireHt: 40, tauxTva: 20, tarifTempsPasse: 'SOUS_CONTRAT', catalogueFamille: 'prestations', catalogueId: 'mo-1',
  });
  // La TVA de la ligne est celle de la main d'œuvre.
  assert.equal(ligneTempsPasse({ ...mainOeuvre, tauxTva: 10 }, 'HORS_CONTRAT')!.tauxTva, 10);
  // Une ligne existante garde son identifiant, son tarif et son prix figé.
  const existante = ligneEnEdition({ id: 'l-1', designation: 'MO', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 45.5, tauxTva: 20, unite: 'heure', reference: 'MO-ELEC', catalogueFamille: 'prestations', catalogueId: 'mo-1', tempsPasse: true, tarifTempsPasse: 'HORS_CONTRAT', prixAchatUnitaireHt: null }, true);
  assert.deepEqual([existante.ligneId, existante.tempsPasse, existante.tarifTempsPasse, existante.prixUnitaireHt, 'prixAchatUnitaireHt' in existante], ['l-1', true, 'HORS_CONTRAT', 45.5, false]);
  assert.deepEqual(ligneAEnvoyer(existante, true), { ligneId: 'l-1', tempsPasse: true, designation: 'MO', quantite: 2, prixUnitaireHt: 45.5, tauxTva: 20, tarifTempsPasse: 'HORS_CONTRAT', catalogueFamille: 'prestations', catalogueId: 'mo-1' });
  // Heures au millième : envoyées et remises en édition telles quelles.
  assert.equal(ligneAEnvoyer({ ...ligne, quantite: 1.25 }, true).quantite, 1.25);
  assert.equal(ligneEnEdition({ id: 'l-2', designation: 'MO', nature: 'MAIN_OEUVRE', quantite: 1.25, prixUnitaireHt: 45.5, tauxTva: 20, unite: 'heure', reference: 'MO-ELEC', catalogueFamille: 'prestations', catalogueId: 'mo-1', tempsPasse: true, tarifTempsPasse: 'HORS_CONTRAT' }, true).quantite, 1.25);
  // Une ligne existante à un autre prix et une autre TVA les garde, en édition comme dans le corps envoyé.
  const autre = ligneEnEdition({ id: 'l-3', designation: 'MO', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 47, tauxTva: 10, unite: 'heure', reference: 'MO-PLOMB', catalogueFamille: 'prestations', catalogueId: 'mo-2', tempsPasse: true, tarifTempsPasse: 'SOUS_CONTRAT' }, true);
  assert.deepEqual([autre.prixUnitaireHt, autre.tauxTva, ligneAEnvoyer(autre, true).prixUnitaireHt, ligneAEnvoyer(autre, true).tauxTva], [47, 10, 47, 10]);
});

test('quantité : le minimum figé puis des multiples du pas ; une heure au moins sans minimum ; positive seulement quand les réglages sont inconnus', () => {
  const reglages = { tempsMinimumMinutes: 60, pasTempsPasseMinutes: 15 };
  for (const quantite of [1, 1.25, 1.5, 2, 10]) assert.equal(refusQuantiteTempsPasse(quantite, reglages), null, String(quantite));
  const refus = 'La ligne au temps passé vaut le temps minimum facturé du devis (1 h), puis des tranches de 15 minutes : en heures, 1 ; 1,25 ; 1,5…';
  for (const quantite of [0.25, 0.75, 0.999, 1.001, 1.1, 1.333]) assert.equal(refusQuantiteTempsPasse(quantite, reglages), refus, String(quantite));
  const autres = { tempsMinimumMinutes: 30, pasTempsPasseMinutes: 45 };
  for (const quantite of [0.5, 1.25, 2]) assert.equal(refusQuantiteTempsPasse(quantite, autres), null, String(quantite));
  for (const quantite of [1, 0.75, 1.5]) assert.equal(refusQuantiteTempsPasse(quantite, autres), 'La ligne au temps passé vaut le temps minimum facturé du devis (30 min), puis des tranches de 45 minutes : en heures, 0,5 ; 1,25 ; 2…', String(quantite));
  // Devis antérieur au lot : minimum vide, une heure au moins, au millième.
  const ancien = { tempsMinimumMinutes: null, pasTempsPasseMinutes: 10 };
  assert.equal(refusQuantiteTempsPasse(1.001, ancien), null);
  assert.equal(refusQuantiteTempsPasse(0.999, ancien), REFUS_QUANTITE);
  // Nouveau devis : réglages inconnus de l'écran, le serveur contrôle le reste.
  assert.equal(refusQuantiteTempsPasse(0.25, null), null);
  for (const quantite of [0, -1, Number(''), Infinity, NaN]) assert.equal(refusQuantiteTempsPasse(quantite, null), REFUS_QUANTITE_POSITIVE, String(quantite));
  for (const [minutes, texte] of [[15, '15 min'], [60, '1 h'], [75, '1 h 15 min'], [480, '8 h']] as const) assert.equal(dureeTempsPasse(minutes), texte);
});

test('une ligne au temps passé et une seule sur un devis au temps passé, à la quantité permise par le devis', () => {
  const ligne = ligneTempsPasse(mainOeuvre, 'HORS_CONTRAT')!;
  const libre = { designation: 'Câble', nature: 'FOURNITURE' as const, quantite: 2, prixUnitaireHt: 3, tauxTva: 20 };
  assert.equal(erreurTempsPasse(true, [ligne, libre]), null);
  assert.equal(erreurTempsPasse(true, [{ ...ligne, quantite: 0.5 }]), null);
  assert.equal(erreurTempsPasse(true, [{ ...ligne, quantite: 0 }]), REFUS_QUANTITE_POSITIVE);
  assert.equal(erreurTempsPasse(true, [{ ...ligne, quantite: 0.5 }], { tempsMinimumMinutes: null, pasTempsPasseMinutes: 15 }), REFUS_QUANTITE);
  assert.match(erreurTempsPasse(true, [{ ...ligne, quantite: 1.1 }], { tempsMinimumMinutes: 60, pasTempsPasseMinutes: 15 })!, /tranches de 15 minutes/);
  assert.equal(erreurTempsPasse(true, [libre]), REFUS_SANS_LIGNE);
  assert.equal(erreurTempsPasse(true, [ligne, { ...ligne }]), REFUS_SANS_LIGNE);
  assert.equal(erreurTempsPasse(false, [libre]), null);
});

test('mention d’un devis antérieur au temps minimum (minimum vide) : prix, tarif et pas figés du devis, le texte d’alors, comme le PDF ; aucune pour un devis ordinaire', () => {
  const devis = { auTempsPasse: true, pasTempsPasseMinutes: 15, lignes: [{ tempsPasse: false, prixUnitaireHt: 3, quantite: 2 }, { tempsPasse: true, tarifTempsPasse: 'HORS_CONTRAT' as const, prixUnitaireHt: 45.5, quantite: 1 }] };
  assert.equal(mentionTempsPasse(devis), 'Devis au temps passé : une heure minimum facturée au prix de 45,50 € HT de l’heure (tarif à l’heure hors contrat), hors matériel ; au-delà de la première heure, le temps passé se facture par tranches de 15 minutes, toute tranche commencée étant due. Le total de ce devis est un minimum.');
  assert.match(mentionTempsPasse({ ...devis, pasTempsPasseMinutes: 1, lignes: [{ tempsPasse: true, tarifTempsPasse: 'SOUS_CONTRAT', prixUnitaireHt: 40, quantite: 1 }] })!, /40,00 € HT de l’heure \(tarif à l’heure sous contrat\).*tranches de 1 minute, toute/);
  // Plus d'une heure : la quantité de la ligne est le minimum facturé, au pluriel dès deux heures.
  assert.match(mentionTempsPasse({ ...devis, lignes: [{ tempsPasse: true, tarifTempsPasse: 'HORS_CONTRAT', prixUnitaireHt: 45.5, quantite: 2 }] })!, /^Devis au temps passé : 2 heures minimum facturées au prix de 45,50 €/);
  assert.match(mentionTempsPasse({ ...devis, lignes: [{ tempsPasse: true, tarifTempsPasse: 'HORS_CONTRAT', prixUnitaireHt: 45.5, quantite: 1.5 }] })!, /^Devis au temps passé : 1,5 heure minimum facturée au prix de 45,50 €/);
  // Quantités au millième : la quantité exacte de la ligne, au singulier sous deux heures, comme le PDF.
  for (const [quantite, heures] of [[1.001, '1,001 heure minimum facturée'], [1.999, '1,999 heure minimum facturée'], [10.125, '10,125 heures minimum facturées']] as const) {
    const texte = mentionTempsPasse({ ...devis, lignes: [{ tempsPasse: true, tarifTempsPasse: 'HORS_CONTRAT', prixUnitaireHt: 45.5, quantite }] })!;
    assert.ok(texte.startsWith(`Devis au temps passé : ${heures} au prix de 45,50 € HT de l’heure`), `${quantite} : ${texte}`);
  }
  assert.equal(mentionTempsPasse({ ...devis, auTempsPasse: false }), null);
  assert.equal(mentionTempsPasse({ ...devis, pasTempsPasseMinutes: null }), null);
  assert.equal(formatPrix(1234.5).replace(/\s/g, ' '), '1 234,50 €');
  // Prix au centime et pas de deux minutes : le prix exact, et le pluriel dès deux minutes.
  assert.equal(formatPrix(45.55), '45,55 €');
  assert.match(mentionTempsPasse({ ...devis, pasTempsPasseMinutes: 2, lignes: [{ tempsPasse: true, tarifTempsPasse: 'HORS_CONTRAT', prixUnitaireHt: 45.55, quantite: 1 }] })!, /au prix de 45,55 € HT de l’heure \(tarif à l’heure hors contrat\).*tranches de 2 minutes, toute/);
});

test('mention avec le minimum figé : minimum et pas, total minimum ou estimation au-delà, le même texte que le PDF', () => {
  const devis = (quantite: number, tempsMinimumMinutes = 60, pasTempsPasseMinutes = 15) => ({ auTempsPasse: true, pasTempsPasseMinutes, tempsMinimumMinutes, lignes: [{ tempsPasse: true, tarifTempsPasse: 'HORS_CONTRAT' as const, prixUnitaireHt: 45.5, quantite }] });
  const regle = (minimum: string, pas: number) => `Devis au temps passé : au prix de 45,50 € HT de l’heure (tarif à l’heure hors contrat), hors matériel, le temps passé se facture avec un minimum de ${minimum}, puis par tranches de ${pas} minutes au-delà, toute tranche commencée étant due.`;
  assert.equal(mentionTempsPasse(devis(1)), `${regle('1 h', 15)} Le total de ce devis est un minimum.`);
  assert.equal(mentionTempsPasse(devis(1.5)), `${regle('1 h', 15)} Ce devis prévoit 1 h 30 min : son total est une estimation, la facture reprenant le temps réellement passé, avec au moins le minimum.`);
  assert.equal(mentionTempsPasse(devis(0.5, 30, 45)), `${regle('30 min', 45)} Le total de ce devis est un minimum.`);
  assert.equal(mentionTempsPasse(devis(2.75, 30, 45)), `${regle('30 min', 45)} Ce devis prévoit 2 h 45 min : son total est une estimation, la facture reprenant le temps réellement passé, avec au moins le minimum.`);
  assert.equal(mentionTempsPasse(devis(8, 480, 60)), `${regle('8 h', 60)} Le total de ce devis est un minimum.`);
});
