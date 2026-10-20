import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totauxApercuAvoir } from '../src/lib/apercuAvoir';

const ligne = (quantite: string, prixUnitaireHt: string, tauxTva: string) => ({ quantite, prixUnitaireHt, tauxTva });

// #236 : l'aperçu annonce les montants du document émis, calculés par le serveur en entiers.
test('l’aperçu d’un premier avoir arrondit ligne et TVA au centime, moitié vers le haut, sans flottant', () => {
  // 21,35 × 10 % = 2,135 : en flottant, 2,13 ; le document porte 2,14.
  assert.deepEqual(totauxApercuAvoir([ligne('1', '21,35', '10')]), { totalHt: 21.35, totalTva: 2.14, totalTtc: 23.49 });
  for (const prix of ['21,75', '23,85', '40,15']) {
    const { totalTva } = totauxApercuAvoir([ligne('1', prix, '10')]);
    assert.equal(totalTva, Math.ceil(Number(prix.replace(',', '.')) * 10) / 100, prix);
  }
  // 0,5 × 4,27 = 2,135 € HT, arrondi à 2,14 avant la TVA (0,428 → 0,43).
  assert.deepEqual(totauxApercuAvoir([ligne('0,5', '4,27', '20')]), { totalHt: 2.14, totalTva: 0.43, totalTtc: 2.57 });
  // Deux taux : la TVA est calculée par taux, sur la base HT cumulée des lignes du taux.
  assert.deepEqual(totauxApercuAvoir([ligne('1', '33,33', '20'), ligne('2', '16,67', '5,5'), ligne('1', '0,01', '20')]), { totalHt: 66.68, totalTva: 8.50, totalTtc: 75.18 });
  // Saisie incomplète : zéro, sans erreur.
  assert.deepEqual(totauxApercuAvoir([ligne('', '10', '20'), ligne('1', 'abc', '20')]), { totalHt: 0, totalTva: 0, totalTtc: 0 });
  // La saisie est lue comme l'écran l'envoie au serveur, qui en relit l'écriture la plus courte : les
  // zéros superflus ne changent rien, et une quantité au-delà du millième, refusée, compte pour zéro.
  assert.deepEqual(totauxApercuAvoir([ligne('1', '10', '20,0000')]), { totalHt: 10, totalTva: 2, totalTtc: 12 });
  assert.deepEqual(totauxApercuAvoir([ligne('1', '100', '5,5000')]), { totalHt: 100, totalTva: 5.5, totalTtc: 105.5 });
  assert.deepEqual(totauxApercuAvoir([ligne('1,5000', '10', '20')]), { totalHt: 15, totalTva: 3, totalTtc: 18 });
  assert.deepEqual(totauxApercuAvoir([ligne('1', '10,500', '20')]), { totalHt: 10.5, totalTva: 2.1, totalTtc: 12.6 });
  assert.deepEqual(totauxApercuAvoir([ligne('1,0001', '10', '20')]), { totalHt: 0, totalTva: 0, totalTtc: 0 });
});

test('l’aperçu d’un avoir suivant déduit sa TVA des bases déjà créditées, comme le serveur', () => {
  // Déjà crédité : 21,35 € HT à 10 % (TVA 2,14). Avec 0,05 € de plus, la base cumulée de 21,40 €
  // garde une TVA de 2,14 : l'avoir n'en porte pas (en flottant, 0,005 → 0,01).
  const precedent = { ventilationTva: [{ tauxTva: 10, totalHt: 21.35 }] };
  assert.deepEqual(totauxApercuAvoir([ligne('1', '0,05', '10')], [precedent]), { totalHt: 0.05, totalTva: 0, totalTtc: 0.05 });
  // Déjà crédité : 0,02 € HT à 20 % (TVA 0,00). Avec 0,02 € de plus, la base de 0,04 € porte 0,01.
  assert.deepEqual(totauxApercuAvoir([ligne('1', '0,02', '20')], [{ ventilationTva: [{ tauxTva: 20, totalHt: 0.02 }] }]), { totalHt: 0.02, totalTva: 0.01, totalTtc: 0.03 });
  // Un avoir historique sans ventilation enregistrée compte par ses lignes, et un autre taux ne compte
  // pas : avec la ligne de 0,01 € à 10 %, la base précédente serait de 0,03 € et la TVA nulle.
  assert.deepEqual(totauxApercuAvoir([ligne('1', '0,02', '20')], [{ ventilationTva: [], lignes: [{ tauxTva: 20, totalHt: 0.01 }, { tauxTva: 20, totalHt: 0.01 }, { tauxTva: 10, totalHt: 0.01 }] }]), { totalHt: 0.02, totalTva: 0.01, totalTtc: 0.03 });
  // Avoirs fractionnés à 5,5 % (test API « fige la TVA cumulée… ») : le second porte 0,49 €, et non 0,50 €.
  assert.deepEqual(totauxApercuAvoir([ligne('1', '9', '5,5')], [{ ventilationTva: [{ tauxTva: 5.5, totalHt: 9 }] }]), { totalHt: 9, totalTva: 0.49, totalTtc: 9.49 });
  // Plusieurs avoirs précédents s'additionnent : 0,01 puis 0,02 € à 20 % (base de 0,03 €, TVA 0,01), et
  // 0,02 € de plus (base de 0,05 €, TVA 0,01) ne portent pas de TVA ; le premier seul en donnerait 0,01.
  assert.deepEqual(totauxApercuAvoir([ligne('1', '0,02', '20')], [{ ventilationTva: [{ tauxTva: 20, totalHt: 0.01 }] }, { ventilationTva: [{ tauxTva: 20, totalHt: 0.02 }] }]), { totalHt: 0.02, totalTva: 0, totalTtc: 0.02 });
});

// Contre-épreuve sur un grand nombre de montants : la TVA d'un avoir suivant égale la différence des
// TVA des bases cumulées, chacune calculée en fraction exacte et arrondie au centime le plus proche.
test('l’aperçu suit la règle d’arrondi exacte pour des bases et des taux variés', () => {
  const arrondiExact = (centimes: number, tauxMilliemes: number) => {
    const numerateur = BigInt(centimes) * BigInt(tauxMilliemes);
    return Number(numerateur / 100000n + (numerateur % 100000n >= 50000n ? 1n : 0n));
  };
  // Générateur mulberry32 (entiers sur 32 bits, Math.imul) : la suite est reproductible.
  let graine = 236;
  const hasard = (borne: number) => {
    graine = (graine + 0x6D2B79F5) | 0;
    let t = Math.imul(graine ^ (graine >>> 15), 1 | graine);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % borne;
  };
  for (let essai = 0; essai < 5000; essai += 1) {
    const [taux, milliemes] = [['20', 20000], ['10', 10000], ['5,5', 5500], ['2,1', 2100], ['8,5', 8500]][hasard(5)] as [string, number];
    const precedent = hasard(100000), ajout = 1 + hasard(100000);
    const attendu = arrondiExact(precedent + ajout, milliemes) - arrondiExact(precedent, milliemes);
    const prix = `${Math.floor(ajout / 100)},${String(ajout % 100).padStart(2, '0')}`;
    const { totalHt, totalTva } = totauxApercuAvoir([ligne('1', prix, taux)], [{ ventilationTva: [{ tauxTva: Number(taux.replace(',', '.')), totalHt: precedent / 100 }] }]);
    assert.equal(Math.round(totalHt * 100), ajout, `${prix} € HT`);
    assert.equal(Math.round(totalTva * 100), attendu, `${prix} € HT à ${taux} % après ${precedent / 100} €`);
  }
});
