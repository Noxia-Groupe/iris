import express from 'express';
import cors from 'cors';
import { Prisma } from '@prisma/client';
import path from 'path';
import type http from 'http';
import fs from 'fs';
// Chargé ici pour son seul effet, à la même place qu'avant le découpage : ses dépendances lisent
// l'environnement à leur chargement (NODE_DEBUG), avant server/.env. Ses emplois sont dans src/.
import 'jsonwebtoken';
// Chargé ici pour son seul effet, à la même place qu'avant le découpage : ses emplois sont
// dans src/ (règle du README sur les imports de bibliothèques).
import 'crypto';
// Chargé ici pour son seul effet, à la même place qu'avant le découpage : ses emplois sont
// dans src/domaines/factures/pdf.ts (règle du README sur les imports de bibliothèques).
import 'pdfkit';
// Chargement de server/.env au même moment qu'avant le découpage : après les bibliothèques,
// dont certaines lisent l'environnement à leur chargement (DEBUG, NO_COLOR…).
import './src/env';
import { prisma, transactionVerifiee } from './src/db';
import { ROLE_SUPERADMIN } from './src/droits/roles';
import { resolveJwtSecret } from './src/http/auth';
import { enregistrerRoutesReferentiels } from './src/domaines/referentiels/routes';
import { app } from './src/app';
import { apiKeyHash } from './src/http/cles-api';
import {
  fuseauHoraireEntrepriseValide, jourCivilEntreprise, aujourdHuiEntreprise, anneeEntreprise, dateEmissionEstFuture,
} from './src/commun/dates';
import { decimalToNumber, arrondiCommercialLigneHt, centimesTtcLigne } from './src/commun/montants';
import {
  upsertSingleton, validerBareme, parseBareme, getReglesRemuneration, serialiseBareme,
} from './src/domaines/parametres/metier';
import { companySettingsPayload } from './src/domaines/administration/metier';
import {
  journaliserAdministration, purgerJournalAdministration,
} from './src/commun/journal-administration';
import { enregistrerRoutesParametres, enregistrerRoutesRemunerationEtReglages } from './src/domaines/parametres/routes';
import { enregistrerRoutesClesIntegration, enregistrerRoutesSociete, enregistrerRoutesModules } from './src/domaines/administration/routes';
import { enregistrerRoutesJournalAdministration } from './src/domaines/administration/journal';
import { normalizeEmail } from './src/domaines/authentification/sso';
import { secretIdentique } from './src/domaines/authentification/secours';
import { enregistrerRoutesAuthentification } from './src/domaines/authentification/routes';
import { libelleCompteJournal, delierFicheSiPlusTechnicien, journaliserDroitsCompte, enregistrerRoutesComptes } from './src/domaines/utilisateurs/comptes';
import { enregistrerRoutesEquipes, enregistrerRoutesPrimeMensuelle } from './src/domaines/utilisateurs/equipes';
import { clientPayload, contactPayload, sitePayload } from './src/domaines/clients/metier';
import { enregistrerRoutesClients } from './src/domaines/clients/routes';
import { catalogueFamily, cataloguePayload, catalogueExtraPayload } from './src/domaines/catalogue/metier';
import { enregistrerRoutesCatalogue } from './src/domaines/catalogue/routes';
import { devisPayload } from './src/domaines/devis/metier';
import { enregistrerRoutesDevis } from './src/domaines/devis/routes';
import { voitRentabilite } from './src/domaines/chantiers/droits';
export { peutVoirFinance } from './src/domaines/chantiers/droits';
import { computeChantierMetrics } from './src/domaines/chantiers/suivi';
import { enregistrerRoutesChantiers, enregistrerRoutesAnalyseChantier } from './src/domaines/chantiers/routes';
import { enregistrerRoutesSaisiesTravaux } from './src/domaines/chantiers/saisies';
import { dateDemandeCurative } from './src/domaines/interventions/metier';
import { enregistrerRoutesContrats } from './src/domaines/contrats/routes';
import { enregistrerRoutesInterventions } from './src/domaines/interventions/routes';
import { enregistrerRoutesPlanning } from './src/domaines/planning/routes';
export { libelleComptableValide } from './src/domaines/comptabilite/metier';
import { enregistrerRoutesFactures, enregistrerRoutesEmissionFactures } from './src/domaines/factures/routes';
import { enregistrerRoutesReglements } from './src/domaines/reglements/routes';
import { enregistrerRoutesComptabilite } from './src/domaines/comptabilite/routes';
import { weekBoundsFrom, periodBounds } from './src/domaines/statistiques/metier';
import { enregistrerRoutesStatistiques } from './src/domaines/statistiques/routes';
import { commissionBaremeProgressif } from './src/domaines/commissions/metier';
import { enregistrerRoutesCommissions } from './src/domaines/commissions/routes';

