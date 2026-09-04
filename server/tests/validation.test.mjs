// Tests unitaires des règles de saisie et des calculs : ils APPELLENT les fonctions
// exportées par le serveur compilé (dist/index.js) et vérifient ce qu'elles renvoient.
// Aucune base de données n'est nécessaire.
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

const {
  clientPayload, contactPayload, sitePayload, companySettingsPayload,
  cataloguePayload, catalogueExtraPayload, catalogueFamily,
  commissionBaremeProgressif, computeChantierMetrics,
} = await import('../dist/index.js');

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
