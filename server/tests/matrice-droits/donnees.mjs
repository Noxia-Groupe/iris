// Jeu de données et cibles nommées des matrices de droits (lot D1a, cadrage version 3, §2.3 ; CIBLE §7.1,
// « Données couvertes »).
//
// Le jeu de données est construit UNE fois, par l'API quand une route existe (session du super administrateur,
// sauf mention), sinon en base avec la raison en commentaire. Les cibles sont absolues et nommées : la référence
// porte le nom de la cible, jamais son identifiant. Chaque famille a sa table de cibles (FAMILLES, plus bas), avec
// la relation que chaque cible incarne pour chaque compte joué ; un compte absent de `relations` n'a aucune
// relation avec la cible. Le constructeur vérifie en base les faits qui portent ces relations (titulaire,
// commercial, statut, affectation, créateur), pour que la table ne puisse pas mentir.
//
// Chaque famille a aussi la cible `inexistant` : un identifiant de forme valide, absent de la base. C'est la seule
// cible des écritures de la famille (b) (cadrage §2.4) et des refus à l'authentification.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SANS_CIBLE } from './outils.mjs';

export const INEXISTANT = 'inexistant';
// Identifiant de forme valide (UUID v4), absent de la base : tiré une fois par exécution.
export const ID_INEXISTANT = randomUUID();

// Valeurs fixes des paramètres qui ne désignent aucun dossier (cadrage §2.3) : nommées ici, jamais tirées.
export const VALEURS_FIXES = {
  family: 'prestations',   // famille du catalogue (catalogue/metier.ts : prestations, articles, equipements)
  cle: 'CLIENT',           // règle comptable du compte client, posée par le paramétrage du jeu de données
  taux: '20',              // taux de TVA dont le compte est posé par le paramétrage
  version: '999',          // version des mentions légales : inexistante (publication = écriture de la famille (b))
  type: 'heures',          // coûts SAV : les heures du technicien
  action: 'archiver',      // action sur un coût SAV
};

// Société du jeu de données (identité complète : un devis ne se signe et une facture ne s'émet qu'avec elle).
export const SOCIETE = {
  raisonSociale: 'TEST Société matrice des droits', nomCommercial: '', siret: '73282932000074', tvaIntra: '',
  adresse: '1 rue des Droits', codePostal: '14000', ville: 'Caen', pays: 'France', telephone: '02 31 00 00 01',
  email: 'societe-matrice@iris.test', siteWeb: '', piedFacture: 'TEST Pied matrice', couleurPrimaire: '#0f766e', fuseauHoraire: 'Europe/Paris',
};

