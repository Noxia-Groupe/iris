// Lot D1a-5a : écritures réelles des actions (b) et des routes marquées validation-avant-droit, sur chaque cible
// réelle, base remise à l'état de référence entre deux cas ; tests seuls (cadrage du lot D1a, version 3 du
// 01-11-2026, §2 et ligne D1a-5 du §3 ; avenant au cadrage pour D1a-5, version 2, sections 1 à 5, ligne D1a-5a).
//
// Tests seuls : ce fichier enregistre le comportement actuel, sans rien corriger (cadrage §1 et §7). Il reprend les
// outils, les comptes, le jeu de données et la table des routes de D1a-1 (server/tests/matrice-droits/), et ajoute
// l'outil de remise en état (matrice-droits/remise-en-etat.mjs, avenant section 1, approche A3). Il enregistre :
//  - les 20 routes (b) de session (action sans corps, avec un paramètre), jouées à corps vide par les 15 comptes sur
//    CHAQUE CIBLE RÉELLE de leur famille, et non plus sur un identifiant inexistant (cadrage §2.4 (b) : « le refus sur
//    un dossier réel, dans ou hors du périmètre, relève de D1a-5 »), dont l'émission d'une facture (brouillon émis ;
//    refus sur une facture émise et sur un avoir, sans effet) ;
//  - les 16 routes (a) marquées validation-avant-droit (13 avec une famille de cibles ; POST /api/achats, /api/heures
//    et /api/devis sans famille), rejouées AVEC UN CORPS VALIDE par les 15 comptes sur chaque cible réelle de leur
//    famille, ou avec la cible portée par le corps (chantierId, clientId), dans et hors du périmètre. Le corps peut
//    dépendre de l'état de la cible (statut d'une intervention ou d'un chantier, relu en base) : un corps par état, et
//    plusieurs quand le droit dépend du corps (annulation, marque « à suivre » posée ou retirée, rôle de super
//    administrateur, cible de la conversion d'un devis). Aucun corps ne porte de champ réservé à D1a-5d : ni prix
//    d'achat prévu d'une ligne de devis (prixAchatUnitaireHt), ni budgetGlobalVendu, ni champ d'un groupe de
//    MONTANTS_MASQUES_ECRITURES ; un montant requis par la route (montantHT d'un achat, quantité et montant d'un coût
//    SAV, prix des lignes d'un devis) y est, et le refus comme l'absence d'effet sont joués pour qui ne doit pas écrire.
//    L'envoi du compte rendu (POST /api/interventions/:id/envois) passe par la messagerie (canal absent), jamais par
//    Microsoft 365.
// Une ligne : compte, route, cible, contexte (« défaut », suivi du nom du corps pour une route marquée), réponse (code,
// et message exact d'un refus), puis « écrit (tables) » ou « inchangé » selon l'empreinte de toute la base. Jamais un
// montant : un 2xx s'écrit par son code seul. Un 400 porte aussi son message (option messageDu400 de formaterReponse) :
// le corps étant valide, il vient de l'état de la cible ou d'un refus rendu en 400, et non d'un corps mal formé (écart
// de forme au cadrage §2.1, « code seul pour un 400 », déclaré).
//
// Déroulement d'une route : les comptes refusés à l'entrée (D1a-1, entrees.txt : toutes leurs lignes de la route en
// 401, 403 ou 410) sont joués en parallèle sur chaque cible, avec une empreinte pour le lot ; si le lot a écrit, la
// base est remise et le lot rejoué un à un pour nommer le cas. Les comptes admis à l'entrée sont joués un à un,
// empreinte après chaque appel ; un cas qui écrit est noté « écrit (tables) », puis la base est remise en état et
// vérifiée (empreinte de toute la base et séquences égales à la référence, sonde d'immutabilité). Le tout est comparé
// au caractère près à la référence versionnée server/tests/matrice-droits/ecritures-actions.txt (diff imprimé, résumé
// par compte et route au-delà de 60 lignes).
//
// Rôle PostgreSQL : la remise pose session_replication_role. Si le rôle de TEST_DATABASE_URL ne le peut pas
// (exigerRoleReplication éprouve la capacité elle-même), aucune base n'est créée, le test « rôle PostgreSQL » échoue
// avec un message qui dit ce qu'il faut et pourquoi, et chacun des autres échoue en le citant ; le fichier ne
// s'ignore jamais. Sans TEST_DATABASE_URL, il s'annonce ignoré comme les autres fichiers de la matrice : un SKIP n'est
// pas une réussite.
//
// Comme les autres fichiers de la matrice, ce fichier crée sur le serveur de TEST_DATABASE_URL une base jetable qui
// n'appartient qu'à lui, la migre, la sert à l'application, puis la supprime (le schéma de l'instantané avec elle).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import { join } from 'node:path';
import {
  CONTEXTE_DEFAUT, DOSSIER_MATRICES, EMAIL_SECOURS, JETON_SECOURS, SEPARATEUR, appeler, baseJetable, chargerApplication,
  comparerAvecReference, enParallele, formaterReponse, ligneMatrice, lireReference, tablesDeLaBase,
} from './matrice-droits/outils.mjs';
import { COMPTES_JOUES, creerComptes } from './matrice-droits/comptes.mjs';
import { FAMILLES, INEXISTANT, cheminPour, cibleDe, construireJeuDeDonnees, jourSociete } from './matrice-droits/donnees.mjs';
import { ROUTES_SESSION } from './matrice-droits/routes.mjs';
import { creerRemiseEnEtat, exigerRoleReplication } from './matrice-droits/remise-en-etat.mjs';

