// Tests unitaires des règles de saisie et des calculs : ils APPELLENT les fonctions
// exportées par le serveur compilé (dist/index.js) et vérifient ce qu'elles renvoient.
// Aucune base de données n'est nécessaire.
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import request from 'supertest';

const {
  app,
  clientPayload, contactPayload, sitePayload, companySettingsPayload,
  fuseauHoraireEntrepriseValide, jourCivilEntreprise, aujourdHuiEntreprise,
  anneeEntreprise, dateEmissionEstFuture, dateDemandeCurative,
  periodBounds, weekBoundsFrom,
  cataloguePayload, catalogueExtraPayload, catalogueFamily,
  commissionBaremeProgressif, computeChantierMetrics,
  parseBareme, serialiseBareme, validerBareme,
  arrondiCommercialLigneHt, centimesTtcLigne, devisPayload,
  libelleComptableValide,
} = await import('../dist/index.js');

test('date demandée : défaut selon le jour civil entreprise à minuit et format français strict', () => {
  // Wallis voit déjà le 1er mars tandis que le serveur UTC voit encore février.
  const now = new Date('2026-02-28T23:30:00.000Z');
  assert.equal(dateDemandeCurative(undefined, 'Pacific/Wallis', now), '2026-03-01T00:00:00.000Z');
  assert.equal(dateDemandeCurative('28-02-2026', 'Pacific/Wallis', now), '2026-02-28T00:00:00.000Z');
  // À 13 h UTC Wallis est déjà au 1er mars, Paris et UTC sont encore au 28 février :
  // un repli silencieux sur Paris/UTC doit refuser à tort la date de Wallis.
  const instantDiscriminant = new Date('2026-02-28T13:00:00.000Z');
  assert.equal(dateDemandeCurative('01-03-2026', 'Pacific/Wallis', instantDiscriminant), '2026-03-01T00:00:00.000Z');
  assert.equal(dateDemandeCurative('01-03-2026', 'Europe/Paris', instantDiscriminant), null);
  for (const value of ['2026-02-28', '2026-02-28T00:00:00Z', '29-02-2026', ' 28-02-2026', '', null]) {
    assert.equal(dateDemandeCurative(value, 'Pacific/Wallis', now), null);
  }
});

test('le libellé comptable refuse les contrôles CR, LF, TAB, NUL et DEL sans rejeter les accents', () => {
  assert.equal(libelleComptableValide('Ventes, pose; et entretien'), true);
  assert.equal(libelleComptableValide('Libellé d’entretien'), true);
  for (const controle of ['\r', '\n', '\t', '\u0000', '\u001f', '\u007f']) {
    assert.equal(libelleComptableValide(`Avant${controle}Après`), false);
    assert.equal(libelleComptableValide(`Avant${controle}`), false);
  }
});

test('limite les corps JSON à 5 Mo avec erreur 413 JSON même sans connexion à la base', async () => {
  const reponse = await request(app).post('/api/comptabilite/importer').set('Content-Type', 'application/json')
    .send(JSON.stringify({ lignes: [{ code: '899990', libelle: 'X'.repeat(5 * 1024 * 1024), nature: 'ACTIF' }] }));
  assert.equal(reponse.status, 413);
  assert.match(reponse.headers['content-type'], /application\/json/);
  assert.match(reponse.body.error, /volumineux|taille/i);
});

describe('Fiche client', () => {
  test('la raison sociale est obligatoire à la création', () => {
    assert.throws(() => clientPayload({}, true), /raison sociale est obligatoire/);
    assert.deepEqual(clientPayload({ raisonSociale: '  Noxia  ' }, true).raisonSociale, 'Noxia');
  });

  test('le SIREN doit faire exactement neuf chiffres', () => {
    assert.equal(clientPayload({ raisonSociale: 'X', siren: '123456789' }, true).siren, '123456789');
    assert.throws(() => clientPayload({ raisonSociale: 'X', siren: '1234' }, true), /SIREN/);
    assert.throws(() => clientPayload({ raisonSociale: 'X', siren: 'ABCDEFGHI' }, true), /SIREN/);
  });

  test('un SIREN saisi avec des espaces reste accepté', () => {
    // Format usuel sur un extrait Kbis : « 123 456 789 ».
    assert.equal(clientPayload({ raisonSociale: 'X', siren: '123 456 789' }, true).siren, '123456789');
  });

  test("l'e-mail est normalisé et validé", () => {
    assert.equal(clientPayload({ raisonSociale: 'X', email: '  Contact@Noxia.FR ' }, true).email, 'contact@noxia.fr');
    assert.throws(() => clientPayload({ raisonSociale: 'X', email: 'pas-un-email' }, true), /email/);
  });

  test('une modification ne touche que les champs envoyés', () => {
    const data = clientPayload({ telephone: '0102030405' });
    assert.deepEqual(Object.keys(data), ['telephone']);
  });
});