const port = process.env.PORT || 3001;

// Ne pas révéler la techno serveur (en-tête `X-Powered-By: Express`).
app.disable('x-powered-by');

app.use(cors());
// Le seul import du plan peut atteindre 5 000 comptes ; les autres routes gardent la limite par défaut.
app.use('/api/comptabilite/importer', express.json({ limit: '5mb' }));
app.use(express.json());
app.use((error: Error & { type?: string }, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error.type === 'entity.too.large') return void res.status(413).json({ error: req.path === '/api/comptabilite/importer' ? 'Fichier trop volumineux (limite : 5 Mo).' : 'Requête trop volumineuse.' });
  next(error);
});

// --- Factures : lecture, création, prêtes à facturer (src/domaines/factures/routes.ts) ---
enregistrerRoutesFactures(app);

// --- Comptabilité : plan comptable, import, règles et TVA (src/domaines/comptabilite/routes.ts) ---
enregistrerRoutesComptabilite(app);

// --- Factures : export comptable, mentions légales, émission, annulation, avoirs (src/domaines/factures/routes.ts) ---
enregistrerRoutesEmissionFactures(app);

// --- Règlements clients (src/domaines/reglements/routes.ts) ---
enregistrerRoutesReglements(app);

// --- Contrats de maintenance (src/domaines/contrats/routes.ts) ---
enregistrerRoutesContrats(app);

// --- Interventions SAV, coûts, comptes rendus et placement au planning (src/domaines/interventions/routes.ts) ---
enregistrerRoutesInterventions(app);

// --- Santé, configuration publique, SSO, accès de secours, compte connecté (src/domaines/authentification/routes.ts) ---
enregistrerRoutesAuthentification(app);

// --- Chantiers (src/domaines/chantiers/routes.ts) ---
enregistrerRoutesChantiers(app);

// --- Comptes utilisateurs et hiérarchie (src/domaines/utilisateurs/comptes.ts) ---
enregistrerRoutesComptes(app);

// --- Commerciaux, conducteurs et fiches intervenant (src/domaines/utilisateurs/equipes.ts) ---
enregistrerRoutesEquipes(app);

// --- Planning : chantiers, événements, types, partage et lien public (src/domaines/planning/routes.ts) ---
enregistrerRoutesPlanning(app);

// --- Catégories et fournisseurs (src/domaines/referentiels/routes.ts) ---
enregistrerRoutesReferentiels(app);

// --- Achats, heures et encaissé des chantiers (src/domaines/chantiers/saisies.ts) ---
enregistrerRoutesSaisiesTravaux(app);

// --- Prime mensuelle des commerciaux (src/domaines/utilisateurs/equipes.ts) ---
enregistrerRoutesPrimeMensuelle(app);

// --- Paramètres et registre des entreprises (src/domaines/parametres/routes.ts) ---
enregistrerRoutesParametres(app);

// --- Clés d'intégration et société pour l'API (src/domaines/administration/routes.ts) ---
enregistrerRoutesClesIntegration(app);

// --- Clients, contacts, sites et parc d'équipements (src/domaines/clients/routes.ts) ---
enregistrerRoutesClients(app);

// --- Catalogue (src/domaines/catalogue/routes.ts) ---
enregistrerRoutesCatalogue(app);