const TITRE = 'Lot D1a-5a : écritures réelles des actions (b) et des routes marquées validation-avant-droit, sur chaque cible, base remise en état entre deux cas';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const REFERENCE = join(DOSSIER_MATRICES, 'ecritures-actions.txt');
const REFERENCE_ENTREES = join(DOSSIER_MATRICES, 'entrees.txt');
const SA = 'SA';
// Comptes sans périmètre (administration) : le minimum « dans et hors du périmètre » (avenant, section 3) ne les vise pas.
const ADMINISTRATION = ['SA', 'AD', 'AD-COM'];
// Réponses d'entrée qui refusent un compte avant toute cible (avenant, section 3 : « toutes leurs lignes d'entrees.txt
// portent la même réponse 401, 403 ou 410 »).
const REFUS_AVANT_LA_CIBLE = /^(401|403|410) /;
const TRACE = { ratio: 2, traits: [[[0.1, 0.6], [0.25, 0.3], [0.4, 0.7], [0.6, 0.35]]] };
const DESTINATAIRE = 'contact-matrice@iris.test';

// Routes jouées : les (b) et les (a) marquées validation-avant-droit de la table de D1a-1.
const ROUTES_B = Object.keys(ROUTES_SESSION).filter((route) => ROUTES_SESSION[route].ecriture === 'b').sort();
const ROUTES_MARQUEES = Object.keys(ROUTES_SESSION).filter((route) => ROUTES_SESSION[route].ecriture === 'a' && ROUTES_SESSION[route].validationAvantDroit).sort();
// Routes marquées sans famille : la cible est portée par le corps (avenant, section 2 ; consigne de D1a-5a, point 4).
const CIBLE_DU_CORPS = {
  'POST /api/achats': { famille: 'chantier', champ: 'chantierId' },
  'POST /api/heures': { famille: 'chantier', champ: 'chantierId' },
  'POST /api/devis': { famille: 'client', champ: 'clientId' },
};
// Route (b) sans famille : la version des mentions légales, cibles propres à ce fichier (la version publiée du jeu de
// données, et une version brouillon créée ici, par l'API).
const ROUTE_MENTIONS = 'POST /api/mentions-legales/:version/publier';