describe('Contacts et sites', () => {
  test('le nom du contact est obligatoire à la création', () => {
    assert.throws(() => contactPayload({}, true), /nom du contact est obligatoire/);
  });

  test('les rôles du contact doivent être des booléens', () => {
    assert.equal(contactPayload({ nom: 'Durand', estSignataire: true }, true).estSignataire, true);
    assert.throws(() => contactPayload({ nom: 'Durand', estSignataire: 'oui' }, true), /estSignataire/);
  });

  test("l'adresse d'un site est obligatoire à la création", () => {
    assert.throws(() => sitePayload({ nom: 'Siège' }, true), /adresse est obligatoire/);
    const site = sitePayload({ nom: 'Siège', adresse: '1 rue A', codePostal: '14000', ville: 'Caen' }, true);
    assert.equal(site.ville, 'Caen');
  });
});

describe('Identité de la société', () => {
  test('les couleurs doivent être des hexadécimaux à six chiffres', () => {
    assert.equal(companySettingsPayload({ couleurPrimaire: '#1E3A8A' }).couleurPrimaire, '#1e3a8a');
    assert.throws(() => companySettingsPayload({ couleurPrimaire: 'bleu' }), /Couleur invalide/);
    assert.throws(() => companySettingsPayload({ couleurPrimaire: '#fff' }), /Couleur invalide/);
  });

  test('un champ texte vide est enregistré comme absent, pas comme chaîne vide', () => {
    assert.equal(companySettingsPayload({ siret: '   ' }).siret, null);
  });

  test('n’accepte que les fuseaux des territoires français', () => {
    assert.equal(fuseauHoraireEntrepriseValide('Pacific/Noumea'), true);
    assert.equal(fuseauHoraireEntrepriseValide('America/Martinique'), true);
    assert.equal(fuseauHoraireEntrepriseValide('Europe/London'), false);
    assert.throws(() => companySettingsPayload({ fuseauHoraire: 'Europe/London' }), /Fuseau horaire invalide/);
  });
});

describe('Jours civils de l’entreprise', () => {
  test('calcule le jour dans le fuseau configuré, pas en UTC', () => {
    const instant = new Date('2026-09-11T14:32:32.863Z');
    assert.equal(jourCivilEntreprise(instant, 'Pacific/Noumea'), '2026-09-12');
    assert.equal(jourCivilEntreprise(instant, 'America/Martinique'), '2026-09-11');
  });

  test('permet de fixer l’instant de référence pour aujourd’hui', () => {
    const instant = new Date('2027-01-01T00:30:00.000Z');
    assert.equal(aujourdHuiEntreprise('America/Martinique', instant), '2026-12-31');
  });

  test('dérive l’année des références intervention et devis dans le fuseau de l’entreprise au nouvel an', () => {
    // Le même instant appartient déjà à 2027 à Nouméa, mais encore à 2026 en Martinique.
    // Les deux séquences annuelles (IYY et AYY) doivent donc choisir ces exercices, pas UTC.
    const instant = new Date('2026-12-31T13:30:00.000Z');
    assert.equal(anneeEntreprise(instant, 'Pacific/Noumea'), 2027, 'références I27 / A27 à Nouméa');
    assert.equal(anneeEntreprise(instant, 'America/Martinique'), 2026, 'références I26 / A26 en Martinique');
  });

  test('le refus de date future se règle sur le jour civil de l’entreprise, pas sur UTC', () => {
    // 11 septembre 21h37 UTC : il est déjà le 12 à Nouméa (UTC+11) et encore le 11 à Paris.
    // L'instant est injecté pour que ce test soit vrai à toute heure — sinon il ne serait
    // rouge que pendant la fenêtre de décalage, donc inutilisable.
    const instant = new Date('2026-09-11T21:37:00.000Z');
    const douze = '2026-09-12T00:00:00.000Z';
    assert.equal(dateEmissionEstFuture(douze, 'Pacific/Noumea', instant), false, 'le 12 est le jour même à Nouméa');
    assert.equal(dateEmissionEstFuture(douze, 'Europe/Paris', instant), true, 'le 12 est encore demain à Paris');
    // Et à l'ouest : le 11 est toujours le jour même en Martinique (UTC−4), jamais du futur.
    const onze = '2026-09-11T00:00:00.000Z';
    assert.equal(dateEmissionEstFuture(onze, 'America/Martinique', instant), false);
    assert.equal(dateEmissionEstFuture(douze, 'America/Martinique', instant), true);
  });
});

