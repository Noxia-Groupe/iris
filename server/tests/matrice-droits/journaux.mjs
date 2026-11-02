// Outils de lecture des journaux des matrices de droits (lot D1a-5c ; cadrage de D1a-5c, version 3, §3), repris par
// D1a-5d sans changer d'interface : 5d ajoute ses tables à TABLES_DE_JOURNAL.
//
// Ce fichier n'est pas un fichier de tests (pas de suffixe « .test.mjs »). Il sert aux matrices des écritures réelles,
// une fois l'instantané de la base pris par l'outil de remise en état (remise-en-etat.mjs, dont il ne reprend que le
// nom du schéma de l'instantané) :
//  - TABLES_DE_JOURNAL : chaque table de journal, sa colonne d'auteur, le nom de ses entrées (nature, action, marques)
//    et ses routes de lecture, avec le compte refusé par défaut de chacune (cadrage §2.2 : « un compte refusé par
//    couple (route de lecture, dossier parent), le refus passant avant l'entrée, par la garde ou par le périmètre ») ;
//  - ouvrirConnexionLecture et entreesNouvelles : les lignes de ces tables absentes de l'instantané, ou changées depuis
//    lui, relues par une connexion pg en lecture seule, distincte de celle de la remise et de celles de l'application ;
//  - nommerEntree : « Table nature action par COMPTE », suivi des marques « concerne un SA » et « réservée au SA »
//    quand elles sont posées, sans identifiant, date ni chiffre (cadrage §2.1) ;
//  - lecturesDe, lecteursDe et lireVisibilite : qui lit une entrée, par quelle route, et le verdict de chaque lecteur
//    (« 200 visible », « 200 absente », ou le refus, code et message) ;
//  - finDeLigneCsv, lireExports et compterFinDeLigne : l'export CSV du journal d'administration ne porte aucun
//    identifiant ; une entrée y est reconnue par la fin de sa ligne, de l'auteur au détail, mise en forme comme
//    l'application (valeursJournalCsv de domaines/administration/journal.ts, csvComptable de commun/csv.ts), et
//    comptée avant et après l'écriture (cadrage §2.2).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { SCHEMA_INSTANTANE } from './remise-en-etat.mjs';
import { COMPTE_SYSTEME_ID } from './comptes.mjs';
import { enParallele, formaterReponse } from './outils.mjs';

// Lecteurs administrateurs de chaque entrée (cadrage §2.2) : le super administrateur et le simple administrateur.
// AD-COM n'est pas rejoué (D1a-3 prouve qu'il lit comme AD sur ces routes, réduction déclarée).
export const LECTEURS_ADMINISTRATION = ['SA', 'AD'];
const ADMINISTRATION = ['SA', 'AD', 'AD-COM'];
// Auteur absent d'une entrée du journal d'administration : le démarrage (SUPERADMIN_EMAILS), comme le filtre
// « auteur=DEMARRAGE » de la route (domaines/administration/journal.ts).
export const AUTEUR_DEMARRAGE = 'DEMARRAGE';
export const AUTEUR_SYSTEME = 'SYSTEME';

// Présence d'une ligne dans une réponse JSON : un tableau, ou le tableau `entrees` (journal d'administration), ou
// `envois` (journal des envois).
const elementsDe = (corps) => (Array.isArray(corps) ? corps : corps?.entrees ?? corps?.envois ?? []);
const presentParId = (id) => (res) => elementsDe(res.body).some((e) => e?.id === id);