// Jour civil JJ-MM-AAAA d'un instant dans le fuseau de la société, décalé de `jours`.
export function jourSociete(jours = 0, fuseau = SOCIETE.fuseauHoraire) {
  const instant = new Date(Date.now() + jours * 86_400_000);
  const parties = new Intl.DateTimeFormat('en-GB', { timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const valeur = (type) => parties.find((partie) => partie.type === type).value;
  return `${valeur('day')}-${valeur('month')}-${valeur('year')}`;
}

// --- Tables des familles ---
// Chaque famille : le paramètre de chemin qu'elle remplit, et ses cibles. Une cible : nom, description, relations
// par compte (clé du compte → relation), et `ids` (rempli par le constructeur : identifiant de chaque paramètre).
// Les familles « site, contact et équipement », « facture, avoir et règlement », « affectation et type du
// planning », « catégorie et fournisseur » et « achat et heure » du cadrage sont scindées par paramètre de chemin,
// une route ne prenant qu'un genre d'identifiant. « Compte comptable » et « fiche du catalogue » s'ajoutent à la
// liste du cadrage : des routes de session les prennent en paramètre.
const C = (nom, description, relations = {}) => ({ nom, description, relations });

export const FAMILLES = {
  chantier: {
    libelle: 'chantier',
    cibles: [
      C('chantier-ct', 'en cours, titulaire CT, sans commercial', { CT: 'titulaire', 'CT-N1': 'N+1 du titulaire (conducteur, sans branche)' }),
      C('chantier-ct-branche-resp', 'en cours, titulaire CT-BRANCHE (conducteur de la branche de RESP)', { RESP: 'titulaire dans sa branche' }),
      C('chantier-tech-branche-resp', 'en cours, titulaire TECH (technicien de la branche de RESP)', { TECH: 'titulaire', RESP: 'titulaire dans sa branche' }),
      C('chantier-resp', 'en cours, titulaire RESP', { RESP: 'titulaire' }),
      C('chantier-com', 'en cours, titulaire CT-TIERS, commercial COM', { COM: 'commercial' }),
      C('chantier-com-titulaire', 'en cours, titulaire COM, sans commercial', { COM: 'titulaire' }),
      C('chantier-ad', 'en cours, titulaire AD, commercial AD-COM', { AD: 'titulaire', 'AD-COM': 'commercial' }),
      C('chantier-dir', 'en cours, titulaire DIR', { DIR: 'titulaire' }),
      C('chantier-dc', 'en cours, titulaire DC', { DC: 'titulaire' }),
      C('chantier-ac', 'en cours, titulaire AC', { AC: 'titulaire' }),
      C('chantier-cpt', 'en cours, titulaire CPT', { CPT: 'titulaire' }),
      C('chantier-autre', 'en cours, titulaire CT-TIERS (hors de tout périmètre), sans commercial'),
      C('chantier-termine', 'terminé, titulaire CT', { CT: 'titulaire', 'CT-N1': 'N+1 du titulaire' }),
      C('chantier-annule', 'annulé avec son devis, titulaire CT', { CT: 'titulaire', 'CT-N1': 'N+1 du titulaire' }),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  intervention: {
    libelle: 'intervention',
    cibles: [
      C('intervention-affectee-tech', 'curative en cours, chantier chantier-tech-branche-resp, affectée à TECH, projection du jour (« Ma journée »), heures du technicien, matériel, compte rendu non signé', { TECH: 'affecté', RESP: 'chantier lié dans sa branche' }),
      C('curative-sans-chantier-branche', 'curative planifiée sans chantier, affectée à TECH (membre de la branche de RESP), projection du lendemain', { TECH: 'affecté', RESP: 'affectée à un membre de sa branche, sans chantier (hors périmètre)' }),
      C('intervention-creee-ct', 'à planifier, sans chantier, créée par CT', { CT: 'créateur', 'CT-N1': 'N+1 du créateur' }),
      C('intervention-chantier-ct', 'planifiée, chantier chantier-ct, affectée à la fiche libre, projection du lendemain', { CT: 'titulaire du chantier lié' }),
      C('intervention-terminee-signee', 'terminée, chantier chantier-ct, affectée à TECH, compte rendu signé', { TECH: 'affecté', CT: 'titulaire du chantier lié' }),
      C('intervention-terminee-motif', 'terminée sans signature (motif « client absent »), sans chantier, affectée à TECH', { TECH: 'affecté', RESP: 'affectée à un membre de sa branche, sans chantier (hors périmètre)' }),
      C('intervention-annulee', 'annulée (motif), sans chantier, affectée à TECH avant l’annulation', { TECH: 'affecté avant l’annulation (affectation retirée)' }),
      C('intervention-autre', 'à planifier, sans chantier, créée par AD, sans affectation'),
      C('visite-contrat', 'visite à planifier du contrat contrat-actif'),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  'compte-rendu': {
    libelle: 'compte rendu',
    cibles: [
      C('rapport-non-signe', 'compte rendu non signé de intervention-affectee-tech', { TECH: 'auteur, affecté', RESP: 'chantier lié dans sa branche' }),
      C('rapport-signe', 'compte rendu signé de intervention-terminee-signee', { TECH: 'affecté', CT: 'titulaire du chantier lié' }),
      C('rapport-cloture-motif', 'compte rendu de intervention-terminee-motif (clôture avec motif)', { TECH: 'affecté' }),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  client: {
    libelle: 'client',
    cibles: [
      C('client-actif', 'client actif, identifié (SIREN, site de facturation)'),
      C('client-desactive', 'client désactivé'),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  contact: {
    libelle: 'site, contact et équipement (contact) : couple client et contact',
    cibles: [
      C('contact-client-actif', 'contact de client-actif, sous client-actif'),
      C('contact-autre-client', 'contact de client-desactive, sous client-actif (couple incohérent)'),
      C(INEXISTANT, 'client-actif et contact absent'),
    ],
  },
  site: {
    libelle: 'site, contact et équipement (site) : couple client et site',
    cibles: [
      C('site-client-actif', 'site de facturation de client-actif, sous client-actif'),
      C('site-autre-client', 'site de client-desactive, sous client-actif (couple incohérent)'),
      C(INEXISTANT, 'client-actif et site absent'),
    ],
  },
  equipement: {
    libelle: 'site, contact et équipement (équipement) : couple client et équipement',
    cibles: [
      C('equipement-client-actif', 'équipement installé chez client-actif, sous client-actif'),
      C('equipement-autre-client', 'équipement de client-desactive, sous client-actif (couple incohérent)'),
      C(INEXISTANT, 'client-actif et équipement absent'),
    ],
  },
  devis: {
    libelle: 'devis',
    cibles: [
      C('devis-brouillon', 'devis brouillon, non signé'),
      C('devis-signe', 'devis accepté et signé, non converti'),
      C('devis-converti', 'devis signé, converti en chantier (chantier-ct)'),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  facture: {
    libelle: 'facture, avoir et règlement (pièce)',
    cibles: [
      C('facture-brouillon', 'facture brouillon hors affaire'),
      C('facture-emise', 'facture émise, réglée en partie'),
      C('avoir-emis', 'avoir émis sur facture-avoir'),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  reglement: {
    libelle: 'facture, avoir et règlement (règlement)',
    cibles: [
      C('reglement', 'règlement partiel de facture-emise'),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  contrat: {
    libelle: 'contrat',
    cibles: [
      C('contrat-actif', 'contrat de maintenance actif de client-actif, avec sa visite'),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  compte: {
    libelle: 'compte',
    cibles: [
      C('compte-superadmin', 'le super administrateur de l’accès de secours', { SA: 'lui-même' }),
      C('compte-administrateur', 'le compte AD', { AD: 'lui-même' }),
      C('compte-commercial', 'le compte COM', { COM: 'lui-même' }),
      C('compte-technicien', 'le compte TECH, relié à fiche-tech, dans la branche de RESP', { TECH: 'lui-même', RESP: 'dans sa branche' }),
      C('compte-systeme', 'le compte système (migration)'),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  'fiche-intervenant': {
    libelle: 'fiche intervenant',
    cibles: [
      C('fiche-tech', 'fiche reliée au compte TECH', { TECH: 'sa fiche' }),
      C('fiche-libre', 'fiche sans compte'),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  affectation: {
    libelle: 'affectation et type du planning (affectation)',
    cibles: [
      C('affectation-evenement', 'événement libre (type type-planning), fiche libre'),
      C('affectation-chantier-ct', 'affectation de chantier-ct, fiche libre', { CT: 'titulaire du chantier' }),
      C('projection-intervention-chantier-ct', 'projection au planning de intervention-chantier-ct', { CT: 'titulaire du chantier lié' }),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  'type-planning': {
    libelle: 'affectation et type du planning (type)',
    cibles: [
      C('type-planning', 'type d’événement, utilisé par affectation-evenement'),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  categorie: {
    libelle: 'catégorie et fournisseur (catégorie)',
    cibles: [C('categorie', 'catégorie d’achat'), C(INEXISTANT, 'identifiant absent')],
  },
  fournisseur: {
    libelle: 'catégorie et fournisseur (fournisseur)',
    cibles: [C('fournisseur', 'fournisseur'), C(INEXISTANT, 'identifiant absent')],
  },
  achat: {
    libelle: 'achat et heure (achat)',
    cibles: [
      C('achat-chantier-ct', 'achat actif de chantier-ct', { CT: 'titulaire du chantier' }),
      C('achat-chantier-ct-branche-resp', 'achat actif de chantier-ct-branche-resp', { RESP: 'chantier dans sa branche' }),
      C('achat-chantier-autre', 'achat actif de chantier-autre'),
      C('achat-chantier-termine', 'achat actif de chantier-termine', { CT: 'titulaire du chantier (terminé)' }),
      C('achat-archive-chantier-ct', 'achat archivé de chantier-ct', { CT: 'titulaire du chantier' }),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  heure: {
    libelle: 'achat et heure (heure)',
    cibles: [
      C('heure-chantier-ct', 'heures actives de chantier-ct', { CT: 'titulaire du chantier' }),
      C('heure-chantier-ct-branche-resp', 'heures actives de chantier-ct-branche-resp', { RESP: 'chantier dans sa branche' }),
      C('heure-chantier-autre', 'heures actives de chantier-autre'),
      C('heure-chantier-termine', 'heures actives de chantier-termine', { CT: 'titulaire du chantier (terminé)' }),
      C('heure-archivee-chantier-ct', 'heures archivées de chantier-ct', { CT: 'titulaire du chantier' }),
      C(INEXISTANT, 'identifiant absent'),
    ],
  },
  'cout-sav': {
    libelle: 'intervention (coût SAV) : couple intervention et coût',
    cibles: [
      C('heures-tech-intervention-affectee', 'heures de TECH sur intervention-affectee-tech', { TECH: 'auteur, affecté', RESP: 'chantier lié dans sa branche' }),
      C('heures-tech-sous-intervention-autre', 'heures de TECH, sous intervention-autre (couple incohérent)'),
      // Matériel (type « achats ») : sa correction est réservée à l'encadrement, celle des heures au technicien
      // affecté (interventions/routes.ts) ; la cible porte son type de coût, qui remplace la valeur fixe.
      C('materiel-intervention-chantier-ct', 'matériel de intervention-chantier-ct (type achats)', { CT: 'titulaire du chantier lié' }),
      C('materiel-intervention-affectee', 'matériel de intervention-affectee-tech (type achats)', { TECH: 'affecté', RESP: 'chantier lié dans sa branche' }),
      C(INEXISTANT, 'intervention-affectee-tech et coût absent', { TECH: 'affecté' }),
    ],
  },
  cle: {
    libelle: 'clé',
    cibles: [C('cle-active', 'clé d’intégration active (clients:read)'), C(INEXISTANT, 'identifiant absent')],
  },
  'compte-comptable': {
    libelle: 'compte comptable',
    cibles: [C('compte-comptable-clients', 'compte 411000 du paramétrage'), C(INEXISTANT, 'identifiant absent')],
  },
  'fiche-catalogue': {
    libelle: 'fiche du catalogue (famille prestations)',
    cibles: [C('prestation-catalogue', 'fiche active de la famille prestations'), C(INEXISTANT, 'identifiant absent')],
  },
};

// Cible d'une famille, par son nom.
export function cibleDe(famille, nom) {
  const cible = FAMILLES[famille]?.cibles.find((c) => c.nom === nom);
  assert.ok(cible, `cible inconnue : ${famille} / ${nom}`);
  return cible;
}

// Chemin d'une route pour une cible : chaque paramètre de dossier reçoit l'identifiant de la cible, chaque autre
// paramètre sa valeur fixe (cadrage §2.3). Partagé par les matrices des sessions (D1a-1) et des clés (D1a-2).
export function cheminPour(chemin, famille, cible) {
  return chemin.replace(/:([A-Za-z]+)/g, (_, nom) => {
    if (famille && cible) {
      const ids = cible.ids;
      if (nom === 'coutId') return ids.coutId;
      // Type de coût porté par la cible (matériel) ; sinon, la valeur fixe (heures).
      if (nom === 'type' && ids.type) return ids.type;
      if (nom === 'clientId') return ids.clientId ?? ids.id;
      if (nom === 'id' || nom === 'rapportId') return ids.id;
    }
    assert.ok(Object.hasOwn(VALEURS_FIXES, nom), `paramètre sans valeur : ${nom} (${chemin})`);
    return VALEURS_FIXES[nom];
  });
}
// Cible d'une route sans paramètre de dossier : « — », ou ses valeurs fixes (par exemple « cle=CLIENT »).
export function cibleSansFamille(chemin) {
  const noms = [...chemin.matchAll(/:([A-Za-z]+)/g)].map(([, nom]) => nom);
  return noms.length ? noms.map((nom) => `${nom}=${VALEURS_FIXES[nom]}`).join(',') : SANS_CIBLE;
}
// Cibles jouées pour une route : toutes celles de sa famille (lecture, écriture (a)), la seule cible `inexistant`
// (écriture (b)), aucune cible nommée pour une route sans paramètre de dossier.
export function ciblesDe(definition, chemin) {
  if (!definition.famille) return [{ nom: cibleSansFamille(chemin) }];
  const cibles = FAMILLES[definition.famille].cibles;
  return definition.ecriture === 'b' ? cibles.filter((c) => c.nom === INEXISTANT) : cibles;
}

// --- Construction ---
// `api(compte, methode, chemin, corps, statut)` : appel HTTP par la session d'un compte, qui exige le statut donné
// (200 par défaut) et rend le corps. `comptes` : clés → { id }. Rend l'objet `ids` de chaque cible, rangé dans
// FAMILLES[f].cibles[i].ids, et un résumé des objets du jeu de données.
export async function construireJeuDeDonnees({ prisma, api, comptes, donnees }) {
  const ids = {};
  const fixer = (famille, nom, valeurs) => { cibleDe(famille, nom).ids = valeurs; ids[`${famille}/${nom}`] = valeurs; };
  const SA = 'SA';
  const aujourdhui = jourSociete(0);
  const hier = jourSociete(-1);
  const demain = jourSociete(1);
  // Dates relatives au jour de la société : le jeu de données a le même sens quel que soit le jour d'exécution.
  const ilYAUnMois = jourSociete(-30);
  const ilYADeuxMois = jourSociete(-60);

  // Société et facturation (mêmes prérequis que production-pdf.test.mjs).
  await api(SA, 'PUT', '/api/company', SOCIETE);
  const compteComptable = async (code, libelle, nature) => api(SA, 'POST', '/api/comptabilite/comptes', { code, libelle, nature }, 201);
  const clients411 = await compteComptable('411000', 'TEST Clients matrice', 'ACTIF');
  const prestations706 = await compteComptable('706000', 'TEST Prestations matrice', 'PRODUIT');
  const articles707 = await compteComptable('707000', 'TEST Articles matrice', 'PRODUIT');
  const tva445 = await compteComptable('445710', 'TEST TVA collectée matrice', 'TVA');
  const motifParametrage = 'TEST paramétrage comptable de la matrice';
  for (const [cle, valeurs] of [['CLIENT', { compteId: clients411.id }], ['VENTE_PRESTATION', { compteId: prestations706.id }], ['VENTE_ARTICLE', { compteId: articles707.id }], ['JOURNAL_VENTES', { journal: 'VE' }]]) {
    await api(SA, 'PUT', `/api/comptabilite/regles/${cle}`, { ...valeurs, motif: motifParametrage }, [200, 201]);
  }
  await api(SA, 'PUT', '/api/comptabilite/tva/20', { compteId: tva445.id, motif: motifParametrage }, [200, 201]);
  const mentions = await api(SA, 'POST', '/api/mentions-legales', { mentions: 'TEST mentions matrice v1', cgv: 'TEST CGV matrice v1', penalites: 'TEST pénalités matrice v1' }, 201);
  await api(SA, 'POST', `/api/mentions-legales/${mentions.version}/publier`, {});
  fixer('compte-comptable', 'compte-comptable-clients', { id: clients411.id });

  // Clients : actif et désactivé, identifiés (SIREN fixe : base propre au fichier).
  const creerClient = async (raisonSociale, siren) => {
    const client = await api(SA, 'POST', '/api/clients', { raisonSociale, siren }, 201);
    const site = await api(SA, 'POST', `/api/clients/${client.id}/sites`, { nom: `TEST Facturation ${raisonSociale}`, adresse: '5 rue de la Facturation', codePostal: '75002', ville: 'Paris', estSiteFacturation: true }, 201);
    const contact = await api(SA, 'POST', `/api/clients/${client.id}/contacts`, { nom: `TEST Contact ${raisonSociale}`, email: 'contact-matrice@iris.test', principal: true }, 201);
    return { ...client, site, contact };
  };
  const clientActif = await creerClient('TEST Client actif matrice', '552100554');
  const clientDesactive = await creerClient('TEST Client désactivé matrice', '552081317');
  const modeleEquipement = await api(SA, 'POST', '/api/catalogue/equipements', { reference: 'TEST-MATRICE-EQ', nom: 'TEST Modèle d’équipement', fabricant: 'TEST', prixVenteHt: '100' }, 201);
  const equipementActif = await api(SA, 'POST', `/api/clients/${clientActif.id}/equipements`, { catalogueEquipementId: modeleEquipement.id, clientSiteId: clientActif.site.id, numeroSerie: 'TEST-SN-ACTIF' }, 201);
  const equipementDesactive = await api(SA, 'POST', `/api/clients/${clientDesactive.id}/equipements`, { catalogueEquipementId: modeleEquipement.id, clientSiteId: clientDesactive.site.id, numeroSerie: 'TEST-SN-DESACTIVE' }, 201);
  const prestation = await api(SA, 'POST', '/api/catalogue/prestations', { reference: 'TEST-MATRICE-PRE', nom: 'TEST Prestation catalogue matrice', unite: 'forfait', prixVenteHt: '100', tauxTva: '20' }, 201);
  fixer('fiche-catalogue', 'prestation-catalogue', { id: prestation.id });
  fixer('client', 'client-actif', { id: clientActif.id });
  fixer('client', 'client-desactive', { id: clientDesactive.id });
  fixer('contact', 'contact-client-actif', { clientId: clientActif.id, id: clientActif.contact.id });
  fixer('contact', 'contact-autre-client', { clientId: clientActif.id, id: clientDesactive.contact.id });
  fixer('site', 'site-client-actif', { clientId: clientActif.id, id: clientActif.site.id });
  fixer('site', 'site-autre-client', { clientId: clientActif.id, id: clientDesactive.site.id });
  fixer('equipement', 'equipement-client-actif', { clientId: clientActif.id, id: equipementActif.id });
  fixer('equipement', 'equipement-autre-client', { clientId: clientActif.id, id: equipementDesactive.id });

  // Devis : chaque chantier naît de la conversion d'un devis signé (POST /api/chantiers répond 410).
  const creerDevis = (objet) => api(SA, 'POST', '/api/devis', { clientId: clientActif.id, objet, lignes: [{ designation: `TEST Ligne ${objet}`, nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }] }, 201);
  const signer = async (devis) => {
    await api(SA, 'PUT', `/api/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await api(SA, 'POST', `/api/devis/${devis.id}/signature`, { signataire: 'TEST Signataire matrice', confirme: true }, 201);
    return devis;
  };
  const devisBrouillon = await creerDevis('TEST Devis brouillon matrice');
  const devisSigne = await signer(await creerDevis('TEST Devis signé matrice'));
  fixer('devis', 'devis-brouillon', { id: devisBrouillon.id });
  fixer('devis', 'devis-signe', { id: devisSigne.id });

  // Chantiers : titulaire et commercial fixés à l'ouverture (session d'administration, seule admise).
  const CHANTIERS = [
    ['chantier-ct', comptes.CT.id, null],
    ['chantier-ct-branche-resp', donnees.CT_BRANCHE.id, null],
    ['chantier-tech-branche-resp', comptes.TECH.id, null],
    ['chantier-resp', comptes.RESP.id, null],
    ['chantier-com', donnees.CT_TIERS.id, comptes.COM.id],
    ['chantier-com-titulaire', comptes.COM.id, null],
    ['chantier-ad', comptes.AD.id, comptes['AD-COM'].id],
    ['chantier-dir', comptes.DIR.id, null],
    ['chantier-dc', comptes.DC.id, null],
    ['chantier-ac', comptes.AC.id, null],
    ['chantier-cpt', comptes.CPT.id, null],
    ['chantier-autre', donnees.CT_TIERS.id, null],
    ['chantier-termine', comptes.CT.id, null],
    ['chantier-annule', comptes.CT.id, null],
  ];
  const chantiers = {};
  const devisDuChantier = {};
  for (const [nom, responsableId, commercialId] of CHANTIERS) {
    const devis = await signer(await creerDevis(`TEST Devis de ${nom}`));
    const corps = { cible: 'CHANTIER', responsableId, dateDebut: ilYAUnMois, ...(commercialId ? { commercialId } : {}) };
    const conversion = await api(SA, 'POST', `/api/devis/${devis.id}/convertir`, corps, 201);
    const chantierId = conversion.chantier?.id ?? conversion.chantierId ?? conversion.id;
    assert.ok(chantierId, `conversion de ${nom} : ${JSON.stringify(conversion).slice(0, 300)}`);
    chantiers[nom] = chantierId;
    devisDuChantier[nom] = devis;
    fixer('chantier', nom, { id: chantierId });
  }
  fixer('devis', 'devis-converti', { id: devisDuChantier['chantier-ct'].id });

  // Référentiels des achats, fiches intervenant.
  const categorie = await api(SA, 'POST', '/api/categories', { nom: 'TEST Catégorie matrice' }, [200, 201]);
  const fournisseur = await api(SA, 'POST', '/api/fournisseurs', { nom: 'TEST Fournisseur matrice' }, [200, 201]);
  fixer('categorie', 'categorie', { id: categorie.id });
  fixer('fournisseur', 'fournisseur', { id: fournisseur.id });
  const ficheTech = await api(SA, 'POST', '/api/intervenants', { nom: 'TEST Fiche du technicien', role: 'Technicien', tauxHoraireCharge: 40 });
  await api(SA, 'PUT', `/api/intervenants/${ficheTech.id}/compte`, { userId: comptes.TECH.id });
  const ficheLibre = await api(SA, 'POST', '/api/intervenants', { nom: 'TEST Fiche libre', role: 'Technicien', tauxHoraireCharge: 35 });
  fixer('fiche-intervenant', 'fiche-tech', { id: ficheTech.id });
  fixer('fiche-intervenant', 'fiche-libre', { id: ficheLibre.id });

  // Achats et heures des chantiers (saisis par l'administration, qui écrit sur tout chantier en cours).
  const saisirAchat = (chantierId, description) => api(SA, 'POST', '/api/achats', { chantierId, categorieId: categorie.id, fournisseurId: fournisseur.id, date: hier, description, montantHT: 100 });
  const saisirHeures = (chantierId) => api(SA, 'POST', '/api/heures', { chantierId, intervenantId: ficheLibre.id, date: hier, nbrHeures: 2 });
  for (const [cible, chantier] of [['chantier-ct', 'chantier-ct'], ['chantier-ct-branche-resp', 'chantier-ct-branche-resp'], ['chantier-autre', 'chantier-autre'], ['chantier-termine', 'chantier-termine']]) {
    fixer('achat', `achat-${cible}`, { id: (await saisirAchat(chantiers[chantier], `TEST Achat ${cible}`)).id });
    fixer('heure', `heure-${cible}`, { id: (await saisirHeures(chantiers[chantier])).id });
  }
  const achatArchive = await saisirAchat(chantiers['chantier-ct'], 'TEST Achat archivé');
  await api(SA, 'DELETE', `/api/achats/${achatArchive.id}`, { motifArchivage: 'TEST archivage pour la matrice' });
  fixer('achat', 'achat-archive-chantier-ct', { id: achatArchive.id });
  const heureArchivee = await saisirHeures(chantiers['chantier-ct']);
  await api(SA, 'DELETE', `/api/heures/${heureArchivee.id}`, { motifArchivage: 'TEST archivage pour la matrice' });
  fixer('heure', 'heure-archivee-chantier-ct', { id: heureArchivee.id });

  // Statuts des chantiers : terminé (clôture par l'administration), annulé (avec son devis, motif obligatoire ;
  // refusée si le chantier porte des heures ou des achats : il n'en porte aucun).
  await api(SA, 'PATCH', `/api/chantiers/${chantiers['chantier-termine']}/statut`, { statut: 'TERMINE' });
  await api(SA, 'POST', `/api/devis/${devisDuChantier['chantier-annule'].id}/annulation`, { motif: 'TEST annulation pour la matrice' });

  // Interventions. Placement au planning : projection et affectation de la fiche (PUT …/planning).
  const creerIntervention = (titre, extra = {}, compte = SA) => api(compte, 'POST', '/api/interventions', { clientId: clientActif.id, titre, ...extra }, 201);
  const placer = (id, jour, ficheId) => api(SA, 'PUT', `/api/interventions/${id}/planning`, { dateDebut: jour, creneau: 'JOURNEE', intervenantIds: [ficheId] }, [200, 201]);
  const statut = (id, valeur, extra = {}, compte = SA) => api(compte, 'PATCH', `/api/interventions/${id}/statut`, { statut: valeur, ...extra });
  const statutDe = async (id) => (await prisma.intervention.findUniqueOrThrow({ where: { id }, select: { statut: true } })).statut;
  const demarrer = async (id) => { if (await statutDe(id) === 'A_PLANIFIER') await statut(id, 'PLANIFIEE'); await statut(id, 'EN_COURS'); };
  const compteRendu = (id, contenu, compte = SA) => api(compte, 'POST', `/api/interventions/${id}/rapports`, { contenu, cleEnvoi: randomUUID() }, 201);
  const TRACE = { ratio: 2, traits: [[[0.1, 0.6], [0.25, 0.3], [0.4, 0.7], [0.6, 0.35]]] };

  const affecteeTech = await creerIntervention('TEST Intervention affectée au technicien', { chantierId: chantiers['chantier-tech-branche-resp'] });
  await placer(affecteeTech.id, aujourdhui, ficheTech.id);
  await demarrer(affecteeTech.id);
  const heuresTech = await api('TECH', 'POST', `/api/interventions/${affecteeTech.id}/couts/heures`, { date: aujourdhui, nbrHeures: 1.5 }, 201);
  const materielAffectee = await api(SA, 'POST', `/api/interventions/${affecteeTech.id}/couts/achats`, { date: aujourdhui, montantHT: 30, description: 'TEST Matériel SAV', fournisseurId: fournisseur.id }, 201);
  const rapportNonSigne = await compteRendu(affecteeTech.id, 'TEST Compte rendu non signé.', 'TECH');

  const sansChantierBranche = await creerIntervention('TEST Curative sans chantier de la branche');
  await placer(sansChantierBranche.id, demain, ficheTech.id);

  const creeeCt = await creerIntervention('TEST Intervention créée par le conducteur', {}, 'CT');

  const chantierCt = await creerIntervention('TEST Intervention du chantier du conducteur', { chantierId: chantiers['chantier-ct'] });
  const projection = await placer(chantierCt.id, demain, ficheLibre.id);
  const materielChantierCt = await api(SA, 'POST', `/api/interventions/${chantierCt.id}/couts/achats`, { date: aujourdhui, montantHT: 20, description: 'TEST Matériel SAV du chantier du conducteur', fournisseurId: fournisseur.id }, 201);

  const termineeSignee = await creerIntervention('TEST Intervention terminée et signée', { chantierId: chantiers['chantier-ct'] });
  await placer(termineeSignee.id, hier, ficheTech.id);
  await demarrer(termineeSignee.id);
  const rapportSigne = await compteRendu(termineeSignee.id, 'TEST Compte rendu signé.', 'TECH');
  await api(SA, 'POST', `/api/interventions/rapports/${rapportSigne.id}/signature`, { signataire: 'TEST Client signataire', confirme: true, trace: TRACE }, 201);
  await statut(termineeSignee.id, 'TERMINEE');

  const termineeMotif = await creerIntervention('TEST Intervention terminée sans signature');
  await placer(termineeMotif.id, hier, ficheTech.id);
  await demarrer(termineeMotif.id);
  const rapportMotif = await compteRendu(termineeMotif.id, 'TEST Compte rendu sans signature.', 'TECH');
  await statut(termineeMotif.id, 'TERMINEE', { motifSansSignature: 'CLIENT_ABSENT' });

  const annulee = await creerIntervention('TEST Intervention annulée');
  await placer(annulee.id, demain, ficheTech.id);
  await statut(annulee.id, 'ANNULEE', { motif: 'TEST annulation de l’intervention' });

  const autre = await creerIntervention('TEST Intervention hors de tout périmètre');

  // Contrat et sa visite.
  const contrat = await api(SA, 'POST', '/api/contrats-maintenance', { clientId: clientActif.id, titre: 'TEST Contrat matrice', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: ilYADeuxMois }, 201);
  const visite = await api(SA, 'POST', `/api/contrats-maintenance/${contrat.id}/generer-intervention`, {}, 201);
  fixer('contrat', 'contrat-actif', { id: contrat.id });

  for (const [nom, intervention] of [
    ['intervention-affectee-tech', affecteeTech], ['curative-sans-chantier-branche', sansChantierBranche], ['intervention-creee-ct', creeeCt],
    ['intervention-chantier-ct', chantierCt], ['intervention-terminee-signee', termineeSignee], ['intervention-terminee-motif', termineeMotif],
    ['intervention-annulee', annulee], ['intervention-autre', autre], ['visite-contrat', visite],
  ]) fixer('intervention', nom, { id: intervention.id });
  fixer('compte-rendu', 'rapport-non-signe', { id: rapportNonSigne.id });
  fixer('compte-rendu', 'rapport-signe', { id: rapportSigne.id });
  fixer('compte-rendu', 'rapport-cloture-motif', { id: rapportMotif.id });
  fixer('cout-sav', 'heures-tech-intervention-affectee', { id: affecteeTech.id, coutId: heuresTech.id });
  fixer('cout-sav', 'heures-tech-sous-intervention-autre', { id: autre.id, coutId: heuresTech.id });
  fixer('cout-sav', 'materiel-intervention-chantier-ct', { id: chantierCt.id, coutId: materielChantierCt.id, type: 'achats' });
  fixer('cout-sav', 'materiel-intervention-affectee', { id: affecteeTech.id, coutId: materielAffectee.id, type: 'achats' });

  // Planning : type, événement libre, affectation de chantier ; la projection vient du placement ci-dessus.
  const type = await api(SA, 'POST', '/api/planning/types', { nom: 'TEST Type matrice', couleur: '#123456' }, 201);
  const evenement = await api(SA, 'POST', '/api/planning/events', { categorie: 'EVENEMENT', typeEventId: type.id, dateDebut: aujourdhui, intervenantIds: [ficheLibre.id] }, 201);
  const affectationChantier = await api(SA, 'POST', '/api/planning/events', { categorie: 'CHANTIER', chantierId: chantiers['chantier-ct'], dateDebut: aujourdhui, intervenantIds: [ficheLibre.id] }, 201);
  const projectionId = projection?.id ?? (await prisma.planningEvent.findFirstOrThrow({ where: { interventionId: chantierCt.id }, select: { id: true } })).id;
  fixer('type-planning', 'type-planning', { id: type.id });
  fixer('affectation', 'affectation-evenement', { id: evenement.id });
  fixer('affectation', 'affectation-chantier-ct', { id: affectationChantier.id });
  fixer('affectation', 'projection-intervention-chantier-ct', { id: projectionId });
  // Lien public du planning, publié (table à part du cadrage §2.1).
  const partage = await api(SA, 'POST', '/api/planning/share', {});

  // Factures : brouillon ; émise et réglée en partie ; émise puis portant un avoir émis.
  const brouillonFacture = (motif, prix) => api(SA, 'POST', '/api/factures', {
    clientId: clientActif.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: motif, dateEmission: aujourdhui, dateEcheance: aujourdhui,
    lignes: [{ designation: `TEST ${motif}`, quantite: 1, prixUnitaireHt: prix, tauxTva: 20 }],
  }, 201);
  const factureBrouillon = await brouillonFacture('TEST facture brouillon matrice', 10);
  const factureEmise = await api(SA, 'POST', `/api/factures/${(await brouillonFacture('TEST facture émise matrice', 100)).id}/emettre`, {});
  const reglement = await api(SA, 'POST', '/api/reglements', { clientId: clientActif.id, dateReglement: aujourdhui, montant: 50, moyen: 'VIREMENT', affectations: [{ factureId: factureEmise.id, montant: 50 }] }, 201);
  const factureAvoir = await api(SA, 'POST', `/api/factures/${(await brouillonFacture('TEST facture avoir matrice', 80)).id}/emettre`, {});
  const avoir = await api(SA, 'POST', `/api/factures/${factureAvoir.id}/avoirs`, { lignes: [{ designation: 'TEST avoir matrice', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] }, 201);
  const avoirId = avoir.avoir?.id ?? avoir.id;
  fixer('facture', 'facture-brouillon', { id: factureBrouillon.id });
  fixer('facture', 'facture-emise', { id: factureEmise.id });
  fixer('facture', 'avoir-emis', { id: avoirId });
  fixer('reglement', 'reglement', { id: reglement.id ?? reglement.reglement?.id });

  // Clé d'intégration active.
  const cle = await api(SA, 'POST', '/api/admin/api-keys', { nom: 'TEST Clé matrice', scopes: ['clients:read'] }, 201);
  fixer('cle', 'cle-active', { id: cle.key.id });

  // Comptes en cible.
  fixer('compte', 'compte-superadmin', { id: comptes.SA.id });
  fixer('compte', 'compte-administrateur', { id: comptes.AD.id });
  fixer('compte', 'compte-commercial', { id: comptes.COM.id });
  fixer('compte', 'compte-technicien', { id: comptes.TECH.id });
  fixer('compte', 'compte-systeme', { id: '00000000-0000-4000-8000-000000000001' });

  // Cibles « inexistant » : un identifiant absent, couplé à un vrai client ou à une vraie intervention pour les
  // routes à deux paramètres (le second paramètre seul est absent).
  for (const [famille, { cibles }] of Object.entries(FAMILLES)) {
    for (const c of cibles) if (c.nom === INEXISTANT) {
      if (['contact', 'site', 'equipement'].includes(famille)) fixer(famille, INEXISTANT, { clientId: clientActif.id, id: ID_INEXISTANT });
      else if (famille === 'cout-sav') fixer(famille, INEXISTANT, { id: affecteeTech.id, coutId: ID_INEXISTANT });
      else fixer(famille, INEXISTANT, { id: ID_INEXISTANT });
    }
  }

  // Désactivation du client en dernier : ses contact, site et équipement ont été créés avant.
  await api(SA, 'DELETE', `/api/clients/${clientDesactive.id}`, {});

  // Chaque cible de chaque famille a ses identifiants.
  for (const [famille, { cibles }] of Object.entries(FAMILLES)) for (const c of cibles) assert.ok(c.ids?.id, `cible sans identifiant : ${famille} / ${c.nom}`);

  await verifierFaits({ prisma, comptes, donnees, ids: (famille, nom) => cibleDe(famille, nom).ids, intervenants: { ficheTech: ficheTech.id, ficheLibre: ficheLibre.id } });
  return { partage, clientActif, clientDesactive };
}

// Les faits qui portent les relations de la table, relus en base : une table qui ne dirait plus le vrai fait échouer
// la construction.
async function verifierFaits({ prisma, comptes, donnees, ids, intervenants }) {
  const chantier = async (nom) => prisma.chantier.findUniqueOrThrow({ where: { id: ids('chantier', nom).id }, select: { responsableId: true, commercialId: true, statut: true } });
  const attendus = {
    'chantier-ct': [comptes.CT.id, null, 'EN_COURS'],
    'chantier-ct-branche-resp': [donnees.CT_BRANCHE.id, null, 'EN_COURS'],
    'chantier-tech-branche-resp': [comptes.TECH.id, null, 'EN_COURS'],
    'chantier-resp': [comptes.RESP.id, null, 'EN_COURS'],
    'chantier-com': [donnees.CT_TIERS.id, comptes.COM.id, 'EN_COURS'],
    'chantier-com-titulaire': [comptes.COM.id, null, 'EN_COURS'],
    'chantier-ad': [comptes.AD.id, comptes['AD-COM'].id, 'EN_COURS'],
    'chantier-dir': [comptes.DIR.id, null, 'EN_COURS'],
    'chantier-dc': [comptes.DC.id, null, 'EN_COURS'],
    'chantier-ac': [comptes.AC.id, null, 'EN_COURS'],
    'chantier-cpt': [comptes.CPT.id, null, 'EN_COURS'],
    'chantier-autre': [donnees.CT_TIERS.id, null, 'EN_COURS'],
    'chantier-termine': [comptes.CT.id, null, 'TERMINE'],
    'chantier-annule': [comptes.CT.id, null, 'ANNULE'],
  };
  for (const [nom, [responsableId, commercialId, statut]] of Object.entries(attendus)) {
    assert.deepEqual(await chantier(nom), { responsableId, commercialId, statut }, `faits de ${nom}`);
  }
  const branche = await prisma.user.findMany({ where: { responsableHierarchiqueId: comptes.RESP.id }, select: { id: true } });
  assert.deepEqual(branche.map((u) => u.id).sort(), [comptes.TECH.id, donnees.CT_BRANCHE.id].sort(), 'branche de RESP');
  assert.equal(await prisma.user.count({ where: { responsableHierarchiqueId: comptes['RESP-SANS-BRANCHE'].id } }), 0, 'RESP-SANS-BRANCHE sans branche');
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: comptes.CT.id } })).responsableHierarchiqueId, comptes['CT-N1'].id, 'CT rattaché à CT-N1');
  assert.equal((await prisma.intervenant.findUniqueOrThrow({ where: { id: intervenants.ficheTech } })).userId, comptes.TECH.id, 'fiche du technicien reliée');
  assert.equal(await prisma.intervenant.count({ where: { userId: comptes['TECH-SANS-FICHE'].id } }), 0, 'TECH-SANS-FICHE sans fiche');
  const intervention = async (nom) => prisma.intervention.findUniqueOrThrow({
    where: { id: ids('intervention', nom).id },
    select: { statut: true, chantierId: true, createdById: true, contratMaintenanceId: true, affectations: { select: { intervenantId: true } } },
  });
  const faitsIntervention = {
    'intervention-affectee-tech': ['EN_COURS', ids('chantier', 'chantier-tech-branche-resp').id, [intervenants.ficheTech]],
    'curative-sans-chantier-branche': ['PLANIFIEE', null, [intervenants.ficheTech]],
    'intervention-creee-ct': ['A_PLANIFIER', null, []],
    'intervention-chantier-ct': ['PLANIFIEE', ids('chantier', 'chantier-ct').id, [intervenants.ficheLibre]],
    'intervention-terminee-signee': ['TERMINEE', ids('chantier', 'chantier-ct').id, [intervenants.ficheTech]],
    'intervention-terminee-motif': ['TERMINEE', null, [intervenants.ficheTech]],
    'intervention-annulee': ['ANNULEE', null, []],
    'intervention-autre': ['A_PLANIFIER', null, []],
  };
  for (const [nom, [statut, chantierId, affectes]] of Object.entries(faitsIntervention)) {
    const lue = await intervention(nom);
    assert.deepEqual({ statut: lue.statut, chantierId: lue.chantierId, affectes: lue.affectations.map((a) => a.intervenantId).sort() }, { statut, chantierId, affectes: [...affectes].sort() }, `faits de ${nom}`);
  }
  assert.equal((await intervention('intervention-creee-ct')).createdById, comptes.CT.id, 'intervention-creee-ct créée par CT');
  const visite = await intervention('visite-contrat');
  assert.deepEqual({ statut: visite.statut, contrat: visite.contratMaintenanceId }, { statut: 'A_PLANIFIER', contrat: ids('contrat', 'contrat-actif').id }, 'faits de visite-contrat');
  const signature = await prisma.interventionSignature.count({ where: { rapportId: ids('compte-rendu', 'rapport-signe').id } });
  assert.equal(signature, 1, 'rapport-signe signé');
  assert.equal(await prisma.interventionSignature.count({ where: { rapportId: ids('compte-rendu', 'rapport-non-signe').id } }), 0, 'rapport-non-signe non signé');
  const client = await prisma.client.findUniqueOrThrow({ where: { id: ids('client', 'client-desactive').id }, select: { actif: true } });
  assert.equal(client.actif, false, 'client-desactive désactivé');
}