describe('Périodes et assiduité dans le fuseau de l’entreprise', () => {
  test('borne le mois du jour civil Wallis d’un instant injectable, pas du mois UTC', () => {
    // 28 février UTC au soir est déjà le 1er mars à Wallis (UTC+12).
    const instant = new Date('2026-02-28T23:30:00.000Z');
    const { start, endExclusive } = periodBounds('month', undefined, 'Pacific/Wallis', instant);
    assert.equal(start.toISOString(), '2026-03-01T00:00:00.000Z');
    assert.equal(endExclusive.toISOString(), '2026-04-01T00:00:00.000Z');
  });

  test('conserve une référence date-seule, même à l’ouest de UTC', () => {
    // Une date-seule est un jour métier, jamais un instant à relire dans le fuseau.
    // Gambier est à l'ouest : minuit UTC y est encore la veille, donc sans le
    // garde-fou d'une date-seule le mois basculerait sur février.
    const { start, endExclusive } = periodBounds('month', '2026-03-01', 'Pacific/Gambier', new Date('2026-02-28T23:30:00.000Z'));
    assert.equal(start.toISOString(), '2026-03-01T00:00:00.000Z');
    assert.equal(endExclusive.toISOString(), '2026-04-01T00:00:00.000Z');
  });

  test('calcule la semaine d’assiduité depuis le lundi Wallis d’un instant injectable', () => {
    // Dimanche UTC est déjà lundi 2 mars à Wallis : UTC choisirait la semaine précédente.
    const { monday, friday } = weekBoundsFrom(undefined, 'Pacific/Wallis', new Date('2026-03-01T12:30:00.000Z'));
    assert.equal(jourCivilEntreprise(monday, 'Pacific/Wallis'), '2026-03-02');
    assert.equal(jourCivilEntreprise(friday, 'Pacific/Wallis'), '2026-03-06');
  });
});

describe('Catalogue', () => {
  test('seules les trois familles connues sont acceptées', () => {
    assert.equal(catalogueFamily('articles'), 'articles');
    assert.equal(catalogueFamily('categories'), null);
    assert.equal(catalogueFamily('../users'), null);
  });

  test('référence et désignation sont obligatoires', () => {
    assert.throws(() => cataloguePayload({ nom: 'Sans référence' }), /obligatoires/);
  });

  test('un prix négatif ou non numérique est refusé', () => {
    assert.throws(() => cataloguePayload({ reference: 'A', nom: 'B', prixVenteHt: -1 }), /Prix de vente/);
    assert.throws(() => cataloguePayload({ reference: 'A', nom: 'B', prixVenteHt: 'gratuit' }), /Prix de vente/);
    assert.equal(cataloguePayload({ reference: 'A', nom: 'B', prixVenteHt: '149.90' }).prixVenteHt, 149.9);
  });

  test('la TVA vaut 20 % par défaut', () => {
    assert.equal(cataloguePayload({ reference: 'A', nom: 'B' }).tauxTva, 20);
  });

  test('chaque famille ajoute ses propres champs', () => {
    assert.ok('dureeIndicativeMin' in catalogueExtraPayload('prestations', {}));
    assert.ok('stockSuivi' in catalogueExtraPayload('articles', {}));
    assert.deepEqual(catalogueExtraPayload('equipements', { fabricant: ' Hikvision ' }), { fabricant: 'Hikvision' });
  });
});