// --- Devis (src/domaines/devis/routes.ts) ---
enregistrerRoutesDevis(app);

// --- Société (src/domaines/administration/routes.ts) ---
enregistrerRoutesSociete(app);

// --- Rémunération commerciale et paramètres métier (src/domaines/parametres/routes.ts) ---
enregistrerRoutesRemunerationEtReglages(app);

// --- Modules (src/domaines/administration/routes.ts) ---
enregistrerRoutesModules(app);

// --- Journal d'administration (src/domaines/administration/journal.ts) ---
enregistrerRoutesJournalAdministration(app);

// --- Statistiques des tableaux de bord (src/domaines/statistiques/routes.ts) ---
enregistrerRoutesStatistiques(app);

// --- Résultat commercial et commissions (src/domaines/commissions/routes.ts) ---
enregistrerRoutesCommissions(app);

// --- Analyse d'un chantier (src/domaines/chantiers/routes.ts) ---
enregistrerRoutesAnalyseChantier(app);

// --- Comptes super administrateurs de départ ---
// La liste vient EXCLUSIVEMENT de SUPERADMIN_EMAILS (emails séparés par des virgules).
// Aucun email n'est écrit ici : une instance livrée à un client ne doit pas créer d'office
// un compte d'administration appartenant à l'éditeur.
// Traitement IDEMPOTENT et non destructif : un compte déjà présent est simplement promu
// SUPERADMIN (son nom, son mot de passe et ses rattachements sont conservés) ; un compte
// absent est créé. Aucun compte n'est jamais rétrogradé ici — retirer le rôle superadmin
// se fait depuis Administration > Utilisateurs, par un superadmin.
// « prenom.nom@societe.fr » -> « Prenom Nom » : nom d'affichage par défaut d'un compte
// créé automatiquement, que son titulaire ou un superadmin pourra corriger ensuite.
function nameFromEmail(email: string): string {
  const local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local.replace(/\b\w/g, (c) => c.toUpperCase()) || email;
}

const ensureSuperAdmins = async () => {
  const emails = (process.env.SUPERADMIN_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);

  for (const email of emails) {
    const existing = await prisma.user.findUnique({ where: { email } });
    // Promotions et créations du démarrage : journalisées comme les autres changements de droits,
    // sans auteur (AUTEUR_JOURNAL_DEMARRAGE), et réservées au super administrateur.
    if (existing) {
      if (existing.role !== ROLE_SUPERADMIN) {
        await transactionVerifiee(async (tx) => {
          const fiches = await tx.$queryRaw<Array<{ id: string; nom: string }>>(Prisma.sql`SELECT "id", "nom" FROM "Intervenant" WHERE "userId" = ${existing.id} FOR UPDATE`);
          const apres = await tx.user.update({ where: { id: existing.id }, data: { role: ROLE_SUPERADMIN } });
          await journaliserDroitsCompte(tx, { } as express.Request, 'TYPE_COMPTE', existing, apres, ['role']);
          await delierFicheSiPlusTechnicien(tx, null, existing, ROLE_SUPERADMIN, fiches);
        });
        console.log(`Compte promu super administrateur : ${email}`);
      }
      continue;
    }
    await transactionVerifiee(async (tx) => {
      const cree = await tx.user.create({
        data: {
          email,
          name: nameFromEmail(email),
          role: ROLE_SUPERADMIN,
        },
      });
      await journaliserAdministration(tx, null, {
        domaine: 'DROITS', type: 'COMPTE', action: 'CREATION', cibleId: cree.id, cibleLibelle: libelleCompteJournal(cree), concerneSuperAdmin: true,
        apres: { role: cree.role, estCommercial: cree.estCommercial, accesFinance: cree.accesFinance, permissions: cree.permissions, actif: cree.actif },
      });
    });
    console.log(`Compte super administrateur créé : ${email} (connexion Microsoft Entra ID)`);
  }

  const total = await prisma.user.count({ where: { role: ROLE_SUPERADMIN } });
  if (total === 0) {
    console.warn('[AVERTISSEMENT] Aucun compte super administrateur : les modules de l\'application ne peuvent pas être pilotés.');
  }
};

