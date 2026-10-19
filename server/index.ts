import express from 'express';
import cors from 'cors';
// Chargé ici pour son seul effet, à la même place qu'avant le découpage : ses emplois sont
// dans src/ (règle du README sur les imports de bibliothèques).
import '@prisma/client';
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
import { prisma } from './src/db';
import { resolveJwtSecret } from './src/http/auth';
import { enregistrerRoutesReferentiels } from './src/domaines/referentiels/routes';
import { app } from './src/app';
import { apiKeyHash } from './src/http/cles-api';
import {
  fuseauHoraireEntrepriseValide, jourCivilEntreprise, aujourdHuiEntreprise, anneeEntreprise, dateEmissionEstFuture,
} from './src/commun/dates';
import { decimalToNumber, arrondiCommercialLigneHt, centimesTtcLigne } from './src/commun/montants';
import { validerBareme, parseBareme, getReglesRemuneration, serialiseBareme } from './src/domaines/parametres/metier';
import { companySettingsPayload } from './src/domaines/administration/metier';
import { enregistrerRoutesParametres, enregistrerRoutesRemunerationEtReglages } from './src/domaines/parametres/routes';
import { enregistrerRoutesClesIntegration, enregistrerRoutesSociete, enregistrerRoutesModules } from './src/domaines/administration/routes';
import { enregistrerRoutesJournalAdministration } from './src/domaines/administration/journal';
import { secretIdentique } from './src/domaines/authentification/secours';
import { enregistrerRoutesAuthentification } from './src/domaines/authentification/routes';
import { enregistrerRoutesComptes } from './src/domaines/utilisateurs/comptes';
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
import { initDb, ensureSuperAdmins, reglerDelaisConnexion } from './src/demarrage';

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

// Le serveur n'écoute que lorsque ce fichier est LANCÉ (node dist/index.js). Quand il est
// simplement importé — c'est le cas des tests d'intégration, qui montent l'application
// dans le processus de test — on expose `app` sans ouvrir de port : deux suites de tests
// peuvent alors tourner en parallèle sans se disputer le 3001, et aucun test n'oublie de
// fermer un serveur derrière lui.
if (require.main === module) {
  reglerDelaisConnexion(app.listen(port, async () => {
    // Une initialisation impossible (base injoignable, par exemple) est signalée explicitement et
    // arrête le processus, au lieu d'un rejet non géré sans contexte (#231). Les comptes de départ,
    // eux, ne l'arrêtent jamais : ensureSuperAdmins signale ses échecs sans rejeter.
    try {
      await initDb();
      await ensureSuperAdmins();
      console.log(`Server running on port ${port}`);
    } catch (error) {
      console.error('[DÉMARRAGE] Initialisation impossible :', error);
      process.exit(1);
    }
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