// Corps valides des routes marquées, selon la cible et son état (relu en base avant la matrice). Chaque variante a un
// nom, écrit dans le contexte de la ligne (« défaut, corps <nom> »). `d` : identifiants et dates du jeu de données.
const CORPS = {
  // Correction d'un coût SAV : le technicien corrige ses heures, l'encadrement le matériel ; le motif est exigé.
  'PATCH /api/interventions/:id/couts/:type/:coutId': (cible) => (cible.ids.type === 'achats'
    ? [{ nom: 'montantHT et motif', corps: () => ({ motifCorrection: 'TEST correction du matériel par la matrice', montantHT: 12.5 }) }]
    : [{ nom: 'nbrHeures et motif', corps: () => ({ motifCorrection: 'TEST correction des heures par la matrice', nbrHeures: 1.25 }) }]),
  // Compte rendu : une clé d'envoi neuve à chaque appel (une clé déjà servie relirait le compte rendu existant).
  'POST /api/interventions/:id/rapports': () => [{ nom: 'contenu et clé d’envoi', corps: () => ({ contenu: 'TEST Compte rendu de la matrice des écritures.', cleEnvoi: randomUUID() }) }],
  'POST /api/interventions/rapports/:rapportId/signature': () => [{ nom: 'signataire, confirmation et tracé', corps: () => ({ signataire: 'TEST Signataire de la matrice', confirme: true, trace: TRACE }) }],
  // Statut d'une intervention : la transition permise depuis son état, et l'annulation (motif) tant qu'elle est
  // possible ; d'une intervention terminée ou annulée, aucune transition n'existe : « démarrer », qu'un technicien
  // peut demander, montre son périmètre.
  'PATCH /api/interventions/:id/statut': (cible) => {
    const annuler = { nom: 'statut=ANNULEE et motif', corps: () => ({ statut: 'ANNULEE', motif: 'TEST annulation par la matrice' }) };
    switch (cible.etat) {
      case 'A_PLANIFIER': return [{ nom: 'statut=PLANIFIEE', corps: () => ({ statut: 'PLANIFIEE' }) }, annuler];
      case 'PLANIFIEE': return [{ nom: 'statut=EN_COURS', corps: () => ({ statut: 'EN_COURS' }) }, annuler];
      case 'EN_COURS': return [{ nom: 'statut=TERMINEE et motif sans signature', corps: () => ({ statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' }) }, annuler];
      default: return [{ nom: 'statut=EN_COURS', corps: () => ({ statut: 'EN_COURS' }) }];
    }
  },
  'POST /api/interventions/:id/remise-a-planifier': () => [{ nom: 'motif', corps: () => ({ motif: 'TEST remise à planifier par la matrice' }) }],
  // Marque « à suivre » : posée (encadrement) ou retirée (encadrement et technicien affecté).
  'PUT /api/interventions/:id/a-suivre': () => [
    { nom: 'aSuivre=oui', corps: () => ({ aSuivre: true }) },
    { nom: 'aSuivre=non', corps: () => ({ aSuivre: false }) },
  ],
  // Envoi du compte rendu par la messagerie (canal absent) : aucun appel à Microsoft.
  'POST /api/interventions/:id/envois': () => [{ nom: 'destinataire, messagerie', corps: () => ({ destinataire: DESTINATAIRE }) }],
  // Statut d'un chantier : clôturer un chantier en cours, rouvrir un chantier terminé ; un chantier annulé ne change
  // plus (clôturer, comme le titulaire le demanderait).
  'PATCH /api/chantiers/:id/statut': (cible) => (cible.etat === 'TERMINE'
    ? [{ nom: 'statut=EN_COURS', corps: () => ({ statut: 'EN_COURS' }) }]
    : [{ nom: 'statut=TERMINE', corps: () => ({ statut: 'TERMINE' }) }]),
  // Type d'un compte : un type ordinaire, et le type super administrateur, que seul un super administrateur donne.
  'PATCH /api/users/:id/role': () => [
    { nom: 'role=DIRECTEUR', corps: () => ({ role: 'DIRECTEUR' }) },
    { nom: 'role=SUPERADMIN', corps: () => ({ role: 'SUPERADMIN' }) },
  ],
  // Responsable hiérarchique : un responsable ordinaire, et le super administrateur, qu'un administrateur ne voit pas.
  'PATCH /api/users/:id/responsable-hierarchique': (_cible, d) => [
    { nom: 'responsable=RESP', corps: () => ({ responsableHierarchiqueId: d.comptes.RESP.id }) },
    { nom: 'responsable=SA', corps: () => ({ responsableHierarchiqueId: d.comptes.SA.id }) },
  ],
  // Fiche intervenant reliée à un compte technicien actif sans fiche.
  'PUT /api/intervenants/:id/compte': (_cible, d) => [{ nom: 'compte=TECH-SANS-FICHE', corps: () => ({ userId: d.comptes['TECH-SANS-FICHE'].id }) }],
  // Achat et heures d'un chantier, cible portée par chantierId ; le montant HT de l'achat est requis.
  'POST /api/achats': (cible, d) => [{ nom: 'achat', corps: () => ({ chantierId: cible.ids.id, categorieId: d.categorie, fournisseurId: d.fournisseur, date: d.hier, description: 'TEST Achat de la matrice des écritures', montantHT: 12.5 }) }],
  'POST /api/heures': (cible, d) => [{ nom: 'heures', corps: () => ({ chantierId: cible.ids.id, intervenantId: d.ficheLibre, date: d.hier, nbrHeures: 2 }) }],
  // Devis : créé pour le client porté par clientId ; modifié avec le client actif. Lignes sans prix d'achat prévu.
  'POST /api/devis': (cible) => [{ nom: 'client, objet et ligne', corps: () => ({ clientId: cible.ids.id, objet: 'TEST Devis de la matrice des écritures', lignes: [{ designation: 'TEST Ligne de la matrice des écritures', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 150, tauxTva: 20 }] }) }],
  'PATCH /api/devis/:id': (_cible, d) => [{ nom: 'client, objet et ligne', corps: () => ({ clientId: d.clientActif, objet: 'TEST Devis modifié par la matrice', lignes: [{ designation: 'TEST Ligne modifiée par la matrice', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 150, tauxTva: 20 }] }) }],
  // Conversion d'un devis : chacune des trois cibles, sans champ d'ouverture du chantier (titulaire, commercial,
  // types, date), ni coût d'achat prévu.
  'POST /api/devis/:id/convertir': (_cible, d) => [
    { nom: 'cible=CHANTIER', corps: () => ({ cible: 'CHANTIER' }) },
    { nom: 'cible=INTERVENTION', corps: () => ({ cible: 'INTERVENTION' }) },
    { nom: 'cible=CONTRAT', corps: () => ({ cible: 'CONTRAT', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: d.aujourdhui }) },
  ],
};

// Réponses d'entrée de D1a-1, par compte, route et contexte par défaut.
function lireEntrees() {
  const texte = lireReference(REFERENCE_ENTREES);
  assert.ok(texte, `référence d’entrée absente : ${REFERENCE_ENTREES}`);
  const parCouple = new Map();
  for (const ligne of texte.split('\n').filter(Boolean)) {
    const [compte, route, , contexte, reponse] = ligne.split(SEPARATEUR);
    if (contexte !== CONTEXTE_DEFAUT) continue;
    const cle = `${compte}${SEPARATEUR}${route}`;
    if (!parCouple.has(cle)) parCouple.set(cle, []);
    parCouple.get(cle).push(reponse);
  }
  return parCouple;
}
// Un compte est refusé avant la cible quand toutes ses lignes d'entrée de la route portent la même réponse 401, 403 ou 410.
function refuseAvantLaCible(entrees, compte, route) {
  const reponses = entrees.get(`${compte}${SEPARATEUR}${route}`) ?? [];
  assert.ok(reponses.length, `entrees.txt n’a aucune ligne pour ${compte} sur ${route}`);
  return reponses.every((r) => r === reponses[0]) && REFUS_AVANT_LA_CIBLE.test(reponses[0]);
}

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const base = baseJetable(TEST_DATABASE_URL, 'actions');
    let appli; let remise; let etatInitial;
    // Refus du rôle PostgreSQL (exigerRoleReplication) : le premier test échoue avec son message, chacun des autres
    // échoue en le citant ; aucune base n'est créée. Jamais un SKIP.
    let refusRole = null;
    const PREPARATION_INTERROMPUE = 'Préparation interrompue : le rôle PostgreSQL de TEST_DATABASE_URL ne peut pas poser session_replication_role (voir le test « rôle PostgreSQL »).';
    const testPrepare = (titre, corps) => test(titre, async (t) => {
      if (refusRole) assert.fail(PREPARATION_INTERROMPUE);
      return corps(t);
    });
    let comptes = {};
    let donnees = {};
    let entrees = new Map();
    const lignes = [];
    // Cibles des routes sans famille de D1a-1 (mentions légales) : nom, chemin.
    const ciblesMentions = [];
    // Chiffres du rapport (consigne de D1a-5a) : cas en parallèle, un à un, écrits, lots rejoués.
    const chiffres = { casParalleles: 0, casUnAUn: 0, casEcrits: 0, lotsRejoues: [], parRoute: {} };
    // Couples (compte, route) admis à l'entrée, et la relation de chaque cible jouée (minimum de l'avenant, section 3).
    const couples = new Map();

    const api = async (compte, methode, chemin, corps, statut = 200) => {
      const res = await appeler(appli.adresse, methode, chemin, { jeton: comptes[compte].jeton, corps: methode === 'GET' ? undefined : corps });
      const admis = Array.isArray(statut) ? statut : [statut];
      assert.ok(admis.includes(res.status), `${methode} ${chemin} (${compte}) : ${res.status} ${JSON.stringify(res.body)?.slice(0, 400)}`);
      return res.body;
    };

    // Cibles jouées pour une route : chaque cible réelle de sa famille, celle que porte le corps, ou les versions des
    // mentions légales. Chaque cible : nom (dans la ligne), chemin, ids, état, relation de chaque compte.
    const ciblesDe = (route) => {
      const [, chemin] = route.split(' ');
      const definition = ROUTES_SESSION[route];
      if (route === ROUTE_MENTIONS) return ciblesMentions.map((c) => ({ ...c, relations: {} }));
      const porteeParLeCorps = CIBLE_DU_CORPS[route];
      if (porteeParLeCorps) {
        return FAMILLES[porteeParLeCorps.famille].cibles.filter((c) => c.nom !== INEXISTANT)
          .map((c) => ({ nom: `${porteeParLeCorps.champ}=${c.nom}`, chemin, ids: c.ids, etat: c.etat, relations: c.relations }));
      }
      assert.ok(definition.famille, `${route} : ni famille, ni cible portée par le corps`);
      return FAMILLES[definition.famille].cibles.filter((c) => c.nom !== INEXISTANT)
        .map((c) => ({ nom: c.nom, chemin: cheminPour(chemin, definition.famille, c), ids: c.ids, etat: c.etat, relations: c.relations }));
    };

    // Cas d'une route : (compte, cible, variante de corps).
    const casDe = (route) => {
      const marquee = ROUTES_MARQUEES.includes(route);
      const cas = [];
      for (const cible of ciblesDe(route)) {
        const variantes = marquee ? CORPS[route](cible, donnees) : [{ nom: null, corps: () => ({}) }];
        assert.ok(variantes.length, `${route} : aucun corps pour ${cible.nom}`);
        for (const variante of variantes) {
          for (const compte of COMPTES_JOUES) {
            cas.push({ compte, cible, contexte: variante.nom ? `${CONTEXTE_DEFAUT}, corps ${variante.nom}` : CONTEXTE_DEFAUT, corps: variante.corps });
          }
        }
      }
      return cas;
    };

    const jouerRoute = async (route) => {
      const [methode, chemin] = route.split(' ');
      const appel = (c) => appeler(appli.adresse, methode, c.cible.chemin, { jeton: comptes[c.compte].jeton, corps: c.corps() });
      const ligne = (c, res, ecriture) => ligneMatrice({
        compte: c.compte, methode, chemin, cible: c.cible.nom, contexte: c.contexte,
        reponse: formaterReponse(res, { ecriture, messageDu400: true }),
      });
      const nommer = (c) => `${c.compte} sur ${route}, cible ${c.cible.nom}, contexte ${c.contexte}`;
      // Un cas joué seul : empreinte après l'appel ; s'il a écrit, remise en état et vérification.
      const unAUn = async (c) => {
        const res = await appel(c);
        const changees = remise.changees(await remise.empreinte());
        chiffres.casUnAUn += 1;
        lignes.push(ligne(c, res, changees.length ? `écrit (${changees.join(',')})` : 'inchangé'));
        if (changees.length) {
          chiffres.casEcrits += 1;
          await remise.remettre(changees, nommer(c));
        }
      };
      const tous = casDe(route);
      const refuses = tous.filter((c) => refuseAvantLaCible(entrees, c.compte, route));
      const admis = tous.filter((c) => !refuses.includes(c));
      chiffres.parRoute[route] = { cibles: new Set(tous.map((c) => c.cible.nom)).size, cas: tous.length, refuses: refuses.length, admis: admis.length };
      // Comptes refusés à l'entrée : en parallèle, une empreinte pour le lot.
      const resultats = await enParallele(refuses.map((c) => async () => ({ c, res: await appel(c) })), 8);
      const changeesLot = remise.changees(await remise.empreinte());
      if (changeesLot.length) {
        // Le lot a écrit : remise, puis chaque cas rejoué seul pour le nommer.
        chiffres.lotsRejoues.push(`${route} (${changeesLot.join(', ')})`);
        await remise.remettre(changeesLot, `lot des comptes refusés à l’entrée sur ${route}`);
        for (const c of refuses) await unAUn(c);
      } else {
        chiffres.casParalleles += resultats.length;
        lignes.push(...resultats.map(({ c, res }) => ligne(c, res, 'inchangé')));
      }
      // Comptes admis à l'entrée : un à un.
      for (const c of admis) {
        await unAUn(c);
        const cle = `${c.compte}${SEPARATEUR}${route}`;
        if (!couples.has(cle)) couples.set(cle, { dans: [], hors: [] });
        (c.cible.relations?.[c.compte] ? couples.get(cle).dans : couples.get(cle).hors).push(c.cible.nom);
      }
    };

    before(async () => {
      // Rôle PostgreSQL : échec clair, avant toute base créée, si la remise en état est impossible (avenant, section 1).
      try {
        await exigerRoleReplication(TEST_DATABASE_URL);
      } catch (erreur) {
        refusRole = erreur;
        return;
      }
      entrees = lireEntrees();
      await base.creer();
      appli = await chargerApplication(base);
      const connexion = await appeler(appli.adresse, 'POST', '/api/auth/secours', { corps: { token: JETON_SECOURS } });
      assert.equal(connexion.status, 200, JSON.stringify(connexion.body));
      const secours = await appli.prisma.user.findUniqueOrThrow({ where: { email: EMAIL_SECOURS }, select: { id: true, role: true } });
      assert.equal(secours.role, 'SUPERADMIN');
      const crees = await creerComptes({
        prisma: appli.prisma, signer: appli.signer, signerAutreSecret: (id) => appli.jwt.sign({ id }, 'autre-secret-que-celui-de-l-application'),
        secours: { id: secours.id, jeton: connexion.body.token },
        supprimerCompte: async (id) => {
          const res = await appeler(appli.adresse, 'DELETE', `/api/users/${id}`, { jeton: connexion.body.token });
          assert.equal(res.status, 200, JSON.stringify(res.body));
        },
        rattacherCompte: async (id, responsableHierarchiqueId) => {
          const res = await appeler(appli.adresse, 'PATCH', `/api/users/${id}/responsable-hierarchique`, { jeton: connexion.body.token, corps: { responsableHierarchiqueId } });
          assert.equal(res.status, 200, JSON.stringify(res.body));
        },
      });
      comptes = crees.comptes;
      await construireJeuDeDonnees({ prisma: appli.prisma, api, comptes, donnees: crees.donnees });

      // Cibles propres à ce fichier (avenant, section 3 : « construites par l'API dans sa base, sans changer
      // donnees.mjs ») : une version brouillon des mentions légales, à côté de la version publiée du jeu de données.
      const versions = await api(SA, 'GET', '/api/mentions-legales');
      const publiees = versions.filter((v) => v.actif === true && v.publieeLe);
      assert.equal(publiees.length, 1, `une version publiée et active : ${JSON.stringify(versions).slice(0, 300)}`);
      const [publiee] = publiees;
      const brouillon = await api(SA, 'POST', '/api/mentions-legales', { mentions: 'TEST mentions matrice v2', cgv: 'TEST CGV matrice v2', penalites: 'TEST pénalités matrice v2' }, 201);
      const [, cheminMentions] = ROUTE_MENTIONS.split(' ');
      ciblesMentions.push({ nom: 'version-publiee', chemin: cheminMentions.replace(':version', String(publiee.version)) });
      ciblesMentions.push({ nom: 'version-brouillon', chemin: cheminMentions.replace(':version', String(brouillon.version)) });

      // État des cibles dont le corps dépend (relu en base, pour que le corps suive le fait et non une table écrite à la main).
      for (const cible of FAMILLES.intervention.cibles) if (cible.nom !== INEXISTANT) cible.etat = (await appli.prisma.intervention.findUniqueOrThrow({ where: { id: cible.ids.id }, select: { statut: true } })).statut;
      for (const cible of FAMILLES.chantier.cibles) if (cible.nom !== INEXISTANT) cible.etat = (await appli.prisma.chantier.findUniqueOrThrow({ where: { id: cible.ids.id }, select: { statut: true } })).statut;
      donnees = {
        comptes, hier: jourSociete(-1), aujourdhui: jourSociete(0),
        clientActif: cibleDe('client', 'client-actif').ids.id,
        categorie: cibleDe('categorie', 'categorie').ids.id,
        fournisseur: cibleDe('fournisseur', 'fournisseur').ids.id,
        ficheLibre: cibleDe('fiche-intervenant', 'fiche-libre').ids.id,
      };

      // Instantané et outil de remise en état, une fois le jeu de données construit (getParametres a créé ses lignes).
      const tables = await tablesDeLaBase(appli.prisma);
      remise = await creerRemiseEnEtat({
        url: base.url, nomBase: base.nom, tables, connexionApplication: appli.serveur.prisma,
        factureEmiseId: cibleDe('facture', 'facture-emise').ids.id,
      });
      etatInitial = await remise.etatComplet();
      assert.deepEqual(etatInitial.declencheursInactifs, [], 'déclencheurs désactivés avant la matrice');
    });

    after(async () => {
      await remise?.fermer();
      await appli?.fermer();
      await base.supprimer();
    });

    // Avenant, section 1 : « les fichiers de D1a-5 l'exigent et échouent avec un message clair si le rôle de
    // TEST_DATABASE_URL ne peut pas poser ce paramètre — jamais de SKIP » ; le contrôle éprouve la capacité elle-même.
    test('rôle PostgreSQL : le rôle de TEST_DATABASE_URL peut poser session_replication_role, sans quoi la base ne peut pas être remise en état entre deux cas (échec clair, jamais un SKIP)', () => {
      if (refusRole) throw refusRole;
    });

    // Consigne de D1a-5a, points 3 et 4 ; avenant, section 2 : « les 20 routes (b) » et « les 16 routes (a) marquées
    // validation-avant-droit (13 avec une famille de cibles, POST /api/achats, /api/heures et /api/devis sans famille) ».
    testPrepare('périmètre : les 20 routes (b) et les 16 routes marquées validation-avant-droit, chacune avec ses cibles réelles et, pour une route marquée, un corps valide pour chaque cible', () => {
      assert.equal(ROUTES_B.length, 20, `routes (b) : ${ROUTES_B.join(', ')}`);
      assert.equal(ROUTES_MARQUEES.length, 16, `routes marquées : ${ROUTES_MARQUEES.join(', ')}`);
      assert.deepEqual(ROUTES_MARQUEES.filter((route) => !ROUTES_SESSION[route].famille).sort(), Object.keys(CIBLE_DU_CORPS).sort(), 'routes marquées sans famille : la cible est portée par le corps');
      assert.deepEqual(Object.keys(CORPS).sort(), [...ROUTES_MARQUEES].sort(), 'un corps valide pour chaque route marquée, et pour elles seules');
      assert.deepEqual(ROUTES_B.filter((route) => !ROUTES_SESSION[route].famille), [ROUTE_MENTIONS], 'seule route (b) sans famille : la publication des mentions légales');
      for (const route of [...ROUTES_B, ...ROUTES_MARQUEES]) {
        const cibles = ciblesDe(route);
        assert.ok(cibles.length >= 1, `${route} : aucune cible réelle`);
        for (const cible of cibles) assert.ok(cible.chemin && !cible.chemin.includes(':') && (route === ROUTE_MENTIONS || cible.ids?.id), `${route} : cible ${cible.nom} sans chemin ou sans identifiant`);
        for (const compte of COMPTES_JOUES) refuseAvantLaCible(entrees, compte, route);
      }
    });

    // Consigne de D1a-5a, point 3 ; cadrage §2.4 (b) : « le refus sur un dossier réel, dans ou hors du périmètre,
    // relève de D1a-5 » ; avenant, ligne D1a-5a : « dont l'émission d'une facture (brouillon émis ; refus sur une facture
    // émise et sur un avoir) ».
    testPrepare('routes (b) : chaque compte sur chaque cible réelle de la famille, à corps vide ; comptes refusés à l’entrée en parallèle, comptes admis un à un, base remise en état après chaque écriture', async () => {
      for (const route of ROUTES_B) await jouerRoute(route);
    });

    // Consigne de D1a-5a, point 4 ; avenant, section 3 : les comptes refusés avant la cible « sont rejoués sur chaque
    // cible réelle, en parallèle » ; #428, N2 : « D1a-5 doit donc jouer, sur des cibles réelles dans et hors du
    // périmètre, […] les 16 routes marquées validation-avant-droit ».
    testPrepare('routes marquées validation-avant-droit : chaque compte, avec un corps valide, sur chaque cible réelle de la famille ou portée par le corps, base remise en état après chaque écriture', async () => {
      for (const route of ROUTES_MARQUEES) await jouerRoute(route);
    });

    // #428, N2 : « Retirer le périmètre SAV de POST /api/interventions/:id/suites (route b) : le mutant survit » ;
    // « Retirer le contrôle du titulaire de PATCH /api/chantiers/:id/statut : le mutant survit ». État décidé :
    // MODELE-DROITS-COMPTES.md (le conducteur clôture ses chantiers ; la suite d'une intervention se crée dans le
    // périmètre SAV du demandeur, suites.ts).
    testPrepare('N2 de #428 : la suite d’une intervention se crée dans le périmètre SAV seulement, et seul le titulaire, parmi les conducteurs, clôture son chantier', () => {
      const reponse = (compte, route, cible, contexte = CONTEXTE_DEFAUT) => {
        const debut = [compte, route, cible, contexte].join(SEPARATEUR) + SEPARATEUR;
        const trouvees = lignes.filter((l) => l.startsWith(debut));
        assert.equal(trouvees.length, 1, `ligne attendue : ${debut}`);
        return trouvees[0].slice(debut.length);
      };
      const SUITES = 'POST /api/interventions/:id/suites';
      const STATUT = 'PATCH /api/chantiers/:id/statut';
      // Dans le périmètre : la suite est créée ; hors du périmètre : 404, rien n'est écrit.
      assert.match(reponse('CT', SUITES, 'intervention-chantier-ct'), /^201 écrit \(/);
      assert.match(reponse('CT', SUITES, 'intervention-creee-ct'), /^201 écrit \(/);
      assert.equal(reponse('CT', SUITES, 'intervention-autre'), '404 « Intervention introuvable. » inchangé');
      assert.equal(reponse('CT', SUITES, 'curative-sans-chantier-branche'), '404 « Intervention introuvable. » inchangé');
      assert.match(reponse('RESP', SUITES, 'intervention-affectee-tech'), /^201 écrit \(/);
      assert.equal(reponse('RESP', SUITES, 'intervention-autre'), '404 « Intervention introuvable. » inchangé');
      assert.equal(reponse('RESP-SANS-BRANCHE', SUITES, 'intervention-affectee-tech'), '404 « Intervention introuvable. » inchangé');
      // Le titulaire clôture son chantier en cours ; un autre conducteur, même N+1 du titulaire, reçoit 404.
      assert.match(reponse('CT', STATUT, 'chantier-ct', `${CONTEXTE_DEFAUT}, corps statut=TERMINE`), /^200 écrit \(/);
      assert.equal(reponse('CT', STATUT, 'chantier-autre', `${CONTEXTE_DEFAUT}, corps statut=TERMINE`), '404 « Chantier introuvable » inchangé');
      assert.equal(reponse('CT-N1', STATUT, 'chantier-ct', `${CONTEXTE_DEFAUT}, corps statut=TERMINE`), '404 « Chantier introuvable » inchangé');
      assert.equal(reponse('CT', STATUT, 'chantier-com', `${CONTEXTE_DEFAUT}, corps statut=TERMINE`), '404 « Chantier introuvable » inchangé');
    });

    // Avenant, section 3 : « pour chaque couple (compte, route) admis à l'entrée, au moins un cas dans et un cas hors du
    // périmètre, quand le jeu de données le permet ; sinon, le corps de la sous-PR le dit ». La table des relations de
    // donnees.mjs sert d'indicateur ; la référence enregistre la réponse réelle.
    testPrepare('minimum de l’avenant : chaque couple (compte, route) admis à l’entrée est joué sur toutes les cibles réelles ; les couples sans cible dans ou hors du périmètre sont relevés', (t) => {
      const sansDans = []; const sansHors = [];
      for (const [cle, { dans, hors }] of [...couples].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const [compte] = cle.split(SEPARATEUR);
        if (ADMINISTRATION.includes(compte)) continue;
        if (!dans.length) sansDans.push(cle);
        if (!hors.length) sansHors.push(cle);
      }
      t.diagnostic(`couples admis à l’entrée : ${couples.size} (hors administration : ${[...couples.keys()].filter((c) => !ADMINISTRATION.includes(c.split(SEPARATEUR)[0])).length})`);
      t.diagnostic(`sans cible dans le périmètre (${sansDans.length}) : ${sansDans.join(' ; ')}`);
      t.diagnostic(`sans cible hors du périmètre (${sansHors.length}) : ${sansHors.join(' ; ')}`);
      // Chaque couple admis a été joué sur toutes les cibles réelles de sa route : le minimum est donc atteint partout
      // où le jeu de données le permet ; les couples relevés ci-dessus sont ceux où il ne le permet pas.
      for (const [cle, { dans, hors }] of couples) {
        const route = cle.split(SEPARATEUR)[1];
        assert.equal(new Set([...dans, ...hors]).size, chiffres.parRoute[route].cibles, `${cle} : cibles jouées`);
      }
    });

    // Cadrage §2.1 et consigne de D1a-5a : la matrice obtenue est la référence, au caractère près (diff imprimé, et
    // résumé par compte et route au-delà de 60 lignes) ; jamais une valeur de montant.
    testPrepare('la matrice obtenue est la référence matrice-droits/ecritures-actions.txt, chaque cas y a une ligne, et aucune ligne ne porte de montant', (t) => {
      const routesVues = new Set(lignes.map((l) => l.split(SEPARATEUR)[1]));
      assert.deepEqual([...ROUTES_B, ...ROUTES_MARQUEES].filter((route) => !routesVues.has(route)), [], 'routes sans ligne');
      const cles = lignes.map((l) => l.split(SEPARATEUR).slice(0, 4).join(SEPARATEUR));
      assert.equal(new Set(cles).size, cles.length, 'chaque cas n’a qu’une ligne');
      assert.equal(lignes.length, Object.values(chiffres.parRoute).reduce((s, r) => s + r.cas, 0), 'une ligne par cas joué');
      const avecMontant = lignes.filter((l) => /€|\b\d+[.,]\d{2}\b/.test(l));
      assert.deepEqual(avecMontant, [], 'lignes qui portent un montant');
      t.diagnostic(`routes : ${ROUTES_B.length} (b) et ${ROUTES_MARQUEES.length} marquées ; comptes : ${COMPTES_JOUES.length}`);
      t.diagnostic(`cas : ${lignes.length} (en parallèle ${chiffres.casParalleles}, un à un ${chiffres.casUnAUn}) ; écrits : ${chiffres.casEcrits} ; remises : ${remise.remises} ; lots rejoués : ${chiffres.lotsRejoues.length ? chiffres.lotsRejoues.join(' ; ') : 'aucun'}`);
      for (const [route, r] of Object.entries(chiffres.parRoute)) t.diagnostic(`${route} : ${r.cibles} cible(s), ${r.cas} cas (${r.refuses} refusés à l’entrée, ${r.admis} admis)`);
      comparerAvecReference(lignes, REFERENCE, 'ecritures-actions.txt');
    });

    // Avenant, section 1, et consigne de D1a-5a, point 2 : « après N remises (au moins 50) de cas qui écrivent dans des
    // tables variées (dont une facture émise, un réglage, une clé révoquée, un compte désactivé, une écriture en ajout
    // seul de journal), l'état complet est identique à la référence : empreinte des tables, séquences, déclencheurs et
    // leur état d'activation (pg_trigger.tgenabled), schéma public ; et une facture réémise après la remise reprend le
    // même numéro. » Joué après la comparaison à la référence : il écrit.
    testPrepare('outil de remise en état : 60 écritures variées remises une à une, état complet identique à celui d’avant la matrice, même numéro de facture à chaque émission, refus d’une autre base', async () => {
      const id = (famille, nom) => cibleDe(famille, nom).ids.id;
      const hier = jourSociete(-1); const aujourdhui = jourSociete(0);
      let cleUtilisee = null;
      const compteTva = (await appli.prisma.compteComptable.findFirstOrThrow({ where: { code: '445710' }, select: { id: true } })).id;
      const ecritures = [
        { nom: 'chantier renommé par son titulaire', compte: 'CT', m: 'PATCH', c: `/api/chantiers/${id('chantier', 'chantier-ct')}`, corps: { nom: 'TEST Chantier renommé par la preuve' }, tables: ['Chantier'] },
        { nom: 'facture brouillon émise (numéro, écritures, journal des factures en ajout seul)', compte: SA, m: 'POST', c: `/api/factures/${id('facture', 'facture-brouillon')}/emettre`, corps: {}, tables: ['Facture', 'JournalFacture', 'SequenceFacture'], numero: true },
        { nom: 'réglage changé (journal d’administration en ajout seul)', compte: SA, m: 'PUT', c: '/api/parametres', corps: { margeCommercialeActive: false }, tables: ['JournalAdministration', 'Parametres'] },
        { nom: 'clé révoquée', compte: SA, m: 'POST', c: `/api/admin/api-keys/${id('cle', 'cle-active')}/revoke`, corps: {}, tables: ['ApiAccessKey', 'JournalAdministration'] },
        { nom: 'compte désactivé', compte: SA, m: 'PATCH', c: `/api/users/${id('compte', 'compte-commercial')}/actif`, corps: { actif: false }, tables: ['JournalAdministration', 'User'] },
        { nom: 'événement du planning supprimé', compte: 'AD', m: 'DELETE', c: `/api/planning/events/${id('affectation', 'affectation-evenement')}`, corps: {}, tables: ['PlanningEvent'] },
        { nom: 'compte rendu ajouté par le technicien affecté (journal des saisies)', compte: 'TECH', m: 'POST', c: `/api/interventions/${id('intervention', 'intervention-affectee-tech')}/rapports`, corps: () => ({ contenu: 'TEST Compte rendu de la preuve.', cleEnvoi: randomUUID() }), tables: ['InterventionRapport', 'JournalSaisieChantier'] },
        { nom: 'règlement enregistré', compte: SA, m: 'POST', c: '/api/reglements', corps: { clientId: id('client', 'client-actif'), dateReglement: aujourdhui, montant: 10, moyen: 'VIREMENT', affectations: [{ factureId: id('facture', 'facture-emise'), montant: 10 }] }, tables: ['Reglement'] },
        { nom: 'client créé', compte: 'AD', m: 'POST', c: '/api/clients', corps: { raisonSociale: 'TEST Client de la preuve' }, tables: ['Client'] },
        { nom: 'achat saisi par le titulaire', compte: 'CT', m: 'POST', c: '/api/achats', corps: { chantierId: id('chantier', 'chantier-ct'), categorieId: id('categorie', 'categorie'), fournisseurId: id('fournisseur', 'fournisseur'), date: hier, description: 'TEST Achat de la preuve', montantHT: 12.34 }, tables: ['AchatReel', 'JournalSaisieChantier'] },
        // Séquence : une règle TVA créée écrit une transition, dont l'identité avance TransitionRegleComptable_id_seq.
        { nom: 'règle TVA créée (séquence d’identité des transitions, journal des règles en ajout seul)', compte: SA, m: 'PUT', c: '/api/comptabilite/tva/10', corps: { compteId: compteTva, motif: 'TEST preuve de la remise des séquences' }, tables: ['JournalRegleComptable', 'RegleTvaComptable', 'TransitionRegleComptable', 'séquence TransitionRegleComptable_id_seq'] },
        // Clé créée puis utilisée par /api/v1 : sa dernière utilisation, écrite sans attente, est attendue avant l'empreinte.
        { nom: 'clé créée puis utilisée par la porte /api/v1 (dernière utilisation attendue)', compte: SA, m: 'POST', c: '/api/admin/api-keys', corps: { nom: 'TEST Clé de la preuve', scopes: ['clients:read'] }, tables: ['ApiAccessKey', 'JournalAdministration'], cle: true },
      ];
      const numeros = [];
      const avant = remise.remises;
      for (let tour = 1; tour <= 5; tour += 1) {
        for (const e of ecritures) {
          const contexte = `preuve, tour ${tour} : ${e.nom}`;
          const res = await appeler(appli.adresse, e.m, e.c, { jeton: comptes[e.compte].jeton, corps: typeof e.corps === 'function' ? e.corps() : e.corps });
          assert.ok(res.status >= 200 && res.status < 300, `${contexte} : ${res.status} ${JSON.stringify(res.body)?.slice(0, 300)}`);
          if (e.numero) numeros.push(res.body?.numero ?? res.body?.facture?.numero);
          if (e.cle) {
            const secret = res.body?.apiKey; const cleId = res.body?.key?.id;
            assert.ok(secret && cleId, `${contexte} : clé ou secret absent de la réponse`);
            const envoi = Date.now();
            const lecture = await appeler(appli.adresse, 'GET', '/api/v1/clients', { autorisation: `Bearer ${secret}` });
            assert.equal(lecture.status, 200, `${contexte} : lecture par la clé ${JSON.stringify(lecture.body)?.slice(0, 200)}`);
            await remise.attendreDernierUsage(cleId, envoi, contexte);
            cleUtilisee = cleId;
          }
          const changees = remise.changees(await remise.empreinte());
          for (const table of e.tables) assert.ok(changees.includes(table), `${contexte} : ${table} absente des tables changées (${changees.join(', ')})`);
          await remise.remettre(changees, contexte);
        }
      }
      assert.ok(cleUtilisee, 'la clé de la preuve a été utilisée');
      assert.ok(remise.remises - avant >= 50, `remises de la preuve : ${remise.remises - avant}`);
      // La numérotation légale, tenue en table, est remise : la facture réémise reprend le même numéro.
      assert.equal(numeros.length, 5);
      assert.ok(numeros[0], `numéro de la facture émise : ${numeros[0]}`);
      assert.deepEqual(numeros, Array(5).fill(numeros[0]), 'la facture réémise après chaque remise reprend le même numéro');
      // État complet identique à celui d'avant la matrice : tables et séquences, déclencheurs et leur état, schéma.
      const etatFinal = await remise.etatComplet();
      assert.deepEqual(etatFinal.empreinte, remise.reference, 'empreinte des tables et des séquences');
      assert.deepEqual(etatFinal.empreinte, etatInitial.empreinte, 'empreinte d’avant la matrice');
      assert.equal(etatFinal.nombreDeclencheurs, etatInitial.nombreDeclencheurs, 'nombre de déclencheurs');
      assert.equal(etatFinal.declencheurs, etatInitial.declencheurs, 'déclencheurs et leur état d’activation');
      assert.deepEqual(etatFinal.declencheursInactifs, [], 'aucun déclencheur désactivé');
      assert.equal(etatFinal.schema, etatInitial.schema, 'schéma public');
      assert.ok(etatInitial.nombreDeclencheurs > 100 && etatInitial.lignesSchema > 500, `relevé du catalogue : ${etatInitial.nombreDeclencheurs} déclencheurs, ${etatInitial.lignesSchema} lignes de schéma`);
      // Sonde d'immutabilité, une dernière fois (elle tourne aussi après chaque remise).
      await remise.sondeImmutabilite('fin de la preuve');
      // Refus de l'outil sur une autre base que la base jetable du fichier, avant toute écriture.
      await assert.rejects(creerRemiseEnEtat({ url: TEST_DATABASE_URL, nomBase: base.nom, tables: ['Facture'], connexionApplication: appli.serveur.prisma, factureEmiseId: 'x' }), /Remise en état refusée : la connexion vise la base « [^»]+ », et non la base jetable/);
      await assert.rejects(creerRemiseEnEtat({ url: base.url, nomBase: 'iris_test', tables: ['Facture'], connexionApplication: appli.serveur.prisma, factureEmiseId: 'x' }), /n’est pas le nom d’une base jetable de la matrice/);
    });
  });
}