// --- Export CSV du journal d'administration ---
// Même mise en forme que l'application : csvComptable (commun/csv.ts) pour chaque champ, valeursJournalCsv
// (domaines/administration/journal.ts) pour l'avant et l'après. Recopiée ici, et non importée de dist, pour qu'un
// changement de l'export ne change pas aussi l'outil qui le lit : l'outil échoue alors, faute de pouvoir conclure.
export function csvComptable(valeur) {
  const texte = String(valeur ?? '');
  const formule = /^[=+@\t\r]/.test(texte) || (texte.startsWith('-') && !Number.isFinite(Number(texte)));
  return `"${(formule ? `'${texte}` : texte).replace(/"/g, '""')}"`;
}
function valeursJournalCsv(valeurs) {
  if (!valeurs || typeof valeurs !== 'object') return '';
  return Object.entries(valeurs).map(([champ, valeur]) => `${champ} : ${typeof valeur === 'string' ? valeur : JSON.stringify(valeur)}`).join(' ; ');
}
// Fin de la ligne d'une entrée dans l'export : de l'auteur au détail (la date et l'heure, qui précèdent, varient).
export function finDeLigneCsv(ligne) {
  return [ligne.auteurNom, ligne.domaine, ligne.type, ligne.action, ligne.cibleLibelle ?? '', valeursJournalCsv(ligne.avant), valeursJournalCsv(ligne.apres), ligne.detail ?? ''].map(csvComptable).join(';');
}
// Nombre de lignes de l'export qui se terminent par cette fin de ligne (chaque ligne finit par un saut de ligne, la
// dernière comprise ; un champ qui contiendrait un saut de ligne reste compté une fois).
export function compterFinDeLigne(texte, fin) {
  const motif = `;${fin}\n`;
  let n = 0; let position = texte.indexOf(motif);
  while (position !== -1) { n += 1; position = texte.indexOf(motif, position + motif.length); }
  return n;
}
// Exports CSV du journal d'administration, lus par chaque lecteur (texte décodé, sans la marque d'ordre des octets).
export async function lireExports({ appeler, adresse, jetons, lecteurs = LECTEURS_ADMINISTRATION, requete }) {
  const exports = {};
  for (const lecteur of lecteurs) {
    const res = await appeler(adresse, 'GET', '/api/journal-administration/export.csv', { jeton: jetons[lecteur], octets: true, requete });
    assert.equal(res.status, 200, `export CSV du journal d’administration lu par ${lecteur} : ${res.status}`);
    exports[lecteur] = res.octets.toString('utf8').replace(/^\uFEFF/, '');
  }
  return exports;
}

// --- Tables de journal ---
// `auteur` : colonne de l'auteur (null : la table n'en a pas) ; `sansAuteur` : nom d'un auteur absent ; `ajoutSeul` :
// table en ajout seul (une ligne existante qui change est signalée) ; `nature`, `action` : les deux mots du nom
// (`avant` : la ligne de l'instantané pour une ligne changée, null pour une ligne nouvelle) ; `marques` ; `lectures` :
// routes de lecture de l'entrée, chacune avec son compte refusé par défaut et sa fonction de présence.
const parent = (ligne, colonnes) => colonnes.find(([colonne]) => ligne[colonne]);
const PARENTS_ENVOI = [
  ['devisId', 'DEVIS', 'devis', 'DIR'],
  ['factureId', 'FACTURE', 'factures', 'DIR'],
  ['interventionId', 'INTERVENTION', 'interventions', 'DIR'],
  ['contratMaintenanceId', 'CONTRAT', 'contrats-maintenance', 'DIR'],
  ['chantierId', 'CHANTIER', 'chantiers', 'DIR'],
];
const PARENTS_SAISIE = [
  // Journal du chantier : ouvert à tout compte connecté, à son périmètre (chantiers/routes.ts) ; refusé par défaut au
  // commercial, hors du périmètre des chantiers dont il n'est pas le commercial (404).
  ['chantierId', 'chantiers', 'COM'],
  // Journal de l'intervention : le directeur est refusé par la garde (blockCommercial, 403).
  ['interventionId', 'interventions', 'DIR'],
  // Journal du contrat : administration seule (403 pour le directeur).
  ['contratMaintenanceId', 'contrats-maintenance', 'DIR'],
];
const etatIdentique = (ligne, champs) => (res) => elementsDe(res.body).some((e) => e?.id === ligne.id && champs.every(([champ, egal]) => egal(e[champ], ligne[champ])));
const memeBooleen = (a, b) => !!a === !!b;
const memeNullite = (a, b) => (a === null || a === undefined) === (b === null || b === undefined);