// Initialisation BDD (Seeding)
const initDb = async () => {
  // Garantit l'existence de la ligne de paramètres (singleton) dès le démarrage. Le serveur
  // écoute déjà : une première requête peut la créer au même instant, et une erreur levée ici
  // (rappel de listen) arrêterait le processus avant ensureSuperAdmins.
  await upsertSingleton(() => prisma.parametres.upsert({ where: { id: 'singleton' }, update: {}, create: { id: 'singleton' } }));
  // Une purge qui échoue ne doit pas arrêter le démarrage avant ensureSuperAdmins : elle sera
  // rejouée à la prochaine consultation du journal.
  try {
    await purgerJournalAdministration();
  } catch (error) {
    console.error('[JOURNAL] Purge des entrées échues impossible au démarrage :', error);
  }
};

// Délais de connexion du serveur HTTP. Node ferme par défaut une connexion keep-alive inactive
// au bout de 5 s : un client qui la réutilise à cet instant précis (navigateur, Playwright,
// répartiteur de charge) reçoit « socket hang up » ou `read ECONNRESET`, comme une fois dans la
// CI E2E de #123 puis de #129. Le serveur garde donc ses connexions inactives 65 s, plus
// longtemps que les clients et répartiteurs courants (60 s) : un client qui ne ferme pas de
// lui-même ses connexions inactives (l'agent de Playwright) ne risque plus cette course
// qu'après plus d'une minute d'inactivité sur une même connexion. headersTimeout, qui ne
// s'applique qu'à une requête commencée, reste au-delà de keepAliveTimeout, comme le
// recommandaient les anciennes versions de Node (Node 20 exige seulement qu'il ne dépasse pas
// requestTimeout, 300 s par défaut).
const DELAI_CONNEXION_INACTIVE_MS = 65_000;
function reglerDelaisConnexion(serveur: http.Server): http.Server {
  serveur.keepAliveTimeout = DELAI_CONNEXION_INACTIVE_MS;
  serveur.headersTimeout = DELAI_CONNEXION_INACTIVE_MS + 1_000;
  return serveur;
}

// Le serveur n'écoute que lorsque ce fichier est LANCÉ (node dist/index.js). Quand il est
// simplement importé — c'est le cas des tests d'intégration, qui montent l'application
// dans le processus de test — on expose `app` sans ouvrir de port : deux suites de tests
// peuvent alors tourner en parallèle sans se disputer le 3001, et aucun test n'oublie de
// fermer un serveur derrière lui.
if (require.main === module) {
  reglerDelaisConnexion(app.listen(port, async () => {
    await initDb();
    await ensureSuperAdmins();
    console.log(`Server running on port ${port}`);
  }));
}

// Surface exportée pour les tests. `app` sert aux tests d'intégration HTTP ; les fonctions
// pures (validation des saisies, barème de commission, empreinte de clé API) sont testées
// directement, sans base de données ni requête.
export {
  app,
  prisma,
  resolveJwtSecret,
  reglerDelaisConnexion,
  initDb,
  ensureSuperAdmins,
  clientPayload,
  contactPayload,
  sitePayload,
  companySettingsPayload,
  fuseauHoraireEntrepriseValide,
  dateDemandeCurative,
  jourCivilEntreprise,
  aujourdHuiEntreprise,
  anneeEntreprise,
  dateEmissionEstFuture,
  periodBounds,
  weekBoundsFrom,
  cataloguePayload,
  catalogueExtraPayload,
  catalogueFamily,
  apiKeyHash,
  secretIdentique,
  commissionBaremeProgressif,
  computeChantierMetrics,
  voitRentabilite,
  decimalToNumber,
  parseBareme,
  serialiseBareme,
  validerBareme,
  arrondiCommercialLigneHt,
  centimesTtcLigne,
  devisPayload,
  getReglesRemuneration,
};