describe('Rémunération commerciale', () => {
  const bareme = [{ plafond: 10000, taux: 10 }, { plafond: 20000, taux: 15 }];

  test('une marge nulle ou négative ne donne aucune commission', () => {
    assert.equal(commissionBaremeProgressif(0, bareme), 0);
    assert.equal(commissionBaremeProgressif(-5000, bareme), 0);
  });

  test('le barème est progressif, tranche par tranche', () => {
    // 10 000 à 10 % = 1 000 ; les 5 000 suivants à 15 % = 750.
    assert.equal(commissionBaremeProgressif(10000, bareme), 1000);
    assert.equal(commissionBaremeProgressif(15000, bareme), 1750);
  });

  test('franchir une tranche ne requalifie pas toute la marge', () => {
    // Le piège d'un barème mal écrit : 10 001 € ne doit pas passer d'un coup à 15 %.
    const juste = commissionBaremeProgressif(10001, bareme);
    assert.ok(juste > 1000 && juste < 1002, `commission inattendue : ${juste}`);
  });
});

describe('Métriques de chantier', () => {
  const chantier = {
    budgetGlobalVendu: 10000, budgetMaterielVendu: 4000, budgetMainOeuvreVendu: 6000, heuresVendues: 100,
    achats: [{ montantHT: 3000 }],
    pointages: [{ nbrHeures: 50, tauxHoraireApplique: 40 }],
  };

  test('la marge est masquée à qui n’a pas le droit de la voir', () => {
    const vue = computeChantierMetrics(chantier, { margeCommercialeActive: true, planningActif: true }, false);
    assert.equal(vue.margeCommerciale, null);
    assert.equal(vue.margeBrute, null);
    // Les dépenses, elles, restent visibles : ce n'est pas une donnée réservée.
    assert.equal(vue.totalDepenses, 5000);
  });

  test('la marge est calculée pour un profil autorisé', () => {
    const vue = computeChantierMetrics(chantier, { margeCommercialeActive: true, planningActif: true }, true);
    assert.equal(vue.margeCommerciale, 5000); // 10 000 vendus − (3 000 achats + 2 000 main d'œuvre)
    assert.equal(vue.margePct, 50);
  });

  test('la marge désactivée dans les paramètres masque le calcul même pour un admin', () => {
    const vue = computeChantierMetrics(chantier, { margeCommercialeActive: false, planningActif: true }, true);
    assert.equal(vue.margeCommerciale, null);
  });
});

describe('Barèmes de rémunération configurables', () => {
  test('un plafond null devient la tranche non plafonnée', () => {
    // JSON ne représente pas Infinity : la dernière tranche est stockée avec plafond null.
    const bareme = parseBareme([{ plafond: 20000, taux: 16 }, { plafond: null, taux: 25 }]);
    assert.equal(bareme[1].plafond, Infinity);
    assert.deepEqual(serialiseBareme(bareme), [{ plafond: 20000, taux: 16 }, { plafond: null, taux: 25 }]);
  });

  test('les tranches sont remises dans l’ordre des plafonds', () => {
    // Le calcul progressif suppose des plafonds croissants : un barème saisi dans le
    // désordre donnerait des commissions fausses sans lever d’erreur.
    const bareme = parseBareme([{ plafond: 30000, taux: 20 }, { plafond: 10000, taux: 10 }]);
    assert.deepEqual(bareme.map((t) => t.plafond), [10000, 30000]);
  });

  test('une tranche illisible est ignorée plutôt que de fausser le calcul', () => {
    assert.deepEqual(parseBareme([{ plafond: 100, taux: 'beaucoup' }, { plafond: 200, taux: 10 }]).length, 1);
    assert.deepEqual(parseBareme('pas un tableau'), []);
  });

  test('un barème vide ne produit aucune commission', () => {
    assert.equal(commissionBaremeProgressif(50000, []), 0);
  });

  test('la validation refuse ce qui donnerait des montants faux', () => {
    assert.throws(() => validerBareme([{ plafond: 100, taux: 150 }], 'Barème'), /taux/);
    assert.throws(() => validerBareme([{ plafond: 100, taux: -1 }], 'Barème'), /taux/);
    assert.throws(() => validerBareme([{ plafond: 30000, taux: 10 }, { plafond: 20000, taux: 20 }], 'Barème'), /croissants/);
    assert.throws(() => validerBareme([{ plafond: null, taux: 10 }, { plafond: null, taux: 20 }], 'Barème'), /une seule tranche/);
    assert.throws(() => validerBareme('rien', 'Barème'), /tableau/);
  });

  test('la validation accepte un barème vide et un barème valide', () => {
    assert.deepEqual(validerBareme([], 'Barème'), []);
    const ok = validerBareme([{ plafond: 20000, taux: 16 }, { plafond: '', taux: 25 }], 'Barème');
    assert.equal(ok.length, 2);
    assert.equal(ok[1].plafond, Infinity);
  });
});