export const TABLES_DE_JOURNAL = {
  // Journal des paramètres et des droits : liste et export, pour l'administration (403 « Accès réservé aux
  // administrateurs » pour le directeur) ; l'export n'est lu que par SA et AD (cadrage §2.2).
  JournalAdministration: {
    auteur: 'auteurId', sansAuteur: AUTEUR_DEMARRAGE, ajoutSeul: true,
    nature: (l) => l.type, action: (l) => l.action,
    marques: (l) => [l.concerneSuperAdmin && 'concerne un SA', l.reserveSuperAdmin && 'réservée au SA'].filter(Boolean),
    lectures: (l) => [
      { route: 'GET /api/journal-administration', chemin: '/api/journal-administration', refuse: 'DIR', present: presentParId(l.id) },
      { route: 'GET /api/journal-administration/export.csv', chemin: '/api/journal-administration/export.csv', refuse: null, administrationSeule: true, finCsv: finDeLigneCsv(l) },
    ],
  },
  // Journal des saisies : chantier, intervention ou contrat, selon le parent renseigné (un seul à la fois).
  JournalSaisieChantier: {
    auteur: 'auteurId', ajoutSeul: true,
    nature: (l) => l.cible, action: (l) => l.action,
    lectures: (l) => {
      const [colonne, segment, refuse] = parent(l, PARENTS_SAISIE) ?? [];
      assert.ok(colonne, `JournalSaisieChantier ${l.cible} ${l.action} : aucun parent`);
      return [{ route: `GET /api/${segment}/:id/journal-saisies`, chemin: `/api/${segment}/${l[colonne]}/journal-saisies`, refuse, famille: segment, present: presentParId(l.id) }];
    },
  },
  // Journal des envois : nature, le document envoyé ; action, le canal.
  EnvoiDocument: {
    auteur: 'auteurId', ajoutSeul: true,
    nature: (l) => parent(l, PARENTS_ENVOI)?.[1] ?? 'SANS_DOCUMENT', action: (l) => l.canal,
    lectures: (l) => {
      const [colonne, , segment, refuse] = parent(l, PARENTS_ENVOI) ?? [];
      assert.ok(colonne, 'EnvoiDocument : aucun document');
      return [{ route: `GET /api/${segment}/:id/envois`, chemin: `/api/${segment}/${l[colonne]}/envois`, refuse, famille: segment, present: presentParId(l.id) }];
    },
  },
  JournalFacture: {
    auteur: 'acteurId', ajoutSeul: true,
    nature: () => null, action: (l) => l.action,
    lectures: (l) => [{ route: 'GET /api/factures/:id/journal', chemin: `/api/factures/${l.factureId}/journal`, refuse: 'DIR', present: presentParId(l.id) }],
  },
  JournalCompteComptable: {
    auteur: 'auteurId', ajoutSeul: true,
    nature: () => null, action: (l) => l.action,
    lectures: (l) => [{ route: 'GET /api/comptabilite/comptes/:id/journal', chemin: `/api/comptabilite/comptes/${l.compteId}/journal`, refuse: 'DIR', present: presentParId(l.id) }],
  },
  JournalRegleComptable: {
    auteur: 'auteurId', ajoutSeul: true,
    nature: (l) => l.type, action: (l) => l.action,
    lectures: (l) => [{ route: 'GET /api/comptabilite/regles/journal', chemin: '/api/comptabilite/regles/journal', refuse: 'DIR', present: presentParId(l.id) }],
  },
  // Versions des mentions légales, sans auteur (écart connu, « à appliquer », passation section 4) : une version créée,
  // ou changée par une publication (la version publiée devient active, l'ancienne inactive).
  MentionsLegalesVersion: {
    auteur: null, ajoutSeul: false,
    nature: () => 'VERSION',
    action: (l, avant) => {
      if (!avant) return 'CREATION';
      if (!avant.publieeLe && l.publieeLe) return 'PUBLICATION';
      if (avant.actif && !l.actif) return 'RETRAIT';
      return 'MODIFICATION';
    },
    lectures: (l) => [{ route: 'GET /api/mentions-legales', chemin: '/api/mentions-legales', refuse: 'DIR', present: etatIdentique(l, [['actif', memeBooleen], ['publieeLe', memeNullite]]) }],
  },
  // Passages de la génération des visites ; nature, le déclenchement ; action, le statut. La route n'en montre que le
  // dernier et le dernier passage automatique.
  ExecutionGenerationVisites: {
    auteur: 'auteurId', ajoutSeul: false,
    nature: (l) => l.declenchement, action: (l) => l.statut,
    lectures: (l) => [{
      route: 'GET /api/contrats-maintenance/generation-visites', chemin: '/api/contrats-maintenance/generation-visites', refuse: 'DIR',
      present: (res) => res.body?.derniereExecution?.id === l.id || res.body?.derniereExecutionAutomatique?.id === l.id,
    }],
  },
  // Historique des clés d'intégration : la clé créée, ou révoquée ; l'auteur noté est celui de la création. Lu par le
  // super administrateur seul (403 « Accès réservé au super administrateur » pour AD, compte refusé de la route).
  ApiAccessKey: {
    auteur: 'creeParId', auteurDeLaCreation: true, ajoutSeul: false,
    nature: () => 'CLE',
    action: (l, avant) => {
      if (!avant) return 'CREATION';
      if (avant.actif && !l.actif && l.revoqueLe) return 'REVOCATION';
      return 'MODIFICATION';
    },
    lectures: (l) => [{ route: 'GET /api/admin/api-keys', chemin: '/api/admin/api-keys', refuse: 'AD', present: etatIdentique(l, [['actif', memeBooleen], ['revoqueLe', memeNullite]]) }],
  },
};

