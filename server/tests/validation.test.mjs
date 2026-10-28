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
  anneeEntreprise, dateEmissionEstFuture, dateDemandeCurative, dateHeuresIntervention,
  periodBounds, weekBoundsFrom,
  cataloguePayload, catalogueExtraPayload, catalogueFamily,
  commissionBaremeProgressif, computeChantierMetrics, voitRentabilite, peutVoirFinance,
  parseBareme, serialiseBareme, validerBareme,
  arrondiCommercialLigneHt, centimesTtcLigne, devisPayload,
  libelleComptableValide, alerteGenerationVisites,
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

test('date des heures SAV : jour civil de la société admis, lendemain refusé, quel que soit le fuseau du serveur', () => {
  // À 13 h UTC, Wallis est déjà au 1er mars ; Paris et UTC sont encore au 28 février.
  const instant = new Date('2026-02-28T13:00:00.000Z');
  assert.equal(dateHeuresIntervention('01-03-2026', 'Pacific/Wallis', instant), '2026-03-01T00:00:00.000Z');
  assert.equal(dateHeuresIntervention('01-03-2026', 'Europe/Paris', instant), null);
  // À 5 h UTC, Tahiti est encore au 27 février : le 28, déjà commencé en UTC, y reste futur.
  const matin = new Date('2026-02-28T05:00:00.000Z');
  assert.equal(dateHeuresIntervention('28-02-2026', 'Pacific/Tahiti', matin), null);
  assert.equal(dateHeuresIntervention('27-02-2026', 'Pacific/Tahiti', matin), '2026-02-27T00:00:00.000Z');
  for (const value of ['31-02-2026', '', null, 12]) assert.equal(dateHeuresIntervention(value, 'Europe/Paris', instant), null);
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
    assert.deepEqual(clientPayload({ raisonSociale: '  Société Test  ' }, true).raisonSociale, 'Société Test');
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
    assert.equal(clientPayload({ raisonSociale: 'X', email: '  Contact@Exemple.FR ' }, true).email, 'contact@exemple.fr');
    assert.throws(() => clientPayload({ raisonSociale: 'X', email: 'pas-un-email' }, true), /email/);
  });

  test('une modification ne touche que les champs envoyés', () => {
    const data = clientPayload({ telephone: '0102030405' });
    assert.deepEqual(Object.keys(data), ['telephone']);
  });

  // Lot 6a-2 bis : case « pas de SIRET » d'un particulier.
  test('la case « pas de SIRET » est un booléen strict, incompatible avec un SIREN à la création', () => {
    assert.equal(clientPayload({ raisonSociale: 'X', sansSiret: true }, true).sansSiret, true);
    assert.equal(clientPayload({ raisonSociale: 'X', sansSiret: false, siren: '123456789' }, true).sansSiret, false);
    assert.equal('sansSiret' in clientPayload({ raisonSociale: 'X' }, true), false);
    for (const valeur of ['oui', 'true', 1, 0, null, {}]) {
      assert.throws(() => clientPayload({ raisonSociale: 'X', sansSiret: valeur }, true), /^Error: Champ client invalide : sansSiret$/);
      assert.throws(() => clientPayload({ sansSiret: valeur }), /^Error: Champ client invalide : sansSiret$/);
    }
    assert.throws(() => clientPayload({ raisonSociale: 'X', sansSiret: true, siren: '123 456 789' }, true), /^Error: Un client sans SIRET ne peut pas avoir de SIREN : videz le SIREN ou décochez la case\.$/);
    assert.equal(clientPayload({ raisonSociale: 'X', sansSiret: true, siren: '' }, true).siren, null);
    assert.throws(() => clientPayload({ sansSiret: true }, true), /nom complet est obligatoire/);
    // À la modification, la contradiction se juge sur la fiche entière, sous verrou, par la route.
    assert.deepEqual(clientPayload({ sansSiret: true }), { sansSiret: true });
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
    assert.deepEqual(catalogueExtraPayload('equipements', { fabricant: ' Hikvision ' }), { fabricant: 'Hikvision', prixAchatHt: null });
  });

  // Un prix d'achat laissé vide reste absent : `Number('')` vaudrait un achat gratuit, que la
  // ligne de devis reprendrait comme prix d'achat prévu (lot pilote 2).
  test('le prix d’achat est facultatif dans les trois familles, et un champ vide reste absent', () => {
    for (const famille of ['prestations', 'articles', 'equipements']) {
      assert.equal(catalogueExtraPayload(famille, {}).prixAchatHt, null, famille);
      assert.equal(catalogueExtraPayload(famille, { prixAchatHt: '' }).prixAchatHt, null, famille);
      assert.equal(catalogueExtraPayload(famille, { prixAchatHt: '  ' }).prixAchatHt, null, famille);
      assert.equal(catalogueExtraPayload(famille, { prixAchatHt: '12.5' }).prixAchatHt, 12.5, famille);
      assert.equal(catalogueExtraPayload(famille, { prixAchatHt: 0 }).prixAchatHt, 0, famille);
      assert.throws(() => catalogueExtraPayload(famille, { prixAchatHt: '-1' }), /Prix d'achat invalide/, famille);
    }
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

  // #198 : en nombres à virgule, 0,1 + 0,2 + 0,3 vaut 0,6000000000000001, mais 0,3 + 0,2 + 0,1
  // vaut 0,6. Un budget exactement consommé déclenchait ou non une alerte de dépassement
  // selon l'ordre des lignes.
  test('totaux au centime près, quel que soit l’ordre des lignes (#198)', () => {
    const params = { margeCommercialeActive: true, planningActif: true };
    for (const valeurs of [[0.1, 0.2, 0.3], [0.3, 0.2, 0.1], [0.2, 0.1, 0.3]]) {
      const vue = computeChantierMetrics({
        budgetGlobalVendu: 10, budgetMaterielVendu: 0.6, budgetMainOeuvreVendu: 0.6, heuresVendues: 0.6,
        achats: valeurs.map((montantHT) => ({ montantHT })),
        pointages: valeurs.map((nbrHeures) => ({ nbrHeures, tauxHoraireApplique: 1 })),
      }, params, true);
      assert.deepEqual(
        [vue.materielReel, vue.heuresRealisees, vue.moReel, vue.totalDepenses, vue.diffHeures, vue.margeCommerciale],
        [0.6, 0.6, 0.6, 1.2, 0, 8.8],
        `ordre ${valeurs.join(', ')}`,
      );
      for (const alerte of ['MATERIEL_DEPASSE', 'HEURES_DEPASSEES', 'MAIN_OEUVRE_DEPASSEE']) {
        assert.ok(!vue.alertes.includes(alerte), `${alerte} à budget exactement consommé (ordre ${valeurs.join(', ')})`);
      }
    }
    // Heures × taux : 1,1 h × 1,10 € = 1,21 € exactement (1,2100000000000002 en flottant).
    const produit = computeChantierMetrics({
      budgetGlobalVendu: 0, budgetMaterielVendu: 0, budgetMainOeuvreVendu: 1.21, heuresVendues: 1.1,
      achats: [], pointages: [{ nbrHeures: 1.1, tauxHoraireApplique: 1.1 }],
    }, params, true);
    assert.equal(produit.moReel, 1.21);
    assert.ok(!produit.alertes.includes('MAIN_OEUVRE_DEPASSEE'));
  });
});

describe('Destinataires de la rentabilité d’un chantier', () => {
  // Organisation : Régional → Secteur → Conducteur ; le chantier est confié au conducteur.
  const chantier = { responsableId: 'conducteur' };
  const tous = { rentabiliteConducteur: true, rentabiliteHierarchie: true, rentabiliteDirecteurs: true };
  const session = (id, role, equipeIds = []) => ({ user: { id, role, equipeIds } });
  const comptes = {
    administrateur: session('admin', 'ADMIN'),
    superadministrateur: session('super', 'SUPERADMIN'),
    directeur: session('dir', 'DIRECTEUR'),
    conducteur: session('conducteur', 'CONDUCTEUR_TRAVAUX'),
    secteur: session('secteur', 'RESPONSABLE', ['conducteur']),
    regional: session('regional', 'RESPONSABLE', ['secteur', 'conducteur']),
    'responsable d’une autre branche': session('autre', 'RESPONSABLE', ['autre.conducteur']),
    'autre conducteur': session('autre.conducteur', 'CONDUCTEUR_TRAVAUX'),
    commercial: session('commercial', 'COMMERCIAL'),
    // Un rattachement ne donne rien à un rôle sans périmètre hiérarchique, et un technicien
    // ne voit jamais de montant, même désigné par erreur sur le chantier.
    'directeur commercial supérieur': session('dc', 'DIRECTEUR_COMMERCIAL', ['conducteur']),
    'technicien désigné': session('conducteur', 'TECHNICIEN'),
  };
  const voient = (params, cible = chantier) => Object.entries(comptes).filter(([, req]) => voitRentabilite(req, cible, params)).map(([nom]) => nom);

  test('par défaut : administrateurs, directeur, conducteur du chantier et toute sa chaîne', () => {
    assert.deepEqual(voient(tous), ['administrateur', 'superadministrateur', 'directeur', 'conducteur', 'secteur', 'regional']);
  });

  test('chaque catégorie se retire seule ; les administrateurs restent toujours destinataires', () => {
    assert.deepEqual(voient({ ...tous, rentabiliteConducteur: false }), ['administrateur', 'superadministrateur', 'directeur', 'secteur', 'regional']);
    assert.deepEqual(voient({ ...tous, rentabiliteHierarchie: false }), ['administrateur', 'superadministrateur', 'directeur', 'conducteur']);
    assert.deepEqual(voient({ ...tous, rentabiliteDirecteurs: false }), ['administrateur', 'superadministrateur', 'conducteur', 'secteur', 'regional']);
    assert.deepEqual(voient({ rentabiliteConducteur: false, rentabiliteHierarchie: false, rentabiliteDirecteurs: false }), ['administrateur', 'superadministrateur']);
  });

  test('un responsable chargé lui-même du chantier relève de la catégorie conducteur', () => {
    const sien = { responsableId: 'secteur' };
    assert.equal(voitRentabilite(comptes.secteur, sien, tous), true);
    assert.equal(voitRentabilite(comptes.secteur, sien, { ...tous, rentabiliteConducteur: false }), false);
    assert.equal(voitRentabilite(comptes.regional, sien, { ...tous, rentabiliteConducteur: false }), true, 'son propre responsable le voit toujours au titre de la chaîne');
  });

  test('un chantier sans conducteur n’a de destinataires que l’administration et la direction', () => {
    assert.deepEqual(voient(tous, { responsableId: null }), ['administrateur', 'superadministrateur', 'directeur']);
  });

  test('une clé d’intégration suit son scope finances:read, quels que soient les réglages', () => {
    const aucun = { rentabiliteConducteur: false, rentabiliteHierarchie: false, rentabiliteDirecteurs: false };
    assert.equal(voitRentabilite({ apiKey: { scopes: ['chantiers:read', 'finances:read'] } }, chantier, aucun), true);
    assert.equal(voitRentabilite({ apiKey: { scopes: ['chantiers:read'] } }, chantier, tous), false);
    assert.equal(voitRentabilite({}, chantier, tous), false, 'sans porteur identifié');
  });
});

describe('Marge estimée en fin de chantier et alertes de suivi', () => {
  const params = { margeCommercialeActive: true, planningActif: true, tauxAcompteDefaut: 30, seuilMargeFaible: 15, joursSansSaisie: 14 };
  const contexte = (surcharge = {}) => ({ aujourdhui: '2026-10-13', fuseauHoraire: 'Europe/Paris', coutHoraireSociete: 45, ratioMaterielHistorique: 0.7, ...surcharge });
  // Vendu 10 000 € : 4 000 € de matériel, 6 000 € de main-d'œuvre pour 100 h.
  const chantier = (surcharge = {}) => ({
    statut: 'EN_COURS', dateDebut: '2026-10-01T08:00:00.000Z',
    budgetGlobalVendu: 10000, budgetMaterielVendu: 4000, budgetMainOeuvreVendu: 6000, heuresVendues: 100,
    achats: [{ montantHT: 1000, date: '2026-10-10T00:00:00.000Z' }],
    pointages: [{ nbrHeures: 20, tauxHoraireApplique: 40, date: '2026-10-12T00:00:00.000Z' }],
    ...surcharge,
  });

  test('main-d’œuvre au coût horaire du chantier, matériel au ratio des chantiers terminés', () => {
    const vue = computeChantierMetrics(chantier(), params, true, contexte());
    // 100 h × 40 € = 4 000 € ; 4 000 € × 0,7 = 2 800 € ; 10 000 − 6 800 = 3 200 €.
    assert.equal(vue.estimation.coutMainOeuvreAttendu, 4000);
    assert.equal(vue.estimation.coutMaterielAttendu, 2800);
    assert.equal(vue.estimation.sourceCoutHoraire, 'CHANTIER');
    assert.equal(vue.estimation.sourceMateriel, 'HISTORIQUE');
    assert.equal(vue.margeEstimee, 3200);
    assert.equal(vue.margeEstimeePct, 32);
    assert.ok(!vue.alertes.includes('MARGE_FAIBLE'));
  });

  test('sans heure saisie : coût horaire moyen de la société, puis budget main-d’œuvre vendu', () => {
    const societe = computeChantierMetrics(chantier({ pointages: [] }), params, true, contexte());
    assert.equal(societe.estimation.sourceCoutHoraire, 'SOCIETE');
    assert.equal(societe.estimation.coutMainOeuvreAttendu, 4500);
    assert.equal(societe.margeEstimee, 10000 - 4500 - 2800);
    const vendu = computeChantierMetrics(chantier({ pointages: [] }), params, true, contexte({ coutHoraireSociete: null }));
    assert.equal(vendu.estimation.sourceCoutHoraire, 'VENDU');
    assert.equal(vendu.estimation.coutMainOeuvreAttendu, 6000);
    // 10 000 − 6 000 − 2 800 = 1 200 €, soit 12 % : sous le seuil de 15 %.
    assert.equal(vendu.margeEstimeePct, 12);
    assert.ok(vendu.alertes.includes('MARGE_FAIBLE'));
  });

  test('sans chantier terminé, le matériel restant est compté à son prix de vente', () => {
    const vue = computeChantierMetrics(chantier(), params, true, contexte({ ratioMaterielHistorique: null }));
    assert.equal(vue.estimation.sourceMateriel, 'VENDU');
    assert.equal(vue.estimation.ratioMateriel, 1);
    assert.equal(vue.estimation.coutMaterielAttendu, 4000);
    assert.equal(vue.margeEstimee, 2000);
  });

  test('le coût attendu d’un poste ne descend jamais sous le réel déjà engagé', () => {
    const vue = computeChantierMetrics(chantier({
      achats: [{ montantHT: 5000, date: '2026-10-10T00:00:00.000Z' }],
      pointages: [{ nbrHeures: 120, tauxHoraireApplique: 40, date: '2026-10-12T00:00:00.000Z' }],
    }), params, true, contexte());
    assert.equal(vue.estimation.coutMaterielAttendu, 5000);
    assert.equal(vue.estimation.coutMainOeuvreAttendu, 4800);
    assert.equal(vue.margeEstimee, 200);
  });

  test('seuil de marge faible : réglable, retirable (la marge estimée négative reste signalée), et sans doublon avec la perte avérée', () => {
    const tendu = chantier({ pointages: [] });
    const sansSeuil = { ...params, seuilMargeFaible: null };
    assert.ok(!computeChantierMetrics(tendu, sansSeuil, true, contexte({ coutHoraireSociete: null })).alertes.includes('MARGE_FAIBLE'));
    assert.ok(!computeChantierMetrics(tendu, { ...params, seuilMargeFaible: 10 }, true, contexte({ coutHoraireSociete: null })).alertes.includes('MARGE_FAIBLE'));
    // Même sans seuil, une marge estimée négative reste signalée.
    const negatif = computeChantierMetrics(tendu, sansSeuil, true, contexte({ coutHoraireSociete: 80 }));
    assert.ok(negatif.margeEstimee < 0);
    assert.ok(negatif.alertes.includes('MARGE_FAIBLE'));
    // Déjà en perte : seule l'alerte la plus forte est portée.
    const perte = computeChantierMetrics(chantier({ achats: [{ montantHT: 9500, date: '2026-10-10T00:00:00.000Z' }] }), params, true, contexte());
    assert.ok(perte.alertes.includes('EN_PERTE'));
    assert.ok(!perte.alertes.includes('MARGE_FAIBLE'));
  });

  // #198 : 21 × (362,57 / 21) vaut 362,57000000000005 en flottant ; la marge estimée d'un chantier
  // vendu exactement à son coût attendu tombait à -5e-14, avec une alerte de marge faible.
  test('heures vendues faites au coût réel : marge estimée exactement nulle, sans alerte', () => {
    const vue = computeChantierMetrics(chantier({
      budgetGlobalVendu: 362.57, budgetMaterielVendu: 0, budgetMainOeuvreVendu: 362.57, heuresVendues: 21, achats: [],
      pointages: [{ nbrHeures: 20, tauxHoraireApplique: 17.26, date: '2026-10-12T00:00:00.000Z' }, { nbrHeures: 1, tauxHoraireApplique: 17.37, date: '2026-10-12T00:00:00.000Z' }],
    }), { ...params, seuilMargeFaible: null }, true, contexte());
    assert.equal(vue.estimation.coutMainOeuvreAttendu, 362.57);
    assert.ok(Object.is(vue.margeEstimee, 0), `marge estimée ${vue.margeEstimee}`);
    assert.ok(!vue.alertes.includes('MARGE_FAIBLE'));
  });

  test('un chantier terminé n’a plus de reste à faire ni de délai sans saisie', () => {
    const vue = computeChantierMetrics(chantier({ statut: 'TERMINE', achats: [{ montantHT: 1000, date: '2026-01-05T00:00:00.000Z' }] }), params, true, contexte());
    assert.equal(vue.margeEstimee, vue.margeCommerciale);
    assert.equal(vue.estimation.sourceMateriel, 'REEL');
    assert.equal(vue.joursSansSaisie, null);
    assert.ok(!vue.alertes.includes('SANS_SAISIE'));
  });

  test('délai sans saisie : dernière date métier active, à défaut le jour civil du début', () => {
    const a15jours = computeChantierMetrics(chantier({ achats: [{ montantHT: 10, date: '2026-09-28T00:00:00.000Z' }], pointages: [] }), params, false, contexte());
    assert.equal(a15jours.derniereSaisie, '2026-09-28');
    assert.equal(a15jours.joursSansSaisie, 15);
    assert.ok(a15jours.alertes.includes('SANS_SAISIE'));
    const a13jours = computeChantierMetrics(chantier({ achats: [{ montantHT: 10, date: '2026-09-30T00:00:00.000Z' }], pointages: [] }), params, false, contexte());
    assert.ok(!a13jours.alertes.includes('SANS_SAISIE'));
    // Une saisie archivée ne remet pas le compteur à zéro.
    const archive = computeChantierMetrics(chantier({ achats: [{ montantHT: 10, date: '2026-09-28T00:00:00.000Z' }, { montantHT: 10, date: '2026-10-12T00:00:00.000Z', archivedAt: '2026-10-12T10:00:00.000Z' }], pointages: [] }), params, false, contexte());
    assert.equal(archive.joursSansSaisie, 15);
    // Sans aucune saisie : un début converti le 28/09 à 23 h 30 UTC est le 29/09 à Paris.
    const instant = computeChantierMetrics(chantier({ achats: [], pointages: [], dateDebut: '2026-09-28T23:30:00.000Z' }), params, false, contexte());
    assert.equal(instant.derniereSaisie, null);
    assert.equal(instant.joursSansSaisie, 14);
    assert.ok(instant.alertes.includes('SANS_SAISIE'));
    // Une date-seule corrigée à la main n'est pas relue dans un fuseau.
    const dateSeule = computeChantierMetrics(chantier({ achats: [], pointages: [], dateDebut: '2026-09-30T00:00:00.000Z' }), params, false, contexte({ fuseauHoraire: 'America/Guadeloupe' }));
    assert.equal(dateSeule.joursSansSaisie, 13);
    // Alerte désactivée : le délai reste lisible, sans alerte.
    const desactive = computeChantierMetrics(chantier({ achats: [{ montantHT: 10, date: '2026-09-01T00:00:00.000Z' }], pointages: [] }), { ...params, joursSansSaisie: null }, false, contexte());
    assert.equal(desactive.joursSansSaisie, 42);
    assert.ok(!desactive.alertes.includes('SANS_SAISIE'));
  });

  test('l’estimation et la marge faible restent masquées à qui ne voit pas la marge', () => {
    const vue = computeChantierMetrics(chantier({ pointages: [] }), params, false, contexte({ coutHoraireSociete: null }));
    assert.equal(vue.margeEstimee, null);
    assert.equal(vue.margeEstimeePct, null);
    assert.equal(vue.estimation, null);
    assert.ok(!vue.alertes.includes('MARGE_FAIBLE'));
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

  // Lot pilote 2 : une ligne reprise du catalogue porte sa fiche, son unité et, en option, un
  // prix d'achat prévu. La validation reste pure ; la fiche est résolue en base par l'API.
  test('lignes reprises du catalogue : fiche, unité et prix d’achat prévu validés', () => {
    const base = { designation: 'Caméra dôme', nature: 'FOURNITURE', quantite: '2', prixUnitaireHt: '120', tauxTva: '20' };
    const devis = devisPayload({ clientId: 'client-test', objet: 'TEST Catalogue', lignes: [
      { ...base, unite: ' pièce ', catalogueFamille: 'equipements', catalogueId: 'fiche-1', prixAchatUnitaireHt: '80,50' },
      { ...base, ligneId: 'ligne-1' },
      { ...base, prixAchatUnitaireHt: null },
    ] });
    assert.equal(devis.lignesCalculees[0].unite, 'pièce');
    assert.deepEqual(devis.references, [
      { ligneId: null, catalogue: { famille: 'equipements', id: 'fiche-1' }, prixAchatUnitaireHt: 80.5 },
      { ligneId: 'ligne-1', catalogue: null, prixAchatUnitaireHt: undefined },
      { ligneId: null, catalogue: null, prixAchatUnitaireHt: null },
    ]);
    for (const [ligne, message] of [
      [{ ...base, catalogueFamille: 'inconnue', catalogueId: 'x' }, /Fiche catalogue de la ligne invalide/],
      [{ ...base, catalogueFamille: 'articles' }, /Fiche catalogue de la ligne invalide/],
      [{ ...base, prixAchatUnitaireHt: '-3' }, /Prix d’achat prévu invalide/],
      [{ ...base, prixAchatUnitaireHt: '1.234' }, /Prix d’achat prévu invalide/],
      [{ ...base, unite: 'u'.repeat(41) }, /Ligne de devis invalide/],
      [{ ...base, designation: 'd'.repeat(501) }, /Ligne de devis invalide/],
      [{ ...base, quantite: '999999999', prixUnitaireHt: '9999999999' }, /hors des limites/],
    ]) assert.throws(() => devisPayload({ clientId: 'client-test', objet: 'TEST Catalogue invalide', lignes: [ligne] }), message);
  });
});

// Lot « devis au temps passé » : la ligne au temps passé est validée sans prix ; son prix, sa TVA et ses
// totaux sont fixés par le serveur depuis la main d'œuvre, à la résolution en base (tests HTTP).
describe('Devis au temps passé : saisie de la ligne', () => {
  const ligne = { tempsPasse: true, designation: 'Main d’œuvre au temps passé', quantite: '1', tarifTempsPasse: 'HORS_CONTRAT', catalogueFamille: 'prestations', catalogueId: 'mo-1' };
  test('la ligne au temps passé attend son prix du serveur ; ses totaux et ceux du devis aussi', () => {
    const devis = devisPayload({ clientId: 'client-test', objet: 'TEST Temps passé', auTempsPasse: true, lignes: [ligne, { designation: 'Câble', nature: 'FOURNITURE', quantite: '2', prixUnitaireHt: '3', tauxTva: '20' }] });
    assert.equal(devis.auTempsPasse, true);
    assert.deepEqual(devis.lignesCalculees[0], { ordre: 0, designation: 'Main d’œuvre au temps passé', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: null, tauxTva: null, totalHt: null, totalTtc: null, unite: null });
    assert.deepEqual(devis.references[0], { ligneId: null, catalogue: { famille: 'prestations', id: 'mo-1' }, prixAchatUnitaireHt: undefined, tempsPasse: { tarif: 'HORS_CONTRAT', prixUnitaireHt: null, tauxTva: null } });
    assert.deepEqual([devis.totalHt, devis.totalTva, devis.totalTtc], [null, null, null]);
    // Le prix et la TVA envoyés sont gardés pour être comparés à ceux de la main d'œuvre.
    const avecPrix = devisPayload({ clientId: 'client-test', objet: 'TEST Temps passé', auTempsPasse: true, lignes: [{ ...ligne, prixUnitaireHt: '45,50', tauxTva: '20' }] });
    assert.deepEqual(avecPrix.references[0].tempsPasse, { tarif: 'HORS_CONTRAT', prixUnitaireHt: 45.5, tauxTva: 20 });
    // Une ligne existante peut omettre son tarif et sa fiche : elle garde les siens.
    const existante = devisPayload({ clientId: 'client-test', objet: 'TEST Temps passé', lignes: [{ tempsPasse: true, ligneId: 'l-1', designation: 'Ligne gardée', quantite: '2.5' }] });
    assert.deepEqual([existante.auTempsPasse, existante.references[0].tempsPasse, existante.lignesCalculees[0].quantite], [undefined, { tarif: null, prixUnitaireHt: null, tauxTva: null }, 2.5]);
    // Prix, TVA, unité ou nature laissés blancs, prix d'achat nul ou vide : comme absents.
    for (const extra of [{ prixUnitaireHt: '  ', tauxTva: ' ', unite: ' ', nature: ' ' }, { prixAchatUnitaireHt: null }, { prixAchatUnitaireHt: '' }]) {
      const vide = devisPayload({ clientId: 'client-test', objet: 'TEST Temps passé', auTempsPasse: true, lignes: [{ ...ligne, ...extra }] });
      assert.deepEqual(vide.references[0].tempsPasse, { tarif: 'HORS_CONTRAT', prixUnitaireHt: null, tauxTva: null }, JSON.stringify(extra));
    }
    // Une ligne dont le drapeau vaut false ou null est une ligne ordinaire, chiffrée comme les autres.
    for (const drapeau of [false, null]) {
      const ordinaire = devisPayload({ clientId: 'client-test', objet: 'TEST Ordinaire', lignes: [{ tempsPasse: drapeau, designation: 'Câble', nature: 'FOURNITURE', quantite: '2', prixUnitaireHt: '3', tauxTva: '20' }] });
      assert.deepEqual([ordinaire.lignesCalculees[0].totalHt, ordinaire.references[0].tempsPasse, ordinaire.totalTtc], [6, undefined, 7.2], String(drapeau));
    }
  });

  test('une quantité positive au millième, l’heure, à l’heure hors contrat ou sous contrat, d’une prestation du catalogue', () => {
    // Le minimum et le pas du devis bornent ensuite la quantité (exigerQuantiteTempsPasse, plus bas).
    assert.equal(devisPayload({ clientId: 'client-test', objet: 'TEST', auTempsPasse: true, lignes: [{ ...ligne, quantite: '0.25' }] }).lignesCalculees[0].quantite, 0.25);
    for (const [extra, message] of [
      [{ quantite: '0' }, /Ligne de devis invalide/],
      [{ quantite: '1.0001' }, /Ligne de devis invalide/],
      [{ tarifTempsPasse: 'JOUR_HORS_CONTRAT' }, /forfait jour n’est pas proposé/],
      [{ tarifTempsPasse: undefined }, /forfait jour n’est pas proposé/],
      [{ unite: 'h' }, /comptée à l’heure/],
      [{ nature: 'FOURNITURE' }, /comptée à l’heure/],
      [{ catalogueFamille: 'articles' }, /reprend une main d’œuvre du catalogue/],
      [{ catalogueFamille: undefined, catalogueId: undefined }, /reprend une main d’œuvre du catalogue/],
      [{ prixUnitaireHt: '-1' }, /Ligne de devis invalide/],
      [{ tauxTva: '100.01' }, /Ligne de devis invalide/],
      [{ prixAchatUnitaireHt: '5' }, /pas de prix d’achat prévu/],
      // Prix d'achat envoyé : lu sur dix chiffres entiers, comme sur une ligne saisie, puis refusé ; au-delà, illisible.
      [{ prixAchatUnitaireHt: '9999999999.99' }, /pas de prix d’achat prévu/],
      [{ prixAchatUnitaireHt: '10000000000' }, /Prix d’achat prévu invalide/],
      // Blancs autour retirés : le prix d'achat est lu, puis refusé ; fait de blancs seuls, il n'est pas vide : illisible.
      [{ prixAchatUnitaireHt: ' 5 ' }, /pas de prix d’achat prévu/],
      [{ prixAchatUnitaireHt: '   ' }, /Prix d’achat prévu invalide/],
      [{ tempsPasse: 1 }, /« tempsPasse » doit valoir true ou false/],
    ]) assert.throws(() => devisPayload({ clientId: 'client-test', objet: 'TEST Temps passé invalide', auTempsPasse: true, lignes: [{ ...ligne, ...extra }] }), message, JSON.stringify(extra));
    assert.throws(() => devisPayload({ clientId: 'client-test', objet: 'TEST', auTempsPasse: 'oui', lignes: [ligne] }), /« auTempsPasse » doit valoir true ou false/);
    assert.equal(devisPayload({ clientId: 'client-test', objet: 'TEST', auTempsPasse: true, lignes: [{ ...ligne, quantite: '1', prixUnitaireHt: '', tauxTva: null, unite: ' heure ', nature: 'MAIN_OEUVRE' }] }).lignesCalculees[0].quantite, 1);
  });
});

describe('Temps passé : temps minimum facturé, pas, quantité de la ligne et mention (lot « facture au temps passé »)', async () => {
  const tp = await import('../dist/src/domaines/devis/tempsPasse.js');

  test('réglages : pas de 15, 30, 45 ou 60 minutes ou vide ; minimum multiple de 15 de 15 minutes à 8 heures, vide revenant à une heure', () => {
    for (const [brut, attendu] of [[null, null], ['', null], [15, 15], ['30', 30], [' 45 ', 45], ['060', 60]]) assert.equal(tp.lireReglagePasTempsPasse(brut), attendu, String(brut));
    for (const brut of [0, 1, 10, 14, 16, 59, 61, 90, '1e1', 'abc', '   ', 1.5, true]) assert.throws(() => tp.lireReglagePasTempsPasse(brut), /15, 30, 45 ou 60 minutes/, String(brut));
    for (const [brut, attendu] of [[null, 60], ['', 60], [15, 15], [480, 480], ['0090', 90], [' 120 ', 120]]) assert.equal(tp.lireReglageTempsMinimum(brut), attendu, String(brut));
    for (const brut of [0, 10, 14, 16, 50, 481, 495, -15, 1.5, 'abc', '   ', true]) assert.throws(() => tp.lireReglageTempsMinimum(brut), /multiple de 15, de 15 minutes à 8 heures/, String(brut));
  });

  test('réglages du jour figés par un devis : pas vide ou non admis refusé, minimum repris', () => {
    assert.throws(() => tp.reglagesTempsPasseDeLaSociete(null), /Réglez d’abord le pas du temps passé/);
    assert.throws(() => tp.reglagesTempsPasseDeLaSociete({ pasTempsPasseMinutes: null, tempsMinimumMinutes: 60 }), /Réglez d’abord le pas du temps passé/);
    assert.throws(() => tp.reglagesTempsPasseDeLaSociete({ pasTempsPasseMinutes: 10, tempsMinimumMinutes: 60 }), /Le pas du temps passé réglé \(10 minutes\) n’est plus admis/);
    assert.throws(() => tp.reglagesTempsPasseDeLaSociete({ pasTempsPasseMinutes: 1, tempsMinimumMinutes: 60 }), /\(1 minute\) n’est plus admis/);
    assert.deepEqual(tp.reglagesTempsPasseDeLaSociete({ pasTempsPasseMinutes: 45, tempsMinimumMinutes: 30 }), { pasTempsPasseMinutes: 45, tempsMinimumMinutes: 30 });
  });

  test('quantité de la ligne : le minimum figé puis des multiples du pas ; une heure au moins sans minimum (devis antérieur)', () => {
    const r = { tempsMinimumMinutes: 60, pasTempsPasseMinutes: 15 };
    for (const q of [1, 1.25, 1.5, 1.75, 2, 10]) assert.doesNotThrow(() => tp.exigerQuantiteTempsPasse(q, r), String(q));
    for (const q of [0.25, 0.75, 0.999, 1.001, 1.1, 1.3, 1.333]) assert.throws(() => tp.exigerQuantiteTempsPasse(q, r), /\(1 h\), puis des tranches de 15 minutes : en heures, 1 ; 1,25 ; 1,5…/, String(q));
    const r2 = { tempsMinimumMinutes: 30, pasTempsPasseMinutes: 45 };
    for (const q of [0.5, 1.25, 2, 2.75]) assert.doesNotThrow(() => tp.exigerQuantiteTempsPasse(q, r2), String(q));
    for (const q of [1, 0.75, 1.5]) assert.throws(() => tp.exigerQuantiteTempsPasse(q, r2), /\(30 min\), puis des tranches de 45 minutes : en heures, 0,5 ; 1,25 ; 2…/, String(q));
    const ancien = { tempsMinimumMinutes: null, pasTempsPasseMinutes: 10 };
    for (const q of [1, 1.001, 1.333, 10.125]) assert.doesNotThrow(() => tp.exigerQuantiteTempsPasse(q, ancien), String(q));
    assert.throws(() => tp.exigerQuantiteTempsPasse(0.999, ancien), /au moins une heure/);
  });

  test('durée et mention : minimum et pas, total minimum ou estimé ; texte d’alors sans minimum', () => {
    for (const [minutes, texte] of [[15, '15 min'], [30, '30 min'], [60, '1 h'], [75, '1 h 15 min'], [90, '1 h 30 min'], [480, '8 h']]) assert.equal(tp.dureeTempsPasse(minutes), texte);
    const devis = (quantite, extra = {}) => ({ auTempsPasse: true, pasTempsPasseMinutes: 15, tempsMinimumMinutes: 60, lignes: [{ tempsPasse: false, tarifTempsPasse: null, prixUnitaireHt: 3, quantite: 2 }, { tempsPasse: true, tarifTempsPasse: 'HORS_CONTRAT', prixUnitaireHt: 45.5, quantite }], ...extra });
    const regle = (pas = 15, minimum = '1 h', tarif = 'hors contrat', prix = '45,50 €') => `Devis au temps passé : au prix de ${prix} HT de l’heure (tarif à l’heure ${tarif}), hors matériel, le temps passé se facture avec un minimum de ${minimum}, puis par tranches de ${pas} minutes au-delà, toute tranche commencée étant due.`;
    assert.equal(tp.mentionTempsPasse(devis(1)), `${regle()} Le total de ce devis est un minimum.`);
    assert.equal(tp.mentionTempsPasse(devis(1.5)), `${regle()} Ce devis prévoit 1 h 30 min : son total est une estimation, la facture reprenant le temps réellement passé, avec au moins le minimum.`);
    assert.equal(tp.mentionTempsPasse(devis(0.5, { tempsMinimumMinutes: 30, pasTempsPasseMinutes: 45 })), `${regle(45, '30 min')} Le total de ce devis est un minimum.`);
    assert.equal(tp.mentionTempsPasse(devis(8, { tempsMinimumMinutes: 480, pasTempsPasseMinutes: 60 })), `${regle(60, '8 h')} Le total de ce devis est un minimum.`);
    assert.equal(tp.mentionTempsPasse(devis(1, { tempsMinimumMinutes: null, pasTempsPasseMinutes: 10 })), 'Devis au temps passé : une heure minimum facturée au prix de 45,50 € HT de l’heure (tarif à l’heure hors contrat), hors matériel ; au-delà de la première heure, le temps passé se facture par tranches de 10 minutes, toute tranche commencée étant due. Le total de ce devis est un minimum.');
    assert.equal(tp.mentionTempsPasse(devis(1, { tempsMinimumMinutes: undefined, pasTempsPasseMinutes: 1 })).includes('par tranches de 1 minute,'), true);
    assert.equal(tp.mentionTempsPasse(devis(1, { auTempsPasse: false })), null);
    assert.equal(tp.mentionTempsPasse(devis(1, { pasTempsPasseMinutes: null })), null);
  });
});

test('peutVoirFinance : jamais pour un technicien, même avec un accès financier enregistré', () => {
  assert.equal(peutVoirFinance({ role: 'TECHNICIEN', accesFinance: true }), false);
  assert.equal(peutVoirFinance({ role: 'CONDUCTEUR_TRAVAUX', accesFinance: true }), true);
  assert.equal(peutVoirFinance({ role: 'CONDUCTEUR_TRAVAUX', accesFinance: false }), false);
  assert.equal(peutVoirFinance({ role: 'SUPERADMIN', accesFinance: false }), true);
});

// Ajout du second audit interne de #293 : l'auteur du journal SAV.
describe('Facture au temps passé : heures facturées (lot « facture au temps passé », seconde PR)', async () => {
  const { grilleTempsPasse, minutesFacturees, heuresDesMinutes } = await import('../dist/src/domaines/factures/tempsPasse.js');
  const facturees = (minutesSaisies, devis, quantiteLigne = 1) => {
    const minutes = minutesFacturees(minutesSaisies, grilleTempsPasse(devis, quantiteLigne));
    return [minutes.toString(), heuresDesMinutes(minutes).toString()];
  };

  test('devis fait depuis le temps minimum : au moins le minimum, puis toute tranche du pas commencée au-delà', () => {
    const devis = { tempsMinimumMinutes: 60, pasTempsPasseMinutes: 15 };
    // Décision « Une fois au total » : 40 min puis 30 min font 1 h 10, soit 1 h 15 facturée.
    assert.deepEqual(facturees(70, devis), ['75', '1.25']);
    for (const [saisies, attendu] of [[0, ['60', '1']], [10, ['60', '1']], [60, ['60', '1']], [60.6, ['75', '1.25']], [75, ['75', '1.25']], [75.6, ['90', '1.5']], [480, ['480', '8']]]) {
      assert.deepEqual(facturees(saisies, devis), attendu, `${saisies} min`);
    }
    // Minimum de 30 min et pas de 45 min : l'ancre est le minimum, et non la première heure.
    const court = { tempsMinimumMinutes: 30, pasTempsPasseMinutes: 45 };
    for (const [saisies, attendu] of [[20, ['30', '0.5']], [31.2, ['75', '1.25']], [75, ['75', '1.25']], [76.2, ['120', '2']]]) {
      assert.deepEqual(facturees(saisies, court), attendu, `${saisies} min`);
    }
    // Les heures de la ligne du devis ne sont qu'une prévision : elles ne changent rien au plancher.
    assert.deepEqual(facturees(10, devis, 2), ['60', '1']);
  });

  test('devis antérieur au temps minimum : les heures de sa ligne pour plancher, puis le pas au-delà', () => {
    // Décision « Les heures de la ligne » : la mention annonçait 2 heures minimum facturées.
    const ancien = { tempsMinimumMinutes: null, pasTempsPasseMinutes: 45 };
    for (const [saisies, attendu] of [[30, ['120', '2']], [120, ['120', '2']], [120.6, ['165', '2.75']], [165, ['165', '2.75']], [166.2, ['210', '3.5']]]) {
      assert.deepEqual(facturees(saisies, ancien, 2), attendu, `${saisies} min`);
    }
    // Une ligne d'une heure : la règle d'alors (une heure au moins, puis le pas).
    assert.deepEqual(facturees(61.2, { tempsMinimumMinutes: null, pasTempsPasseMinutes: 7 }, 1), ['67', '1.117']);
    // Ligne au millième (1,333 h, soit 79,98 min) et pas de 20 minutes, qui divise l'heure mais ne vaut pas un
    // nombre entier de millièmes d'heure : la quantité s'arrondit au millième le plus proche.
    const vingt = { tempsMinimumMinutes: null, pasTempsPasseMinutes: 20 };
    assert.deepEqual(facturees(60, vingt, '1.333'), ['79.98', '1.333']);
    assert.deepEqual(facturees(81, vingt, '1.333'), ['99.98', '1.666']);
    assert.deepEqual(facturees(100.2, vingt, '1.333'), ['119.98', '2']);
    // L'arrondi vient du pas, et non de la ligne : sur une ligne d'une heure, une tranche de 20 minutes
    // s'arrondit (1 h 20, soit 1,333 h), une tranche de 9 minutes, qui ne divise pas l'heure, est exacte
    // (1 h 09, soit 1,15 h). La quantité n'est exacte que pour un pas multiple de 3 minutes.
    assert.deepEqual(facturees(66, vingt, 1), ['80', '1.333']);
    assert.deepEqual(facturees(61, { tempsMinimumMinutes: null, pasTempsPasseMinutes: 9 }, 1), ['69', '1.15']);
  });
});

describe('Lot pilote 5 : auteur du journal SAV', () => {
  // Décision de Nelson du 22-10-2026 : la génération automatique écrit au nom du compte système.
  test('la génération automatique écrit au nom du compte système ; une requête sans compte est refusée', async () => {
    const { auteurJournalSav } = await import('../dist/src/domaines/interventions/metier.js');
    const { COMPTE_SYSTEME_ID, NOM_COMPTE_SYSTEME } = await import('../dist/src/droits/roles.js');
    assert.deepEqual(auteurJournalSav(null), { auteurId: '00000000-0000-4000-8000-000000000001', auteurNom: 'Iris (automatique)' });
    assert.deepEqual([COMPTE_SYSTEME_ID, NOM_COMPTE_SYSTEME], ['00000000-0000-4000-8000-000000000001', 'Iris (automatique)']);
    assert.deepEqual(auteurJournalSav({ user: { id: 'compte', name: 'Nom' } }), { auteurId: 'compte', auteurNom: 'Nom' });
    assert.throws(() => auteurJournalSav({}), /sans compte auteur/);
  });
});

// Lot pilote 5 : alerte de la génération automatique des visites, montrée aux administrateurs.
describe('Alerte de la génération automatique des visites', () => {
  const instant = new Date('2026-06-15T10:00:00.000Z');
  const jour = (iso) => new Date(`${iso}T00:00:00.000Z`);
  const etat = (modifs) => ({ anticipation: 30, minuteurActif: true, jour: '2026-06-15', instant, derniere: null, derniereAutomatique: null, ...modifs });
  const passage = (modifs) => ({ jour: jour('2026-06-15'), statut: 'REUSSIE', debut: new Date('2026-06-15T00:05:00.000Z'), erreurs: [], ...modifs });

  test('un passage réussi d’hier ou d’aujourd’hui, ou aucun passage encore, ne déclenche rien', () => {
    assert.equal(alerteGenerationVisites(etat({})), null);
    assert.equal(alerteGenerationVisites(etat({ derniere: passage({}), derniereAutomatique: passage({}) })), null);
    const hier = passage({ jour: jour('2026-06-14') });
    assert.equal(alerteGenerationVisites(etat({ derniere: hier, derniereAutomatique: hier })), null);
  });

  test('un dernier passage en échec est signalé, avec son jour et son nombre d’erreurs', () => {
    const echec = passage({ statut: 'ECHEC', erreurs: [{ contratId: 'a' }, { contratId: 'b' }] });
    assert.match(alerteGenerationVisites(etat({ derniere: echec, derniereAutomatique: echec })), /du 15-06-2026 est en échec \(2 erreurs\)/);
    const uneErreur = passage({ statut: 'ECHEC', erreurs: [{ contratId: 'a' }] });
    assert.match(alerteGenerationVisites(etat({ derniere: uneErreur })), /\(1 erreur\)/);
  });

  test('un passage resté en cours plus d’une heure est signalé interrompu ; en cours depuis moins, rien', () => {
    const recent = passage({ statut: 'EN_COURS', debut: new Date('2026-06-15T09:01:00.000Z') });
    assert.equal(alerteGenerationVisites(etat({ derniere: recent, derniereAutomatique: recent })), null);
    const ancien = passage({ statut: 'EN_COURS', debut: new Date('2026-06-15T08:59:00.000Z') });
    assert.match(alerteGenerationVisites(etat({ derniere: ancien, derniereAutomatique: ancien })), /du 15-06-2026 s’est interrompue/);
  });

  test('sans passage automatique depuis avant-hier, alerte si le minuteur tourne, et seulement alors', () => {
    const avantHier = passage({ jour: jour('2026-06-13') });
    assert.match(alerteGenerationVisites(etat({ derniere: avantHier, derniereAutomatique: avantHier })), /n’a pas tourné depuis le 13-06-2026/);
    assert.equal(alerteGenerationVisites(etat({ derniere: avantHier, derniereAutomatique: avantHier, minuteurActif: false })), null);
    // Un passage manuel réussi ne remplace pas le passage automatique manquant.
    assert.match(alerteGenerationVisites(etat({ derniere: passage({}), derniereAutomatique: avantHier })), /n’a pas tourné depuis le 13-06-2026/);
  });

  test('une génération désactivée (anticipation vide) ne signale rien, même après un échec', () => {
    const echec = passage({ statut: 'ECHEC', erreurs: [{ contratId: 'a' }] });
    assert.equal(alerteGenerationVisites(etat({ anticipation: null, derniere: echec, derniereAutomatique: passage({ jour: jour('2026-01-01') }) })), null);
  });
});

// Lot 6a-2, troisième audit (N3) : les tableaux à chasse fixe des documents (devis, factures) se
// calent sur le texte tel qu'il s'imprime ; un accent à recomposer ou un caractère invisible ne
// décale pas les colonnes.
describe('Lot 6a-2 : colonnes à chasse fixe des documents', () => {
  test('chaque cellule est mesurée telle qu’elle s’imprime ; une valeur trop large garde un séparateur', async () => {
    const { ligneColonnes } = await import('../dist/src/domaines/documents/gabarit.js');
    const largeurs = [10, 8, 6];
    assert.equal(ligneColonnes(['Café', '2 pièce', '1 234'], largeurs), 'Café       2 pièce 1 234');
    assert.equal(ligneColonnes(['Café', '2 pièce', '1 234'], largeurs), 'Café       2 pièce 1 234');
    // Une valeur aussi large que sa colonne garde elle aussi son séparateur.
    assert.equal(ligneColonnes(['A', '12345678', 'x'], largeurs), 'A          12345678     x');
    // Audit n° 4 : une cellule reste sur sa ligne, même avec un saut de ligne saisi (\n, \r, U+2028).
    for (const unite of ['m\nl', 'm\rl', 'm\r\nl', 'm\u2028l']) assert.equal(ligneColonnes(['A', unite, 'x'], largeurs), 'A              m l     x');
  });

  test('le repli d’une désignation se mesure sur le texte imprimé', async () => {
    const { replierTexte } = await import('../dist/src/domaines/documents/gabarit.js');
    // L'espace sans chasse et la marque d'ordre des octets, invisibles, ne coupent pas un mot.
    assert.deepEqual(replierTexte('Café x﻿y co­op', 6), ['Café', 'xy', 'coop']);
    assert.deepEqual(replierTexte('Café noir', 9), ['Café noir']);
    // Audit n° 4 : un retour chariot seul sépare deux mots, comme une fin de ligne Windows.
    assert.deepEqual(replierTexte('10\r20 m', 9), ['10 20 m']);
    assert.deepEqual(replierTexte('10\r\n20 m', 9), ['10 20 m']);
  });

  // Audit n° 18 : toutes les fins de ligne d'un texte sont converties, et non la première seule ;
  // une cellule reste sur sa ligne, quel que soit le nombre de sauts de ligne saisis.
  test('chaque fin de ligne d’un texte est convertie, et non la première seule', async () => {
    const { ligneColonnes, replierTexte, texteWinAnsi } = await import('../dist/src/domaines/documents/gabarit.js');
    assert.equal(texteWinAnsi('10\r20\r30'), '10\n20\n30');
    assert.equal(texteWinAnsi('10\r\n20\r\n30'), '10\n20\n30');
    assert.deepEqual(replierTexte('10\r20\r30 m', 12), ['10 20 30 m']);
    for (const unite of ['m\nl\nk', 'm\r\nl\rk']) assert.equal(ligneColonnes(['A', unite, 'x'], [10, 8, 6]), 'A            m l k     x');
  });

  // Audit n° 5 : chaque équivalent et chaque invisible de la table, un par un, entre deux lettres.
  test('chaque équivalent de même sens et chaque invisible documentés', async () => {
    const { texteWinAnsi } = await import('../dist/src/domaines/documents/gabarit.js');
    const entre = (code) => texteWinAnsi(`a${String.fromCodePoint(code)}b`);
    const espaces = [0x09, ...Array.from({ length: 11 }, (_, rang) => 0x2000 + rang), 0x202f, 0x205f, 0x3000];
    for (const code of espaces) assert.equal(entre(code), 'a b', `U+${code.toString(16)}`);
    for (const code of [0x2010, 0x2011, 0x2012, 0x2212]) assert.equal(entre(code), 'a-b', `U+${code.toString(16)}`);
    assert.equal(entre(0x2264), 'a<=b');
    assert.equal(entre(0x2265), 'a>=b');
    // Même glyphe, même sens (audit n° 5, N2) : 10 μF s'imprime 10 µF, l'apostrophe modificative ’.
    assert.equal(entre(0x03bc), 'a\u00b5b');
    assert.equal(entre(0x02bc), 'a\u2019b');
    // Séparateurs de ligne et de paragraphe, fins de ligne Windows et anciennes : un saut de ligne.
    for (const code of [0x0a, 0x0d, 0x2028, 0x2029]) assert.equal(entre(code), 'a\nb', `U+${code.toString(16)}`);
    assert.equal(texteWinAnsi('a\r\nb'), 'a\nb');
    // Audit n° 6 : le gluon de graphèmes (U+034F), invisible, est le septième caractère retiré.
    for (const code of [0xad, 0x034f, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]) assert.equal(entre(code), 'ab', `U+${code.toString(16)}`);
    // Les autres caractères de mise en forme invisibles deviennent « ? », comme le dit la passation.
    for (const code of [0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2062, 0xfe0f]) assert.equal(entre(code), 'a?b', `U+${code.toString(16)}`);
    assert.equal(texteWinAnsi('©\ufe0f'), '©?');
  });

  // Audit n° 7 : le jeu des polices standard (WinAnsi : ASCII imprimable, Latin-1 et les 27 caractères
  // de la page de code 1252 de 0x80 à 0x9F) s'imprime tel quel, et lui seul. Un caractère retiré du
  // jeu par erreur (–, •, Ÿ, ~, ÿ…) changerait le PDF des factures déjà émises ; un caractère ajouté
  // à tort brouillerait la ligne. Le trait d'union conditionnel (U+00AD) est retiré, comme documenté.
  test('les caractères du jeu WinAnsi s’impriment tels quels, et eux seuls', async () => {
    const { texteWinAnsi } = await import('../dist/src/domaines/documents/gabarit.js');
    const page1252 = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
    const attendus = [0x0a, ...Array.from({ length: 0x5f }, (_, rang) => 0x20 + rang),
      ...Array.from({ length: 0x60 }, (_, rang) => 0xa0 + rang).filter((code) => code !== 0xad),
      ...[...page1252].map((caractere) => caractere.codePointAt(0))].sort((a, b) => a - b);
    assert.equal(new Set(attendus).size, 1 + 95 + 95 + 27);
    const inchanges = [];
    for (let code = 0; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const caractere = String.fromCodePoint(code);
      if (texteWinAnsi(`a${caractere}b`) === `a${caractere}b`) inchanges.push(code);
    }
    assert.deepEqual(inchanges, attendus);
  });
});

// Audit n° 8 : bornes de la table des remplacements. Une ligature ou une forme pleine chasse aux
// extrémités de leur plage garde ses lettres ; un accent aux extrémités des plages retirées
// s'efface (lettre de base) ; les surimpressions et les barres au-dessus, gardées, deviennent « ? ».
describe('Lot 6a-2 : bornes des remplacements hors WinAnsi', () => {
  test('ligatures, pleine chasse et accents aux bornes de leurs plages', async () => {
    const { texteWinAnsi } = await import('../dist/src/domaines/documents/gabarit.js');
    for (const [saisi, imprime] of [['ﬀ', 'ff'], ['ﬆ', 'st'], ['！', '!'], ['～', '~'], ['｟', '?']]) {
      assert.equal(texteWinAnsi(saisi), imprime, `U+${saisi.codePointAt(0).toString(16)}`);
    }
    // Accent retiré, en forme composée (ā, ă) comme isolée après une lettre sans forme composée.
    assert.equal(texteWinAnsi('āă'), 'aa');
    for (const code of [0x0300, 0x0304, 0x0306, 0x0333, 0x0339, 0x033e, 0x0340, 0x036f]) {
      assert.equal(texteWinAnsi(`x${String.fromCodePoint(code)}`), 'x', `U+${code.toString(16)}`);
    }
    for (const code of [0x0305, 0x0334, 0x0338, 0x033f, 0x0370]) {
      assert.equal(texteWinAnsi(`x${String.fromCodePoint(code)}`), 'x?', `U+${code.toString(16)}`);
    }
  });
});