describe('Arrondi commercial des lignes de facture', () => {
  test('arrondit exactement une demi-unité de centime vers le haut sans flottant', () => {
    assert.equal(arrondiCommercialLigneHt('0.5', '4.27'), 2.14);
    assert.equal(arrondiCommercialLigneHt('0.125', '4.12'), 0.52);
    assert.equal(centimesTtcLigne(9, '5.5'), 9.5);
    assert.equal(centimesTtcLigne(17.15, '10'), 18.87);
  });
});

describe('Arrondi commercial des devis', () => {
  test('arrondit 0,5 × 4,27 au centime et conserve HT + TVA = TTC au taux réduit', () => {
    const devis = devisPayload({
      clientId: 'client-test', objet: 'TEST Arrondi commercial',
      lignes: [{ designation: 'Demi-centime', nature: 'MAIN_OEUVRE', quantite: '0.5', prixUnitaireHt: '4.27', tauxTva: '5.5' }],
    });
    assert.equal(devis.lignesCalculees[0].totalHt, 2.14);
    assert.equal(devis.totalHt, 2.14);
    assert.equal(devis.totalTva, 0.12);
    assert.equal(devis.totalTtc, 2.26);
    assert.equal(Math.round((devis.totalHt + devis.totalTva) * 100) / 100, devis.totalTtc);
    assert.throws(() => devisPayload({ clientId: 'client-test', objet: 'TEST Invalide', lignes: [{ designation: 'Invalide', quantite: 0, prixUnitaireHt: 4.27, tauxTva: 5.5 }] }), /Ligne de devis invalide/);
  });

  test('refuse clairement les précisions incompatibles avec le calcul exact', () => {
    for (const ligne of [
      { designation: 'Quantité trop précise', quantite: '0.3333', prixUnitaireHt: '4.27', tauxTva: '5.5' },
      { designation: 'Prix trop précis', quantite: '1', prixUnitaireHt: '4.275', tauxTva: '5.5' },
      { designation: 'Taux trop précis', quantite: '1', prixUnitaireHt: '4.27', tauxTva: '5.5255' },
    ]) assert.throws(() => devisPayload({ clientId: 'client-test', objet: 'TEST Précision invalide', lignes: [ligne] }), /Ligne de devis invalide/);
  });

  test('arrondit le TTC de ligne du devis sur une demi-tranche', () => {
    const devis = devisPayload({ clientId: 'client-test', objet: 'TEST TTC de ligne', lignes: [{ designation: 'Demi-tranche TTC', nature: 'MAIN_OEUVRE', quantite: '1', prixUnitaireHt: '9.00', tauxTva: '5.5' }] });
    assert.equal(devis.lignesCalculees[0].totalTtc, 9.5);
  });

  test('calcule la TVA du devis sur la base cumulée du taux, pas en sommant les lignes', () => {
    const devis = devisPayload({ clientId: 'client-test', objet: 'TEST TVA agrégée', lignes: [
      { designation: 'Ligne A', nature: 'MAIN_OEUVRE', quantite: '1', prixUnitaireHt: '0.05', tauxTva: '10' },
      { designation: 'Ligne B', nature: 'MAIN_OEUVRE', quantite: '1', prixUnitaireHt: '0.05', tauxTva: '10' },
    ] });
    assert.equal(devis.totalHt, 0.1);
    assert.equal(devis.totalTva, 0.01);
    assert.equal(devis.totalTtc, 0.11);
  });
});