// --- Entrées nouvelles ---
// Connexion pg en lecture seule (default_transaction_read_only), distincte de celle de la remise en état et de celles
// de l'application ; vérifiée avant usage.
export async function ouvrirConnexionLecture(url) {
  const client = new pg.Client({ connectionString: url, application_name: 'iris-matrice-journaux-lecture', options: '-c default_transaction_read_only=on' });
  await client.connect();
  const { rows: [{ default_transaction_read_only: lectureSeule }] } = await client.query('SHOW default_transaction_read_only');
  assert.equal(lectureSeule, 'on', 'connexion de lecture des journaux : elle doit être en lecture seule');
  return client;
}
const ident = (nom) => {
  assert.match(nom, /^[A-Za-z_][A-Za-z0-9_]*$/, `identifiant SQL inattendu : ${nom}`);
  return `"${nom}"`;
};
// Lignes des tables de journal absentes de l'instantané, ou changées depuis lui (comparaison de la ligne entière, par
// son identifiant). Rend [{ table, ligne, avant }], `avant` étant la ligne de l'instantané (null pour une ligne
// nouvelle), triées par table puis identifiant.
export async function entreesNouvelles(connexion, { tables = Object.keys(TABLES_DE_JOURNAL) } = {}) {
  const morceaux = tables.map((table) => `SELECT '${table}' AS "table", to_jsonb(t) AS ligne, CASE WHEN s.id IS NULL THEN NULL ELSE to_jsonb(s) END AS avant
    FROM public.${ident(table)} t LEFT JOIN ${ident(SCHEMA_INSTANTANE)}.${ident(table)} s ON s.id = t.id
    WHERE s.id IS NULL OR to_jsonb(s) IS DISTINCT FROM to_jsonb(t)`);
  const texte = `${morceaux.join(' UNION ALL ')} ORDER BY 1, 2`;
  // Requête préparée (nommée), planifiée une fois : nom tiré de son texte, propre à chaque liste de tables.
  const { rows } = await connexion.query({ name: `entrees-nouvelles-${createHash('md5').update(texte).digest('hex')}`, text: texte });
  return rows.map((r) => ({ table: r.table, ligne: r.ligne, avant: r.avant }));
}
// Même entrée (table, identifiant et contenu) : sert à séparer les entrées d'un préalable de celles de l'écriture.
export const memeEntree = (a, b) => a.table === b.table && a.ligne.id === b.ligne.id && JSON.stringify(a.ligne) === JSON.stringify(b.ligne);

// --- Nom d'une entrée ---
// `noms` : identifiant de compte → nom du compte joué (SA, AD, CT…). Le compte système se nomme SYSTEME ; un compte
// créé par une écriture, « autre compte ».
export function nomDuCompte(id, noms) {
  if (id === COMPTE_SYSTEME_ID) return AUTEUR_SYSTEME;
  return noms.get(id) ?? 'autre compte';
}
export function nommerEntree(entree, noms) {
  const definition = TABLES_DE_JOURNAL[entree.table];
  assert.ok(definition, `table de journal inconnue : ${entree.table}`);
  const { ligne, avant } = entree;
  let nom = [entree.table, definition.nature(ligne, avant), definition.action(ligne, avant)].filter(Boolean).join(' ');
  if (!definition.auteur) nom += ', sans auteur';
  else {
    const auteurId = ligne[definition.auteur];
    const auteur = auteurId === null || auteurId === undefined ? definition.sansAuteur ?? 'personne' : nomDuCompte(auteurId, noms);
    nom += definition.auteurDeLaCreation && avant ? `, créée par ${auteur}` : ` par ${auteur}`;
  }
  for (const marque of definition.marques?.(ligne) ?? []) nom += `, ${marque}`;
  if (definition.ajoutSeul && avant) nom += ', ligne existante modifiée';
  assert.ok(!/[|;\n]/.test(nom), `nom d’entrée invalide : ${nom}`);
  return nom;
}

// --- Lectures ---
export function lecturesDe(entree) {
  return TABLES_DE_JOURNAL[entree.table].lectures(entree.ligne);
}
// Lecteurs d'une route de lecture : SA, AD, l'auteur du cas s'il est hors administration (pas pour l'export, lu par SA
// et AD seuls), et le compte refusé de la route (`refuse`, qu'un cas peut remplacer quand le refusé par défaut entre
// dans le périmètre par l'écriture elle-même).
export function lecteursDe(lecture, auteur, refuse = lecture.refuse) {
  const lecteurs = [...LECTEURS_ADMINISTRATION];
  if (!lecture.administrationSeule && auteur && !ADMINISTRATION.includes(auteur) && auteur !== AUTEUR_SYSTEME) lecteurs.push(auteur);
  if (!lecture.administrationSeule && refuse) lecteurs.push(refuse);
  return [...new Set(lecteurs)];
}
// Lit une entrée par chacune de ses routes, pour chaque lecteur. Rend [{ lecteur, route, verdict }], le verdict étant
// « 200 visible », « 200 absente », ou le refus (formaterReponse). Pour l'export CSV : la fin de ligne de l'entrée est
// comptée dans l'export du lecteur et dans son export de référence (`exportsReference`, la base remise étant à l'état de
// référence avant l'écriture) ; « visible » si l'écart est le nombre d'entrées nouvelles de même fin de ligne
// (`entreesDuCas`), « absente » s'il est nul ; sinon, l'outil échoue avec un message clair.
export async function lireVisibilite({ appeler, adresse, jetons, entree, auteur, exportsReference, entreesDuCas, refuses = {}, nom = '' }) {
  const taches = [];
  for (const lecture of lecturesDe(entree)) {
    for (const lecteur of lecteursDe(lecture, auteur, refuses[lecture.route] ?? lecture.refuse)) {
      taches.push(async () => {
        const res = await appeler(adresse, 'GET', lecture.chemin, { jeton: jetons[lecteur], octets: !!lecture.finCsv });
        if (res.status !== 200) return { lecteur, route: lecture.route, verdict: formaterReponse(res) };
        if (!lecture.finCsv) return { lecteur, route: lecture.route, verdict: lecture.present(res) ? '200 visible' : '200 absente' };
        const reference = exportsReference?.[lecteur];
        assert.ok(typeof reference === 'string', `export CSV de référence absent pour ${lecteur} : l’outil ne peut pas conclure sur « ${nom} »`);
        const texte = res.octets.toString('utf8').replace(/^\uFEFF/, '');
        const avant = compterFinDeLigne(reference, lecture.finCsv);
        const apres = compterFinDeLigne(texte, lecture.finCsv);
        const attendues = entreesDuCas.filter((e) => e.table === 'JournalAdministration' && finDeLigneCsv(e.ligne) === lecture.finCsv).length;
        if (attendues > 0 && apres === avant + attendues) return { lecteur, route: lecture.route, verdict: '200 visible' };
        if (apres === avant) return { lecteur, route: lecture.route, verdict: '200 absente' };
        return assert.fail(`Export CSV du journal d’administration lu par ${lecteur} : impossible de conclure sur l’entrée « ${nom} ». Sa fin de ligne y figure ${apres} fois, contre ${avant} fois dans l’export de référence, pour ${attendues} entrée(s) nouvelle(s) de même fin de ligne : ni toutes visibles, ni toutes absentes.`);
      });
    }
  }
  return enParallele(taches, 8);
}
