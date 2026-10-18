import express from 'express';
import cors from 'cors';
import { Prisma } from '@prisma/client';
import path from 'path';
import type http from 'http';
import fs from 'fs';
// Chargé ici pour son seul effet, à la même place qu'avant le découpage : ses dépendances lisent
// l'environnement à leur chargement (NODE_DEBUG), avant server/.env. Ses emplois sont dans src/.
import 'jsonwebtoken';
import crypto from 'crypto';
// Chargé ici pour son seul effet, à la même place qu'avant le découpage : ses emplois sont
// dans src/domaines/factures/pdf.ts (règle du README sur les imports de bibliothèques).
import 'pdfkit';
// Chargement de server/.env au même moment qu'avant le découpage : après les bibliothèques,
// dont certaines lisent l'environnement à leur chargement (DEBUG, NO_COLOR…).
import './src/env';
import { prisma, transactionVerifiee } from './src/db';
import {
  ROLE_SUPERADMIN, ROLE_RESPONSABLE, isAdminRole, COMMERCIAL_OR_FILTER,
} from './src/droits/roles';
import { type AuthRequest, JWT_SECRET, requireAuth, resolveJwtSecret } from './src/http/auth';
import { requireAdmin, requireTravauxRead } from './src/http/gardes';
import { enregistrerRoutesReferentiels } from './src/domaines/referentiels/routes';
import { app } from './src/app';
import { apiKeyHash } from './src/http/cles-api';
import { AFFAIRE_NON_ANNULEE, perimetreChantiers } from './src/droits/perimetres';
import {
  FUSEAU_HORAIRE_PAR_DEFAUT, fuseauHoraireEntrepriseValide, jourCivilEntreprise, aujourdHuiEntreprise, anneeEntreprise,
  dateEmissionEstFuture, jourCivilDeReference, ajouterJoursCivils, debutJourCivilEntreprise,
} from './src/commun/dates';
import { decimalToNumber, arrondiCommercialLigneHt, centimesTtcLigne } from './src/commun/montants';
import {
  type Parametres, upsertSingleton, getParametres, validerBareme, remunerationNeutre, parseBareme, getReglesRemuneration,
  serialiseBareme,
} from './src/domaines/parametres/metier';
import { companySettingsPayload, getCompanySettings } from './src/domaines/administration/metier';
import { nombreDecimalNonNegatif } from './src/commun/validation';
import {
  journaliserAdministration, purgerJournalAdministration,
} from './src/commun/journal-administration';
import { enregistrerRoutesParametres, enregistrerRoutesRemunerationEtReglages } from './src/domaines/parametres/routes';
import { enregistrerRoutesClesIntegration, enregistrerRoutesSociete, enregistrerRoutesModules } from './src/domaines/administration/routes';
import { enregistrerRoutesJournalAdministration } from './src/domaines/administration/journal';
import {
  voitMontantsChantier, voitCoutMainOeuvre,
} from './src/droits/visibilite';
import { normalizeEmail } from './src/domaines/authentification/sso';
import { secretIdentique } from './src/domaines/authentification/secours';
import { enregistrerRoutesAuthentification } from './src/domaines/authentification/routes';
import { libelleCompteJournal, delierFicheSiPlusTechnicien, journaliserDroitsCompte, enregistrerRoutesComptes } from './src/domaines/utilisateurs/comptes';
import { enregistrerRoutesEquipes, enregistrerRoutesPrimeMensuelle } from './src/domaines/utilisateurs/equipes';
import { clientPayload, contactPayload, sitePayload } from './src/domaines/clients/metier';
import { enregistrerRoutesClients } from './src/domaines/clients/routes';
import { catalogueFamily, cataloguePayload, catalogueExtraPayload } from './src/domaines/catalogue/metier';
import { enregistrerRoutesCatalogue } from './src/domaines/catalogue/routes';
import { TYPES_CHANTIER } from './src/domaines/chantiers/metier';
import { devisPayload } from './src/domaines/devis/metier';
import { enregistrerRoutesDevis } from './src/domaines/devis/routes';
import { voitRentabilite } from './src/domaines/chantiers/droits';
export { peutVoirFinance } from './src/domaines/chantiers/droits';
import { jourCivilDeDebut, computeChantierMetrics } from './src/domaines/chantiers/suivi';
import { enregistrerRoutesChantiers, enregistrerRoutesAnalyseChantier } from './src/domaines/chantiers/routes';
import { enregistrerRoutesSaisiesTravaux } from './src/domaines/chantiers/saisies';
import { motifContratValide } from './src/domaines/contrats/metier';
import { dateDemandeCurative } from './src/domaines/interventions/metier';
import { enregistrerRoutesContrats } from './src/domaines/contrats/routes';
import { enregistrerRoutesInterventions } from './src/domaines/interventions/routes';
import { enregistrerRoutesPlanning } from './src/domaines/planning/routes';
import { CLES_COMPTABLES, NATURES_ATTENDUES, verrouillerParametrageComptable } from './src/domaines/comptabilite/metier';
import { enregistrerRoutesFactures, enregistrerRoutesEmissionFactures } from './src/domaines/factures/routes';
import { enregistrerRoutesReglements } from './src/domaines/reglements/routes';

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

app.get('/api/comptabilite', requireAuth, requireAdmin, async (_req, res) => {
  try { const [comptes, regles, reglesTva] = await Promise.all([prisma.compteComptable.findMany({ orderBy: { code: 'asc' } }), prisma.regleComptable.findMany({ include: { compte: true }, orderBy: { cle: 'asc' } }), prisma.regleTvaComptable.findMany({ include: { compte: true }, orderBy: { taux: 'asc' } })]); res.json(decimalToNumber({ comptes, regles, reglesTva })); }
  catch { res.status(500).json({ error: 'Lecture du paramétrage comptable impossible.' }); }
});
export function libelleComptableValide(libelle: string): boolean { return !/[\p{Cc}\p{Cf}]/u.test(libelle); }
// Même règle Unicode, longueur en points de code et trim que les contrats.
function motifCompteComptableValide(value: unknown): string | null { return motifContratValide(value); }
app.post('/api/comptabilite/comptes', requireAuth, requireAdmin, async (req, res) => {
  try { const code = String(req.body?.code || '').trim(), libelleBrut = String(req.body?.libelle || ''), libelle = libelleBrut.trim(), nature = String(req.body?.nature || '');
    if (!/^\d{3,12}$/.test(code) || !libelle || !libelleComptableValide(libelleBrut) || !['ACTIF', 'PASSIF', 'PRODUIT', 'CHARGE', 'TVA'].includes(nature)) return res.status(400).json({ error: 'Compte comptable invalide.' });
    const compte = await transactionVerifiee(async tx => {
      await verrouillerParametrageComptable(tx);
      return tx.compteComptable.create({ data: { code, libelle, nature } });
    }); res.status(201).json(compte);
  } catch (error) { if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'Ce code de compte existe déjà, éventuellement inactif. Consultez le plan et réactivez-le avec un motif si nécessaire.' }); res.status(500).json({ error: 'Création du compte impossible.' }); }
});
class CompteComptableUtilise extends Error {}
class CompteComptableSansChangement extends Error {}
class CompteComptablePerime extends Error {}
class CompteComptableDejaDansCetEtat extends Error {}
class CompteComptableInactif extends Error {}
class NatureCompteInvalide extends Error {
  constructor(readonly messageMetier: string) { super(messageMetier); }
}
async function verrouillerCompteComptable(tx: Prisma.TransactionClient, compteId: string) {
  await verrouillerParametrageComptable(tx);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CompteComptable" WHERE "id" = ${compteId} FOR UPDATE`);
}
type ModificationCompte = { libelle: string; nature: string; expectedUpdatedAt: string };
async function verifierModificationCompte(tx: Prisma.TransactionClient, avant: Prisma.CompteComptableGetPayload<object>, modification: ModificationCompte) {
  if (avant.updatedAt.toISOString() !== modification.expectedUpdatedAt) throw new CompteComptablePerime();
  const { libelle, nature } = modification;
  if (avant.libelle === libelle && avant.nature === nature) throw new CompteComptableSansChangement();
  if (avant.nature !== nature) {
    const [regles, reglesTva] = await Promise.all([
      tx.regleComptable.findMany({ where: { compteId: avant.id }, select: { cle: true } }),
      tx.regleTvaComptable.count({ where: { compteId: avant.id } }),
    ]);
    if (regles.some(r => NATURES_ATTENDUES[r.cle] && !NATURES_ATTENDUES[r.cle].includes(nature)) || (reglesTva && nature !== 'TVA')) throw new NatureCompteInvalide('Nature incompatible avec une règle client, vente ou TVA : remappez la règle auparavant.');
  }
}
async function appliquerModificationCompte(tx: Prisma.TransactionClient, avant: Prisma.CompteComptableGetPayload<object>, modification: ModificationCompte, motif: string, auteur: { id: string; name: string }) {
  await verifierModificationCompte(tx, avant, modification);
  const apres = await tx.compteComptable.update({ where: { id: avant.id }, data: { libelle: modification.libelle, nature: modification.nature } });
  await tx.journalCompteComptable.create({ data: {
    compteId: avant.id, auteurId: auteur.id, auteurNom: auteur.name,
    action: 'MODIFICATION', avantLibelle: avant.libelle, apresLibelle: apres.libelle,
    avantNature: avant.nature, apresNature: apres.nature, motif,
  } });
  return apres;
}
app.patch('/api/comptabilite/comptes/:id', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(k => !['libelle', 'nature', 'motif', 'expectedUpdatedAt'].includes(k)) ||
      typeof body.expectedUpdatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.expectedUpdatedAt) || !Number.isFinite(Date.parse(body.expectedUpdatedAt)) ||
      (!Object.hasOwn(body, 'libelle') && !Object.hasOwn(body, 'nature')) ||
      (Object.hasOwn(body, 'libelle') && (typeof body.libelle !== 'string' || !body.libelle.trim() || !libelleComptableValide(body.libelle))) ||
      (Object.hasOwn(body, 'nature') && (typeof body.nature !== 'string' || !['ACTIF', 'PASSIF', 'PRODUIT', 'CHARGE', 'TVA'].includes(body.nature))) ||
      !motifCompteComptableValide(body.motif)) {
    return res.status(400).json({ error: 'Libellé ou nature et motif de 3 à 500 caractères requis ; code non modifiable.' });
  }
  try {
    const compte = await transactionVerifiee(async tx => {
      await verrouillerCompteComptable(tx, String(req.params.id));
      const avant = await tx.compteComptable.findUnique({ where: { id: String(req.params.id) } });
      if (!avant) return null;
      return appliquerModificationCompte(tx, avant, {
        libelle: Object.hasOwn(body, 'libelle') ? body.libelle.trim() : avant.libelle,
        nature: Object.hasOwn(body, 'nature') ? body.nature : avant.nature,
        expectedUpdatedAt: body.expectedUpdatedAt,
      }, body.motif.trim(), req.user!);
    });
    if (!compte) return res.status(404).json({ error: 'Compte comptable introuvable.' });
    res.json(compte);
  } catch (error) {
    if (error instanceof CompteComptableSansChangement) return res.status(400).json({ error: 'Aucune modification du compte.' });
    if (error instanceof CompteComptablePerime) return res.status(409).json({ error: 'Compte modifié depuis son ouverture : actualisez le plan avant de réessayer.' });
    if (error instanceof NatureCompteInvalide) return res.status(409).json({ error: error.messageMetier });
    if ((error as { code?: string })?.code === 'P2034') return res.status(409).json({ error: 'Modification concurrente du compte : réessayez.' });
    res.status(500).json({ error: 'Modification du compte impossible.' });
  }
});
app.get('/api/comptabilite/comptes/:id/journal', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!await prisma.compteComptable.findUnique({ where: { id }, select: { id: true } })) return res.status(404).json({ error: 'Compte comptable introuvable.' });
    res.json(await prisma.journalCompteComptable.findMany({ where: { compteId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
  } catch { res.status(500).json({ error: 'Lecture du journal du compte impossible.' }); }
});
app.patch('/api/comptabilite/comptes/:id/activation', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).length !== 2 || !Object.hasOwn(req.body, 'actif') || !Object.hasOwn(req.body, 'motif') ||
      typeof req.body.actif !== 'boolean' || !motifCompteComptableValide(req.body.motif)) {
    return res.status(400).json({ error: 'Statut booléen et motif de 3 à 500 caractères requis.' });
  }
  const motif = req.body.motif.trim();
  try {
    const compte = await transactionVerifiee(async tx => {
      await verrouillerCompteComptable(tx, String(req.params.id));
      const existant = await tx.compteComptable.findUnique({ where: { id: String(req.params.id) } });
      if (!existant) return null;
      if (existant.actif === req.body.actif) throw new CompteComptableDejaDansCetEtat();
      if (!req.body.actif) {
        const [regles, reglesTva] = await Promise.all([
          tx.regleComptable.count({ where: { compteId: existant.id } }),
          tx.regleTvaComptable.count({ where: { compteId: existant.id } }),
        ]);
        if (regles || reglesTva) throw new CompteComptableUtilise();
      }
      const modifie = await tx.compteComptable.update({ where: { id: existant.id }, data: { actif: req.body.actif } });
      await tx.journalCompteComptable.create({ data: {
        compteId: existant.id, auteurId: req.user!.id, auteurNom: req.user!.name,
        action: req.body.actif ? 'REACTIVATION' : 'DESACTIVATION', avant: existant.actif,
        apres: modifie.actif, motif,
      } });
      return modifie;
    });
    if (!compte) return res.status(404).json({ error: 'Compte comptable introuvable.' });
    res.json(compte);
  } catch (error) {
    if (error instanceof CompteComptableDejaDansCetEtat) return res.status(409).json({ error: 'Ce compte est déjà dans cet état.' });
    if (error instanceof CompteComptableUtilise) return res.status(409).json({ error: 'Compte utilisé par une règle comptable ou TVA : remappez la règle avant de désactiver.' });
    if ((error as { code?: string })?.code === 'P2034') return res.status(409).json({ error: 'Modification concurrente du compte : réessayez.' });
    res.status(500).json({ error: 'Modification du statut du compte impossible.' });
  }
});
class ConflitImportComptable extends Error {
  constructor(readonly erreurs: { ligne: number; erreur: string }[]) { super('Import refusé : comptes existants différents.'); }
}
// Jeton signé, lié à l'acteur, au fichier et à la photographie complète du périmètre.
// Aucun brouillon en base : l'aperçu ne produit aucune écriture.
async function preparerApercuImport(tx: Prisma.TransactionClient, comptes: { code: string; libelle: string; nature: string }[]) {
  const existants = await tx.compteComptable.findMany({ where: { code: { in: comptes.map(c => c.code) } } });
  const parCode = new Map(existants.map(c => [c.code, c]));
  // Précharger les rattachements une fois pour le lot ; aucun aller-retour par ligne.
  const [regles, tva] = await Promise.all([
    tx.regleComptable.findMany({ orderBy: { cle: 'asc' } }),
    tx.regleTvaComptable.findMany({ orderBy: { taux: 'asc' } }),
  ]);
  const reglesParCompte = new Map<string, string[]>();
  for (const regle of regles) {
    if (!regle.compteId) continue;
    const rattachements = reglesParCompte.get(regle.compteId) ?? [];
    rattachements.push(regle.cle);
    reglesParCompte.set(regle.compteId, rattachements);
  }
  const comptesTva = new Set(tva.map(regle => regle.compteId));
  const actions = [] as { code: string; ligne: number; action: 'creer' | 'modifier' | 'ignorer'; avant?: { libelle: string; nature: string }; apres: { libelle: string; nature: string } }[];
  const erreurs: { ligne: number; erreur: string }[] = [];
  for (const [index, compte] of comptes.entries()) {
    const avant = parCode.get(compte.code);
    const apres = { libelle: compte.libelle, nature: compte.nature };
    if (avant && !avant.actif) { erreurs.push({ ligne: index + 1, erreur: `Le compte ${compte.code} est inactif : réactivez-le explicitement.` }); continue; }
    const action = !avant ? 'creer' : avant.libelle === compte.libelle && avant.nature === compte.nature ? 'ignorer' : 'modifier';
    if (avant && action === 'modifier' && avant.nature !== compte.nature &&
      ((reglesParCompte.get(avant.id) ?? []).some(cle => NATURES_ATTENDUES[cle] && !NATURES_ATTENDUES[cle].includes(compte.nature)) ||
        (comptesTva.has(avant.id) && compte.nature !== 'TVA'))) {
      erreurs.push({ ligne: index + 1, erreur: 'Nature incompatible avec une règle client, vente ou TVA : remappez la règle auparavant.' });
      continue;
    }
    actions.push({ code: compte.code, ligne: index + 1, action, ...(avant ? { avant: { libelle: avant.libelle, nature: avant.nature } } : {}), apres });
  }
  if (erreurs.length) throw new ConflitImportComptable(erreurs);
  // Les versions et l'activité capturent aussi les comptes inchangés ; les règles
  // sont incluses pour refuser un aperçu devenu caduc après un remappage.
  const empreinte = crypto.createHash('sha256').update(JSON.stringify({ comptes, existants: existants.sort((a, b) => a.code.localeCompare(b.code)), regles, tva })).digest('hex');
  return { actions, empreinte, parCode };
}
function signerApercu(empreinte: string, auteurId: string, delivre: number) {
  const contenu = Buffer.from(JSON.stringify({ empreinte, auteurId, delivre })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update('iris:apercu-import-comptable:v1:').update(contenu).digest('base64url');
  return `${contenu}.${signature}`;
}
function apercuValide(jeton: unknown, empreinte: string, auteurId: string) {
  if (typeof jeton !== 'string' || jeton.length > 2048) return false;
  const [contenu, signature, surplus] = jeton.split('.');
  if (!contenu || !signature || surplus !== undefined) return false;
  const attendu = crypto.createHmac('sha256', JWT_SECRET).update('iris:apercu-import-comptable:v1:').update(contenu).digest();
  let fourni: Buffer;
  try { fourni = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (fourni.length !== attendu.length || !crypto.timingSafeEqual(fourni, attendu)) return false;
  try {
    const donnees = JSON.parse(Buffer.from(contenu, 'base64url').toString());
    return donnees.empreinte === empreinte && donnees.auteurId === auteurId &&
      Number.isSafeInteger(donnees.delivre) && donnees.delivre <= Date.now() && Date.now() - donnees.delivre <= 10 * 60_000;
  } catch { return false; }
}
app.post('/api/comptabilite/importer', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const lignes = Array.isArray(req.body?.lignes) ? req.body.lignes : [];
  if (!lignes.length || lignes.length > 5000) return res.status(400).json({ error: 'Le plan doit contenir entre 1 et 5 000 lignes.' });
  const vus = new Set<string>(); const erreurs: { ligne: number; erreur: string }[] = [];
  const comptes: { code: string; libelle: string; nature: string }[] = lignes.map((ligne: any, index: number) => {
    const code = String(ligne?.code || '').trim(), libelleBrut = String(ligne?.libelle || ''), libelle = libelleBrut.trim(), nature = String(ligne?.nature || '');
    if (!/^\d{3,12}$/.test(code) || !libelle || !libelleComptableValide(libelleBrut) || !['ACTIF', 'PASSIF', 'PRODUIT', 'CHARGE', 'TVA'].includes(nature)) erreurs.push({ ligne: index + 1, erreur: 'Code, libellé ou nature invalide.' });
    if (vus.has(code)) erreurs.push({ ligne: index + 1, erreur: 'Code dupliqué dans le fichier.' }); vus.add(code); return { code, libelle, nature };
  });
  if (erreurs.length) return res.status(400).json({ error: 'Import refusé : corrigez les lignes signalées.', erreurs });
  const mode = req.body?.mode;
  if (mode !== undefined && mode !== 'mettre_a_jour') return res.status(400).json({ error: 'Mode d’import inconnu.' });
  if (mode === 'mettre_a_jour') {
    if (!['apercu', 'confirmer'].includes(req.body?.phase) ||
      (req.body.phase === 'confirmer' && !motifCompteComptableValide(req.body.motif)))
      return res.status(400).json({ error: 'Phase ou motif de 3 à 500 caractères invalide.' });
    try {
      const resultat = await transactionVerifiee(async tx => {
        await verrouillerParametrageComptable(tx);
        const { actions, empreinte, parCode } = await preparerApercuImport(tx, comptes);
        if (req.body.phase === 'apercu') return { actions, apercuId: signerApercu(empreinte, req.user!.id, Date.now()) };
        if (!apercuValide(req.body.apercuId, empreinte, req.user!.id)) throw new CompteComptablePerime();
        for (const action of actions) {
          const cible = comptes[action.ligne - 1];
          if (action.action === 'creer') await tx.compteComptable.create({ data: cible });
          if (action.action === 'modifier') {
            const avant = parCode.get(action.code)!;
            await appliquerModificationCompte(tx, avant, { libelle: cible.libelle, nature: cible.nature, expectedUpdatedAt: avant.updatedAt.toISOString() }, req.body.motif.trim(), req.user!);
          }
        }
        return { crees: actions.filter(a => a.action === 'creer').length, modifies: actions.filter(a => a.action === 'modifier').length, ignores: actions.filter(a => a.action === 'ignorer').length };
      }, { maxWait: 10_000, timeout: 60_000 });
      return res.status(200).json(resultat);
    } catch (error) {
      if (error instanceof ConflitImportComptable) return res.status(409).json({ error: error.message, erreurs: error.erreurs });
      if (error instanceof CompteComptablePerime) return res.status(409).json({ error: 'Aperçu périmé : recommencez l’aperçu.' });
      if ((error as { code?: string })?.code === 'P2034') return res.status(409).json({ error: 'Import concurrent : recommencez l’aperçu.' });
      return res.status(500).json({ error: 'Mise à jour du plan comptable impossible.' });
    }
  }
  if (req.body?.phase !== undefined || req.body?.motif !== undefined || req.body?.apercuId !== undefined) return res.status(400).json({ error: 'Mode d’import requis.' });
  try {
    const resultat = await transactionVerifiee(async tx => {
      // Sérialise les imports et toutes les émissions/remappages comptables.
      await verrouillerParametrageComptable(tx);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(814081)::text AS verrou`;
      const resultat = await tx.compteComptable.createMany({ data: comptes, skipDuplicates: true });
      const existants = await tx.compteComptable.findMany({ where: { code: { in: comptes.map(compte => compte.code) } }, select: { code: true, libelle: true, nature: true, actif: true } });
      const parCode = new Map(existants.map(compte => [compte.code, compte]));
      const divergences = comptes.flatMap((compte, index) => {
        const existant = parCode.get(compte.code);
        return existant && !existant.actif
          ? [{ ligne: index + 1, erreur: `Le compte ${compte.code} existe mais est inactif : réactivez-le explicitement avec un motif avant de relancer l’import.` }]
          : existant && (existant.libelle !== compte.libelle || existant.nature !== compte.nature)
          ? [{ ligne: index + 1, erreur: `Le compte ${compte.code} existe avec un libellé ou une nature différente.` }] : [];
      });
      if (divergences.length) throw new ConflitImportComptable(divergences);
      return resultat;
    }, { maxWait: 10_000, timeout: 60_000 });
    res.status(201).json({ importes: resultat.count, ignores: comptes.length - resultat.count });
  } catch (error) {
    if (error instanceof ConflitImportComptable) return res.status(409).json({ error: error.message, erreurs: error.erreurs });
    res.status(500).json({ error: 'Import du plan comptable impossible.' });
  }
});
app.get('/api/comptabilite/regles/journal', requireAuth, requireAdmin, async (_req, res) => {
  try { res.json(await prisma.journalRegleComptable.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })); }
  catch { res.status(500).json({ error: 'Lecture du journal des règles impossible.' }); }
});
class RegleComptableSansChangement extends Error {}
class RegleComptableMotifManquant extends Error {}
class RegleComptableVersionManquante extends Error {}
app.put('/api/comptabilite/regles/:cle', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try { const cle = String(req.params.cle || ''); if (!CLES_COMPTABLES.includes(cle)) return res.status(400).json({ error: 'Règle comptable inconnue.' });
    const compteId = req.body?.compteId ? String(req.body.compteId) : null; const journal = req.body?.journal == null ? null : String(req.body.journal).trim() || null;
    if (cle === 'JOURNAL_VENTES' ? !journal : !compteId) return res.status(400).json({ error: 'Paramétrage de règle incomplet.' });
    if (journal && !/^[A-Z0-9]{1,8}$/.test(journal)) return res.status(400).json({ error: 'Le code journal doit compter au plus 8 caractères alphanumériques majuscules.' });
    const regle = await transactionVerifiee(async tx => {
      await verrouillerParametrageComptable(tx);
      if (compteId) {
        await verrouillerCompteComptable(tx, compteId);
        const compte = await tx.compteComptable.findFirst({ where: { id: compteId, actif: true } });
        if (!compte) throw new CompteComptableInactif();
        if (NATURES_ATTENDUES[cle] && !NATURES_ATTENDUES[cle].includes(compte.nature)) throw new NatureCompteInvalide(`Cette règle attend un compte de nature ${NATURES_ATTENDUES[cle].join(' ou ')}.`);
      }
      const courante = await tx.regleComptable.findUnique({ where: { cle } });
      if (courante) {
        // expectedValeur porte le code du journal pour JOURNAL_VENTES, l'id du compte sinon.
        // La TVA utilise séparément expectedCompteId : ne pas confondre les contrats.
        if (typeof req.body?.expectedValeur !== 'string' || typeof req.body?.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(req.body.expectedUpdatedAt))) throw new RegleComptableVersionManquante();
        if ((courante.journal ?? courante.compteId) !== req.body.expectedValeur || courante.updatedAt.toISOString() !== req.body.expectedUpdatedAt) throw new RegleTvaPerimee();
        if ((courante.journal ?? courante.compteId) === (journal ?? compteId)) throw new RegleComptableSansChangement();
        const motif = motifCompteComptableValide(req.body?.motif);
        if (!motif) throw new RegleComptableMotifManquant();
        const apres = await tx.regleComptable.update({ where: { cle }, data: { compteId, journal }, include: { compte: true } });
        await tx.journalRegleComptable.create({ data: { type: 'REGLE', cible: cle, action: 'REMAPPAGE', avant: (courante.journal ?? courante.compteId)!, apres: journal ?? compteId, motif, auteurId: req.user!.id, auteurNom: req.user!.name } });
        return apres;
      }
      const motif = motifCompteComptableValide(req.body?.motif);
      if (!motif) throw new RegleComptableMotifManquant();
      const creee = await tx.regleComptable.create({ data: { cle, compteId, journal }, include: { compte: true } });
      await tx.journalRegleComptable.create({ data: { type: 'REGLE', cible: cle, action: 'CREATION', apres: journal ?? compteId, motif, auteurId: req.user!.id, auteurNom: req.user!.name } });
      return creee;
    });
    res.json(regle);
  } catch (error) {
    if (error instanceof RegleComptableVersionManquante) return res.status(400).json({ error: 'Version de la règle requise.' });
    if (error instanceof RegleTvaPerimee) return res.status(409).json({ error: 'La règle a changé depuis son affichage. Actualisez avant de remapper.' });
    if (error instanceof RegleComptableMotifManquant) return res.status(400).json({ error: 'Motif de 3 à 500 caractères sans caractère de contrôle requis.' });
    if (error instanceof RegleComptableSansChangement) return res.status(409).json({ error: 'Règle inchangée.' });
    if (error instanceof CompteComptableInactif) return res.status(404).json({ error: 'Compte comptable actif introuvable.' });
    if (error instanceof NatureCompteInvalide) return res.status(400).json({ error: error.messageMetier });
    if ((error as { code?: string })?.code === 'P2034') return res.status(409).json({ error: 'Modification concurrente de la règle : réessayez.' });
    res.status(500).json({ error: 'Mise à jour du paramétrage impossible.' });
  }
});

app.delete('/api/comptabilite/regles/:cle', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const cle = String(req.params.cle);
  const body = req.body;
  if (!CLES_COMPTABLES.includes(cle) || !body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'expectedUpdatedAt,expectedValeur,motif' ||
      typeof body.expectedValeur !== 'string' || !body.expectedValeur ||
      typeof body.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(body.expectedUpdatedAt)) ||
      !motifCompteComptableValide(body.motif)) return res.status(400).json({ error: 'Version et motif de 3 à 500 caractères requis.' });
  try {
    const retire = await transactionVerifiee(async tx => {
      await verrouillerParametrageComptable(tx);
      const courante = await tx.regleComptable.findUnique({ where: { cle } });
      if (!courante) return false;
      if ((courante.journal ?? courante.compteId) !== body.expectedValeur || courante.updatedAt.toISOString() !== body.expectedUpdatedAt) throw new RegleTvaPerimee();
      await tx.regleComptable.delete({ where: { cle } });
      await tx.journalRegleComptable.create({ data: { type: 'REGLE', cible: cle, action: 'RETRAIT', avant: body.expectedValeur, motif: body.motif.trim(), auteurId: req.user!.id, auteurNom: req.user!.name } });
      return true;
    });
    if (!retire) return res.status(404).json({ error: 'Règle comptable introuvable.' });
    res.status(204).end();
  } catch (error) {
    if (error instanceof RegleTvaPerimee || (error as { code?: string })?.code === 'P2034') return res.status(409).json({ error: 'La règle a changé depuis son affichage.' });
    res.status(500).json({ error: 'Retrait de la règle impossible.' });
  }
});

// Retrait explicite du mapping courant, jamais du compte ni des écritures figées.
class RegleTvaPerimee extends Error {}
app.delete('/api/comptabilite/tva/:taux', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const taux = nombreDecimalNonNegatif(req.params.taux, 3, true);
  const { confirmation, expectedCompteId, expectedUpdatedAt, motif } = req.body || {};
  if (taux === null || taux > 100 || Object.keys(req.body || {}).sort().join(',') !== 'confirmation,expectedCompteId,expectedUpdatedAt,motif' ||
      !motifCompteComptableValide(motif) ||
      typeof confirmation !== 'string' || confirmation.replace(',', '.') !== String(taux) ||
      typeof expectedCompteId !== 'string' || !expectedCompteId ||
      typeof expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
    return res.status(400).json({ error: 'Confirmez le taux et la version de la règle TVA à retirer.' });
  }
  try {
    const supprimee = await transactionVerifiee(async tx => {
      await verrouillerParametrageComptable(tx);
      const courante = await tx.regleTvaComptable.findUnique({ where: { taux: new Prisma.Decimal(taux.toFixed(2)) } });
      if (!courante) return false;
      if (courante.compteId !== expectedCompteId || courante.updatedAt.toISOString() !== expectedUpdatedAt) throw new RegleTvaPerimee();
      await tx.regleTvaComptable.delete({ where: { id: courante.id } });
      await tx.journalRegleComptable.create({ data: { type: 'TVA', cible: String(taux), action: 'RETRAIT', avant: courante.compteId, motif: motif.trim(), auteurId: req.user!.id, auteurNom: req.user!.name } });
      return true;
    });
    if (!supprimee) return res.status(404).json({ error: 'Règle TVA introuvable.' });
    res.status(204).end();
  } catch (error) {
    if (error instanceof RegleTvaPerimee) return res.status(409).json({ error: 'La règle TVA a changé depuis son affichage. Actualisez avant de retirer.' });
    res.status(500).json({ error: 'Retrait de la règle TVA impossible.' });
  }
});

app.put('/api/comptabilite/tva/:taux', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try { const taux = nombreDecimalNonNegatif(req.params.taux, 3, true); const compteId = String(req.body?.compteId || '');
    if (taux === null || taux > 100) return res.status(400).json({ error: 'Taux de TVA invalide.' });
    const tauxDecimal = new Prisma.Decimal(taux.toFixed(2));
    const regle = await transactionVerifiee(async tx => {
      await verrouillerParametrageComptable(tx);
      await verrouillerCompteComptable(tx, compteId);
      const compte = await tx.compteComptable.findFirst({ where: { id: compteId, actif: true } });
      if (!compte) throw new CompteComptableInactif();
      if (compte.nature !== 'TVA') throw new NatureCompteInvalide('Une règle TVA attend un compte de nature TVA.');
      const courante = await tx.regleTvaComptable.findUnique({ where: { taux: tauxDecimal } });
      if (courante) {
        if (typeof req.body?.expectedCompteId !== 'string' || typeof req.body?.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(req.body.expectedUpdatedAt))) throw new RegleComptableVersionManquante();
        if (courante.compteId !== req.body.expectedCompteId || courante.updatedAt.toISOString() !== req.body.expectedUpdatedAt) throw new RegleTvaPerimee();
        if (courante.compteId === compteId) throw new RegleComptableSansChangement();
        const motif = motifCompteComptableValide(req.body?.motif);
        if (!motif) throw new RegleComptableMotifManquant();
        const apres = await tx.regleTvaComptable.update({ where: { id: courante.id }, data: { compteId }, include: { compte: true } });
        await tx.journalRegleComptable.create({ data: { type: 'TVA', cible: String(taux), action: 'REMAPPAGE', avant: courante.compteId, apres: compteId, motif, auteurId: req.user!.id, auteurNom: req.user!.name } });
        return apres;
      }
      const motif = motifCompteComptableValide(req.body?.motif);
      if (!motif) throw new RegleComptableMotifManquant();
      const creee = await tx.regleTvaComptable.create({ data: { taux: tauxDecimal, compteId }, include: { compte: true } });
      await tx.journalRegleComptable.create({ data: { type: 'TVA', cible: String(taux), action: 'CREATION', apres: compteId, motif, auteurId: req.user!.id, auteurNom: req.user!.name } });
      return creee;
    });
    res.json(regle);
  } catch (error) {
    if (error instanceof RegleComptableVersionManquante) return res.status(400).json({ error: 'Version de la règle TVA requise.' });
    if (error instanceof RegleTvaPerimee) return res.status(409).json({ error: 'La règle TVA a changé depuis son affichage. Actualisez avant de remapper.' });
    if (error instanceof RegleComptableMotifManquant) return res.status(400).json({ error: 'Motif de 3 à 500 caractères sans caractère de contrôle requis.' });
    if (error instanceof RegleComptableSansChangement) return res.status(409).json({ error: 'Règle inchangée.' });
    if (error instanceof CompteComptableInactif) return res.status(404).json({ error: 'Compte TVA actif introuvable.' });
    if (error instanceof NatureCompteInvalide) return res.status(400).json({ error: error.messageMetier });
    if ((error as { code?: string })?.code === 'P2034') return res.status(409).json({ error: 'Modification concurrente de la règle TVA : réessayez.' });

    res.status(500).json({ error: 'Mise à jour de la règle TVA impossible.' });
  }
});

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

// Statistiques globales (agrégées côté serveur, périmètre selon le rôle)
// Statistiques du tableau de bord : compteurs de statut (instantanés, jamais filtrés par
// période — comme les listes "chantiers en cours/archivés" du dashboard qu'ils
// accompagnent) + résultats chiffrés du mois civil ou de l'année civile EN COURS
// (pas de navigation vers une période passée, contrairement aux autres pages stats).
// Le périmètre (tous / mes chantiers / mes ventes) suit le rôle comme partout ailleurs.
app.get('/api/stats/global', requireAuth, async (req, res) => {
  try {
    const user = (req as AuthRequest).user!;
    const isAdmin = isAdminRole(user.role);
    const isCommercial = user.role === 'COMMERCIAL';
    const params = await getParametres();
    const period = (['month', 'quarter', 'year'] as const).includes(req.query.period as any)
      ? (req.query.period as 'month' | 'quarter' | 'year')
      : 'month';
    const societe = await getCompanySettings();
    const { start, endExclusive } = periodBounds(period, req.query.ref, societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);

    const where = perimetreChantiers(req);
    const chantiers = decimalToNumber(await prisma.chantier.findMany({
      where,
      include: { achats: { where: { archivedAt: null } }, pointages: { where: { archivedAt: null } } },
    }));

    let nbEnCours = 0;
    let nbTermines = 0;
    let nbTerminesNonEncaisses = 0;
    let achatsTotal = 0;
    let heuresTotal = 0;

    for (const c of chantiers) {
      if (c.statut === 'EN_COURS') nbEnCours++;
      else if (c.statut === 'TERMINE') {
        nbTermines++;
        if (!c.encaisse) nbTerminesNonEncaisses++;
      }
      for (const a of c.achats) {
        const d = new Date(a.date);
        if (d >= start && d < endExclusive) achatsTotal += a.montantHT;
      }
      for (const p of c.pointages) {
        const d = new Date(p.date);
        if (d >= start && d < endExclusive) heuresTotal += p.nbrHeures;
      }
    }

    const result: Record<string, unknown> = {
      period,
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: new Date(endExclusive.getTime() - 1).toISOString().slice(0, 10),
      nbChantiers: chantiers.length,
      nbEnCours,
      nbTermines,
    };

    if (isAdmin) {
      // Chantiers Terminés mais pas encore Encaissés (clause de sécurisation des
      // commissions) : réservé aux admins, ce sont eux qui valident l'encaissement.
      result.nbTerminesNonEncaisses = nbTerminesNonEncaisses;
    }

    if (!isCommercial && voitMontantsChantier(req)) {
      // ADMIN + CONDUCTEUR : total des achats de la période (peu importe le statut du
      // chantier — un achat facturé ce mois compte, chantier ouvert ou non). Jamais pour un
      // technicien, qui ne voit aucun coût.
      result.achatsTotal = achatsTotal;
    }
    if (!isAdmin && !isCommercial) {
      // CONDUCTEUR : heures totales enregistrées sur la période, tous ses chantiers.
      result.heuresTotal = heuresTotal;
    }

    if (params.margeCommercialeActive) {
      if (isAdmin) {
        // CA vendu / marge / commission commerciale de la période, tous commerciaux
        // confondus (chantiers Terminés ET Encaissés, rattachés au mois de leur clôture) :
        // ce sont des résultats FINALISÉS du mois, pas un cumul de portefeuille en cours.
        // Sans plan commercial, la commission est nulle.
        const commerciaux = await prisma.user.findMany({ where: { OR: COMMERCIAL_OR_FILTER }, select: { id: true } });
        const { byCommercial } = await computeCommissionsParCommercial(commerciaux.map((c) => c.id), start, endExclusive, params);
        let caTotal = 0, margeTotal = 0, commissionCommercialeTotal = 0;
        for (const agg of Object.values(byCommercial) as any[]) {
          caTotal += agg.caTotal;
          margeTotal += agg.margeTotal;
          commissionCommercialeTotal += agg.commissionTotal;
        }
        result.caTotal = caTotal;
        result.margeTotal = margeTotal;
        result.margePct = caTotal > 0 ? (margeTotal / caTotal) * 100 : 0;
        result.commissionCommercialeTotal = commissionCommercialeTotal;
        // Aucun commercial n'a de plan commercial : la carte du tableau de bord le dit.
        result.sansPlanCommercial = (Object.values(byCommercial) as any[]).every((agg) => agg.sansPlanCommercial);
      } else if (isCommercial) {
        const { byCommercial } = await computeCommissionsParCommercial([user.id], start, endExclusive, params);
        const mine = byCommercial[user.id];
        result.margeTotal = mine?.margeTotal ?? 0;
        result.commissionTotal = mine?.commissionTotal ?? 0;
        result.sansPlanCommercial = mine?.sansPlanCommercial ?? true;
      }
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Error computing global stats' });
  }
});

// Statistiques par conducteur de travaux (administration, et responsable sur sa branche —
// CA et marge selon les destinataires de la rentabilité) : marge/CA, avance/retard
// sur les chantiers en cours (heures et matériel), et taux d'objectifs respectés sur
// les chantiers terminés (livrés sans dépassement).
// NB : pas de "taux de remplissage heures" ici (heures réalisées / heures vendues) —
// cet indicateur mélangeait avancement du CHANTIER et assiduité du CONDUCTEUR : un
// chantier fini en avance y ferait mécaniquement baisser le score, un chantier en
// dérive le ferait monter. L'assiduité de saisie a sa propre route ci-dessous
// (GET /stats/conducteurs/assiduite), basée sur le rythme réel de saisie.
app.get('/api/stats/conducteurs', requireAuth, requireTravauxRead, async (req, res) => {
  try {
    const authUser = (req as AuthRequest).user!;
    const isAdmin = isAdminRole(authUser.role);
    if (!isAdmin && authUser.role !== ROLE_RESPONSABLE) return res.status(403).json({ error: 'Accès réservé à l’administration et aux responsables.' });
    const params = await getParametres();
    const users = await prisma.user.findMany({ where: { role: 'CONDUCTEUR_TRAVAUX', ...(authUser.role === ROLE_RESPONSABLE ? { id: { in: authUser.equipeIds } } : {}) }, select: { id: true, name: true, email: true } });
    const chantiers = decimalToNumber(await prisma.chantier.findMany({
      where: perimetreChantiers(req),
      include: { achats: { where: { archivedAt: null } }, pointages: { where: { archivedAt: null } } },
    }));

    const byUser: Record<string, any> = {};
    for (const u of users) {
      byUser[u.id] = {
        id: u.id, name: u.name, email: u.email,
        nbChantiers: 0, nbChantiersEnCours: 0, nbChantiersTermines: 0,
        caTotal: 0, depensesTotal: 0, margeTotal: 0,
        // Chantiers EN_COURS uniquement : où en est le conducteur par rapport au budget vendu.
        nbEnAvanceHeures: 0, nbEnRetardHeures: 0,
        nbMaterielDansBudget: 0, nbMaterielDepasse: 0,
        // Chantiers TERMINE uniquement : livrés dans les clous (heures ET matériel) ? Un
        // chantier en cours a encore des heures/du budget disponibles, son résultat n'est
        // pas définitif — ces stats ne portent donc que sur les chantiers clôturés.
        nbObjectifsRespectes: 0,
        nbTermineEnAvanceHeures: 0, nbTermineEnRetardHeures: 0,
        nbTermineMaterielDansBudget: 0, nbTermineMaterielDepasse: 0,
        heuresVenduesTermineTotal: 0, heuresRealiseesTermineTotal: 0, manqueAGagnerMainOeuvre: 0,
      };
    }

    for (const c of chantiers) {
      if (!c.responsableId || !byUser[c.responsableId]) continue;
      const agg = byUser[c.responsableId];
      const m = computeChantierMetrics(c, params, true);
      const enCours = c.statut === 'EN_COURS';
      const termine = c.statut === 'TERMINE';
      const materielDansBudget = m.materielReel <= c.budgetMaterielVendu;

      agg.nbChantiers++;
      if (enCours) agg.nbChantiersEnCours++;
      if (termine) agg.nbChantiersTermines++;
      agg.depensesTotal += m.totalDepenses;
      // CA et marge : l'administration les voit toujours. Un responsable, comme sur la liste et
      // la fiche : le CA (le vendu) sur les chantiers dont la société le laisse destinataire (cf.
      // voitRentabilite), la marge en plus seulement si la marge commerciale est active.
      if (isAdmin || voitRentabilite(req, c, params)) {
        agg.caVisible = true;
        agg.caTotal += c.budgetGlobalVendu;
        if (isAdmin || params.margeCommercialeActive) {
          agg.margeVisible = true;
          agg.margeTotal += m.margeCommerciale ?? (c.budgetGlobalVendu - m.totalDepenses);
        }
      }

      if (enCours) {
        if (m.diffHeures > 0) agg.nbEnAvanceHeures++;
        else if (m.diffHeures < 0) agg.nbEnRetardHeures++;
        if (materielDansBudget) agg.nbMaterielDansBudget++;
        else agg.nbMaterielDepasse++;
      }
      if (termine) {
        if (m.diffHeures >= 0) agg.nbTermineEnAvanceHeures++;
        else agg.nbTermineEnRetardHeures++;
        if (materielDansBudget) agg.nbTermineMaterielDansBudget++;
        else agg.nbTermineMaterielDepasse++;
        if (m.diffHeures >= 0 && materielDansBudget) agg.nbObjectifsRespectes++;

        agg.heuresVenduesTermineTotal += c.heuresVendues;
        agg.heuresRealiseesTermineTotal += m.heuresRealisees;
        // Manque à gagner = uniquement le coût des heures EN TROP par rapport au vendu,
        // valorisées au taux horaire moyen réellement appliqué sur ce chantier — pas la
        // différence avec le budget main d'œuvre vendu (qui peut s'écarter du taux horaire
        // pour d'autres raisons et fausserait le montant du dépassement lui-même).
        const heuresDepassement = Math.max(0, m.heuresRealisees - c.heuresVendues);
        const tauxHoraireMoyen = m.heuresRealisees > 0 ? m.moReel / m.heuresRealisees : 0;
        agg.manqueAGagnerMainOeuvre += heuresDepassement * tauxHoraireMoyen;
      }
    }

    const list = Object.values(byUser)
      .filter((a: any) => a.nbChantiers > 0)
      .map(({ caVisible, margeVisible, ...a }: any) => ({
        ...a,
        // Dépenses (main-d'œuvre comprise) et manque à gagner (heures en trop au taux moyen) :
        // coût de main-d'œuvre, réservé à l'administration (cf. voitCoutMainOeuvre).
        depensesTotal: isAdmin ? a.depensesTotal : null,
        manqueAGagnerMainOeuvre: isAdmin ? a.manqueAGagnerMainOeuvre : null,
        caTotal: caVisible ? a.caTotal : null,
        margeTotal: margeVisible ? a.margeTotal : null,
        margePct: !margeVisible ? null : a.caTotal > 0 ? (a.margeTotal / a.caTotal) * 100 : 0,
        tauxObjectifsRespectes: a.nbChantiersTermines > 0 ? (a.nbObjectifsRespectes / a.nbChantiersTermines) * 100 : null,
        // % d'heures consommées au-delà du total vendu, sur les seuls chantiers TERMINES
        // (résultat définitif) — un chantier en cours en avance compenserait à tort un
        // chantier terminé en net dépassement si on les mélangeait.
        tauxDepassementHeures: a.heuresVenduesTermineTotal > 0
          ? (Math.max(0, a.heuresRealiseesTermineTotal - a.heuresVenduesTermineTotal) / a.heuresVenduesTermineTotal) * 100
          : null,
      }))
      .sort((x: any, y: any) => (y.margeTotal ?? -Infinity) - (x.margeTotal ?? -Infinity) || x.name.localeCompare(y.name));

    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Error computing conducteurs stats' });
  }
});

// Bornes lundi 00:00 -> samedi 00:00 (exclusif) de la semaine civile contenant `weekParam`.
// Les bornes sont des instants car elles filtrent createdAt ; les jours retournés restent
// explicites pour éviter toute relecture UTC dans la réponse HTTP.
function weekBoundsFrom(weekParam: unknown, fuseauHoraire = FUSEAU_HORAIRE_PAR_DEFAUT, instant = new Date()): { monday: Date; friday: Date; saturdayExclusive: Date; mondayCivil: string; fridayCivil: string } {
  const refCivil = jourCivilDeReference(weekParam, fuseauHoraire, instant);
  const day = new Date(`${refCivil}T00:00:00.000Z`).getUTCDay(); // jour d'une date-seule
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const mondayCivil = ajouterJoursCivils(refCivil, diffToMonday);
  const fridayCivil = ajouterJoursCivils(mondayCivil, 4);
  return {
    monday: debutJourCivilEntreprise(mondayCivil, fuseauHoraire),
    friday: debutJourCivilEntreprise(fridayCivil, fuseauHoraire),
    saturdayExclusive: debutJourCivilEntreprise(ajouterJoursCivils(mondayCivil, 5), fuseauHoraire),
    mondayCivil,
    fridayCivil,
  };
}

const JOURS_OUVRES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];

// Assiduité : administration globale, responsable limité aux conducteurs de sa branche.
app.get('/api/stats/conducteurs/assiduite', requireAuth, requireTravauxRead, async (req, res) => {
  try {
    const authUser = (req as AuthRequest).user!;
    if (!isAdminRole(authUser.role) && authUser.role !== ROLE_RESPONSABLE) return res.status(403).json({ error: 'Accès réservé à l’administration et aux responsables.' });
    const societe = await getCompanySettings();
    const fuseauHoraire = societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
    const { monday, friday, saturdayExclusive, mondayCivil, fridayCivil } = weekBoundsFrom(req.query.week, fuseauHoraire);
    const users = await prisma.user.findMany({ where: { role: 'CONDUCTEUR_TRAVAUX', ...(authUser.role === ROLE_RESPONSABLE ? { id: { in: authUser.equipeIds } } : {}) }, select: { id: true, name: true, email: true } });
    const userIds = users.map((u) => u.id);

    const pointages = decimalToNumber(await prisma.pointageHeure.findMany({
      where: {
        archivedAt: null,
        createdAt: { gte: monday, lt: saturdayExclusive },
        chantier: { ...AFFAIRE_NON_ANNULEE, responsableId: { in: userIds } },
      },
      select: { nbrHeures: true, createdAt: true, chantier: { select: { responsableId: true } } },
    }));

    interface DayAgg { date: string; label: string; nbSaisies: number; heuresSaisies: number }
    const byUser: Record<string, { days: DayAgg[]; heuresParHeureJournee: Record<number, number> }> = {};
    for (const u of users) {
      byUser[u.id] = {
        days: JOURS_OUVRES.map((label, i) => ({
          date: ajouterJoursCivils(mondayCivil, i),
          label,
          nbSaisies: 0,
          heuresSaisies: 0,
        })),
        heuresParHeureJournee: {},
      };
    }

    for (const p of pointages) {
      const responsableId = p.chantier?.responsableId;
      if (!responsableId || !byUser[responsableId]) continue;
      const agg = byUser[responsableId];
      const created = new Date(p.createdAt);
      const createdCivil = jourCivilEntreprise(created, fuseauHoraire);
      const dayIndex = Math.round((new Date(`${createdCivil}T00:00:00.000Z`).getTime() - new Date(`${mondayCivil}T00:00:00.000Z`).getTime()) / 86400000);
      if (dayIndex >= 0 && dayIndex < 5) {
        agg.days[dayIndex].nbSaisies += 1;
        agg.days[dayIndex].heuresSaisies += p.nbrHeures;
      }
      const heure = Number(new Intl.DateTimeFormat('en-GB', { timeZone: fuseauHoraire, hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(created).find((partie) => partie.type === 'hour')?.value);
      agg.heuresParHeureJournee[heure] = (agg.heuresParHeureJournee[heure] || 0) + 1;
    }

    const conducteurs = users.map((u) => {
      const agg = byUser[u.id];
      const joursActifs = agg.days.filter((d) => d.nbSaisies > 0).length;
      const heuresTotalesSaisies = agg.days.reduce((s, d) => s + d.heuresSaisies, 0);
      const nbSaisiesTotal = agg.days.reduce((s, d) => s + d.nbSaisies, 0);
      const tranchesHoraires = Object.entries(agg.heuresParHeureJournee)
        .map(([heure, nbSaisies]) => ({ heure: Number(heure), nbSaisies }))
        .sort((a, b) => a.heure - b.heure);
      const heurePic = tranchesHoraires.length > 0
        ? tranchesHoraires.reduce((max, t) => (t.nbSaisies > max.nbSaisies ? t : max)).heure
        : null;
      return {
        id: u.id, name: u.name, email: u.email,
        days: agg.days,
        joursActifs,
        heuresTotalesSaisies,
        moyenneHeuresParJourActif: joursActifs > 0 ? heuresTotalesSaisies / joursActifs : 0,
        nbSaisiesTotal,
        tranchesHoraires,
        heurePic,
      };
    });

    res.json({
      weekStart: mondayCivil,
      weekEnd: fridayCivil,
      conducteurs,
    });
  } catch (error) {
    res.status(500).json({ error: 'Error computing assiduite stats' });
  }
});

// Répartition des chantiers TERMINÉS (admin uniquement) selon qu'ils ont été livrés
// entièrement dans les clous (heures ET coût main d'œuvre en avance, matériel dans le
// budget), ou en dépassement sur le temps (heures ou coût MO), le matériel, ou les deux.
// Alimente le camembert de l'onglet Statistiques > Chantiers.
app.get('/api/stats/chantiers-repartition', requireAuth, requireAdmin, async (req, res) => {
  try {
    const params = await getParametres();
    const chantiers = decimalToNumber(await prisma.chantier.findMany({
      where: { statut: 'TERMINE' },
      include: { achats: true, pointages: true },
    }));

    let positif = 0, tempsSeul = 0, materielSeul = 0, lesDeux = 0;
    for (const c of chantiers) {
      const m = computeChantierMetrics(c, params, true);
      const tempsOk = m.diffHeures >= 0 && (c.budgetMainOeuvreVendu - m.moReel) >= 0;
      const materielOk = m.materielReel <= c.budgetMaterielVendu;
      if (tempsOk && materielOk) positif++;
      else if (!tempsOk && materielOk) tempsSeul++;
      else if (tempsOk && !materielOk) materielSeul++;
      else lesDeux++;
    }

    const total = chantiers.length;
    const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
    res.json({
      total,
      categories: [
        { key: 'positif', label: 'Tout positif (heures, coût MO et matériel dans le budget)', count: positif, pct: pct(positif) },
        { key: 'tempsSeul', label: 'Dépassement budget temps uniquement', count: tempsSeul, pct: pct(tempsSeul) },
        { key: 'materielSeul', label: 'Dépassement budget matériel uniquement', count: materielSeul, pct: pct(materielSeul) },
        { key: 'lesDeux', label: 'Dépassement des deux budgets (temps ET matériel)', count: lesDeux, pct: pct(lesDeux) },
      ],
    });
  } catch (error) {
    res.status(500).json({ error: 'Error computing chantiers repartition' });
  }
});

// Bornes [début, fin exclue[ d'une période "semaine civile complète" (lundi->lundi
// suivant, 7 jours), « mois civil », « trimestre civil » (janv-mars, avr-juin, juil-sept,
// oct-déc) ou « année civile » contenant `refParam`. Les données métier filtrées sont des
// dates-seules : leurs bornes restent à minuit UTC, mais le jour de référence issu d'un
// instant est obligatoirement lu dans le fuseau de l'entreprise.
function periodBounds(period: 'week' | 'month' | 'quarter' | 'year', refParam: unknown, fuseauHoraire = FUSEAU_HORAIRE_PAR_DEFAUT, instant = new Date()): { start: Date; endExclusive: Date } {
  const refCivil = jourCivilDeReference(refParam, fuseauHoraire, instant);
  const [annee, mois, jour] = refCivil.split('-').map(Number);
  if (period === 'year') {
    return {
      start: new Date(Date.UTC(annee, 0, 1)),
      endExclusive: new Date(Date.UTC(annee + 1, 0, 1)),
    };
  }
  if (period === 'quarter') {
    const quarterStartMonth = Math.floor((mois - 1) / 3) * 3;
    return {
      start: new Date(Date.UTC(annee, quarterStartMonth, 1)),
      endExclusive: new Date(Date.UTC(annee, quarterStartMonth + 3, 1)),
    };
  }
  if (period === 'month') {
    return {
      start: new Date(Date.UTC(annee, mois - 1, 1)),
      endExclusive: new Date(Date.UTC(annee, mois, 1)),
    };
  }
  const day = new Date(Date.UTC(annee, mois - 1, jour)).getUTCDay(); // date-seule
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const start = new Date(Date.UTC(annee, mois - 1, jour + diffToMonday));
  return { start, endExclusive: new Date(start.getTime() + 7 * 86400000) };
}

// Classement des intervenants par heures travaillées (semaine civile / mois civil /
// année civile, navigable) — visible par les conducteurs ET les admins. Basé sur la
// date du travail effectué (`date`), pas l'instant de saisie.
app.get('/api/stats/intervenants', requireAuth, requireTravauxRead, async (req, res) => {
  try {
    const period = (['week', 'month', 'year'] as const).includes(req.query.period as any) ? (req.query.period as 'week' | 'month' | 'year') : 'week';
    const societe = await getCompanySettings();
    const { start, endExclusive } = periodBounds(period, req.query.ref, societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);

    const intervenants = await prisma.intervenant.findMany({ select: { id: true, nom: true, role: true } });
    const pointages = decimalToNumber(await prisma.pointageHeure.findMany({
      where: { archivedAt: null, date: { gte: start, lt: endExclusive }, chantier: perimetreChantiers(req) },
      select: { intervenantId: true, nbrHeures: true, tauxHoraireApplique: true },
    }));

    const byIntervenant: Record<string, { heures: number; cout: number }> = {};
    for (const p of pointages) {
      const cur = byIntervenant[p.intervenantId] || { heures: 0, cout: 0 };
      cur.heures += p.nbrHeures;
      cur.cout += p.nbrHeures * p.tauxHoraireApplique;
      byIntervenant[p.intervenantId] = cur;
    }

    // Le coût d'un intervenant, rapporté à ses heures, redonnerait son taux : réservé à
    // l'administration (cf. voitCoutMainOeuvre).
    const coutVisible = voitCoutMainOeuvre(req);
    const list = intervenants
      .map((i) => ({ id: i.id, nom: i.nom, role: i.role, heures: byIntervenant[i.id]?.heures || 0, cout: coutVisible ? byIntervenant[i.id]?.cout || 0 : null }))
      .filter((i) => i.heures > 0)
      .sort((a, b) => b.heures - a.heures);

    res.json({
      period,
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: new Date(endExclusive.getTime() - 1).toISOString().slice(0, 10),
      intervenants: list,
    });
  } catch (error) {
    res.status(500).json({ error: 'Error computing intervenants stats' });
  }
});

// Total des achats par fournisseur (mois civil / année civile, navigable). Cumul GLOBAL,
// y compris pour conducteurs et responsables : utile avec l'encours fournisseur, il ne révèle
// aucune affaire, prix de vente, marge ou rattachement chantier. Ne pas appliquer le périmètre.
app.get('/api/stats/fournisseurs', requireAuth, requireTravauxRead, async (req, res) => {
  try {
    const period = req.query.period === 'year' ? 'year' : 'month';
    const societe = await getCompanySettings();
    const { start, endExclusive } = periodBounds(period, req.query.ref, societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);

    const fournisseurs = await prisma.fournisseur.findMany({ select: { id: true, nom: true } });
    const achats = decimalToNumber(await prisma.achatReel.findMany({
      where: { archivedAt: null, date: { gte: start, lt: endExclusive } },
      select: { fournisseurId: true, montantHT: true },
    }));

    const byFournisseur: Record<string, { total: number; nb: number }> = {};
    for (const a of achats) {
      const cur = byFournisseur[a.fournisseurId] || { total: 0, nb: 0 };
      cur.total += a.montantHT;
      cur.nb += 1;
      byFournisseur[a.fournisseurId] = cur;
    }

    const list = fournisseurs
      .map((f) => ({ id: f.id, nom: f.nom, total: byFournisseur[f.id]?.total || 0, nbAchats: byFournisseur[f.id]?.nb || 0 }))
      .filter((f) => f.nbAchats > 0)
      .sort((a, b) => b.total - a.total);

    res.json({
      period,
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: new Date(endExclusive.getTime() - 1).toISOString().slice(0, 10),
      fournisseurs: list,
    });
  } catch (error) {
    res.status(500).json({ error: 'Error computing fournisseurs stats' });
  }
});

// Nombre de chantiers par type (un chantier peut avoir plusieurs types), mois civil /
// année civile, navigable. Un conducteur ne voit que ses propres chantiers (même
// périmètre que partout ailleurs) ; un admin voit tous les chantiers. Basé sur la date
// de démarrage du chantier (dateDebut).
app.get('/api/stats/types-chantiers', requireAuth, requireTravauxRead, async (req, res) => {
  try {
    const period = req.query.period === 'year' ? 'year' : 'month';
    const societe = await getCompanySettings();
    const fuseauHoraire = societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
    const { start, endExclusive } = periodBounds(period, req.query.ref, fuseauHoraire);

    // Le début d'un chantier converti avant #130 est un instant, les autres une date-seule :
    // chacun compte au jour civil de la société (jourCivilDeDebut), d'où une marge d'un jour
    // de part et d'autre de la période, puis un tri sur ce jour civil.
    const debutCivil = start.toISOString().slice(0, 10);
    const finCivileExclue = endExclusive.toISOString().slice(0, 10);
    const chantiers = (await prisma.chantier.findMany({
      where: {
        dateDebut: { gte: new Date(start.getTime() - 86400000), lt: new Date(endExclusive.getTime() + 86400000) },
        ...perimetreChantiers(req),
      },
      select: { types: true, dateDebut: true },
    })).filter((c) => {
      const jour = jourCivilDeDebut(c.dateDebut, fuseauHoraire);
      return jour >= debutCivil && jour < finCivileExclue;
    });

    const counts: Record<string, number> = {};
    for (const t of TYPES_CHANTIER) counts[t] = 0;
    for (const c of chantiers) {
      for (const t of c.types) counts[t] = (counts[t] || 0) + 1;
    }

    const totalChantiers = chantiers.length;
    const types = Object.entries(counts)
      .map(([type, count]) => ({ type, count, pct: totalChantiers > 0 ? (count / totalChantiers) * 100 : 0 }))
      .sort((a, b) => b.count - a.count);

    res.json({
      period,
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: new Date(endExclusive.getTime() - 1).toISOString().slice(0, 10),
      totalChantiers,
      types,
    });
  } catch (error) {
    res.status(500).json({ error: 'Error computing types chantiers stats' });
  }
});

function commissionBaremeProgressif(marge: number, bareme: { plafond: number; taux: number }[]): number {
  if (marge <= 0) return 0;
  let commission = 0;
  let plancher = 0;
  for (const { plafond, taux } of bareme) {
    if (marge <= plancher) break;
    commission += (Math.min(marge, plafond) - plancher) * (taux / 100);
    plancher = plafond;
  }
  return commission;
}

// Clés "YYYY-MM" (UTC) de chaque mois civil couvert par [start, endExclusive[.
function moisKeysDansPeriode(start: Date, endExclusive: Date): string[] {
  const keys: string[] = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur < endExclusive) {
    keys.push(cur.toISOString().slice(0, 7));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return keys;
}

// Date de rattachement mensuel d'un chantier pour le calcul des commissions : celle où
// sa marge est réputée acquise. On retient la date de clôture (dateFin, auto-renseignée
// au passage en Terminé — cf. PATCH /chantiers/:id/statut), avec repli sur updatedAt pour
// les chantiers déjà clôturés avant l'introduction de ce champ. Un chantier En cours n'a
// pas encore de date de clôture : sa marge n'est pas rattachable à un mois.
function dateClotureChantier(c: any): Date | null {
  if (c.statut !== 'TERMINE') return null;
  return c.dateFin ? new Date(c.dateFin) : new Date(c.updatedAt);
}

// Calcule marge/commission (barème progressif + primes d'objectifs et de suivi
// administratif) par commercial sur [start, endExclusive[, mois par mois (cf. commentaire
// de /api/stats/commerciaux). Réutilisé par cette route (détail par chantier) ET par
// /api/stats/global (total agrégé pour les cartes du tableau de bord).
//
// Plan commercial (lot (i)) : un commercial sans plan commercial ne touche aucune commission
// ni prime, jusqu'à ce qu'un plan lui soit attribué à date (décision de Nelson du
// 17-10-2026). Aucun plan n'existe encore : le barème global (ParametresRemuneration) n'est
// plus appliqué, chaque commercial reçoit les règles neutres et seuls le CA et la marge
// restent calculés.
async function computeCommissionsParCommercial(commercialIds: string[], start: Date, endExclusive: Date, params: Parametres) {
  const regles = remunerationNeutre();
  const commercialIdSet = new Set(commercialIds);
  const chantiers = decimalToNumber(await prisma.chantier.findMany({
    // Une affaire annulée n'a jamais existé commercialement : ni CA, ni marge, ni commission.
    where: { ...AFFAIRE_NON_ANNULEE, commercialId: { in: commercialIds } },
    include: { achats: { where: { archivedAt: null } }, pointages: { where: { archivedAt: null } } },
  }));

  const moisPeriode = moisKeysDansPeriode(start, endExclusive);
  const primesAdmin = await prisma.primeMensuelleCommercial.findMany({
    where: { commercialId: { in: commercialIds }, periode: { in: moisPeriode } },
  });
  const suiviAdminSet = new Set(primesAdmin.filter((p) => p.suiviAdministratif).map((p) => `${p.commercialId}:${p.periode}`));

  const buckets: Record<string, Record<string, { ca: number; margeStandard: number; margeReduite: number }>> = {};
  for (const c of chantiers) {
    if (!c.commercialId || !commercialIdSet.has(c.commercialId)) continue;
    const dateCloture = dateClotureChantier(c);
    if (!c.encaisse || !dateCloture || dateCloture < start || dateCloture >= endExclusive) continue;
    const m = computeChantierMetrics(c, params, true);
    const moisKey = dateCloture.toISOString().slice(0, 7);
    buckets[c.commercialId] ??= {};
    buckets[c.commercialId][moisKey] ??= { ca: 0, margeStandard: 0, margeReduite: 0 };
    const b = buckets[c.commercialId][moisKey];
    b.ca += c.budgetGlobalVendu;
    if (c.baremeReduit) b.margeReduite += m.margeCommerciale ?? 0;
    else b.margeStandard += m.margeCommerciale ?? 0;
  }

  const commissionsParMoisGroupe: Record<string, { standard: number; reduit: number }> = {};
  const byCommercial: Record<string, any> = {};
  for (const id of commercialIds) {
    const buck = buckets[id] || {};
    let commissionStandard = 0, commissionReduite = 0, primeCA = 0, primeMarge = 0, primeAdmin = 0, caTotal = 0, margeTotal = 0, margeStandard = 0, margeReduite = 0;
    for (const [moisKey, b] of Object.entries(buck)) {
      const cStandard = commissionBaremeProgressif(b.margeStandard, regles.baremeStandard);
      const cReduit = commissionBaremeProgressif(b.margeReduite, regles.baremeReduit);
      commissionsParMoisGroupe[`${id}:${moisKey}`] = { standard: cStandard, reduit: cReduit };
      commissionStandard += cStandard;
      commissionReduite += cReduit;
      caTotal += b.ca;
      margeStandard += b.margeStandard;
      margeReduite += b.margeReduite;
      margeTotal += b.margeStandard + b.margeReduite;
      // Un objectif à 0 n'est pas un objectif atteint d'office : sans seuil défini,
      // aucune prime n'est due.
      if (regles.objectifCaMensuel > 0 && b.ca >= regles.objectifCaMensuel) primeCA += regles.primeObjectifCa;
      if (regles.objectifMargeMensuel > 0 && b.margeStandard + b.margeReduite >= regles.objectifMargeMensuel) primeMarge += regles.primeObjectifMarge;
      if (suiviAdminSet.has(`${id}:${moisKey}`)) primeAdmin += regles.primeSuiviAdministratif;
    }
    const commissionBareme = commissionStandard + commissionReduite;
    byCommercial[id] = {
      caTotal, margeTotal, margeStandard, margeReduite,
      commissionBareme, commissionStandard, commissionReduite, primeCA, primeMarge, primeAdmin,
      commissionTotal: commissionBareme + primeCA + primeMarge + primeAdmin,
      sansPlanCommercial: true,
    };
  }

  return { byCommercial, chantiers, buckets, commissionsParMoisGroupe, moisPeriode, suiviAdminSet };
}

// Résultat commercial : CA vendu / marge / commission (barème progressif + primes
// d'objectifs) par commercial, mois civil ou année civile en cours (navigable), classé
// par CA vendu décroissant. Un admin voit tous les commerciaux (menu « Mes commerciaux »),
// un commercial ne voit que sa propre ligne (menu « Résultat commercial »). Sans plan
// commercial, commission et primes sont nulles et chaque commercial porte
// `sansPlanCommercial` (cf. computeCommissionsParCommercial).
//
// Le calcul est MENSUEL : seuls les chantiers Terminés ET Encaissés comptent (clause de
// sécurisation), rattachés au mois de leur clôture. La vue "Année" agrège 12 calculs
// mensuels indépendants. La liste `chantiers` de chaque
// commercial reste l'intégralité de ses chantiers (toutes périodes confondues), pour la
// vue détaillée ; `comptabiliseDansPeriode` indique lesquels comptent dans les totaux.
app.get('/api/stats/commerciaux', requireAuth, async (req, res) => {
  try {
    const authUser = (req as AuthRequest).user!;
    const isAdmin = isAdminRole(authUser.role);
    if (!isAdmin && authUser.role !== 'COMMERCIAL') {
      return res.status(403).json({ error: 'Accès réservé' });
    }
    const period = (['month', 'quarter', 'year'] as const).includes(req.query.period as any)
      ? (req.query.period as 'month' | 'quarter' | 'year')
      : 'month';
    const societe = await getCompanySettings();
    const { start, endExclusive } = periodBounds(period, req.query.ref, societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
    const params = await getParametres();
    // Seul le libellé du barème réduit sert encore : il nomme la case cochée sur les chantiers.
    const { libelleBaremeReduit } = await getReglesRemuneration();

    const users = await prisma.user.findMany({
      where: isAdmin ? { OR: COMMERCIAL_OR_FILTER } : { id: authUser.id, role: 'COMMERCIAL' },
      select: { id: true, name: true, email: true },
    });

    const commercialIds = users.map((u) => u.id);
    const { byCommercial, chantiers, buckets, commissionsParMoisGroupe, moisPeriode, suiviAdminSet } =
      await computeCommissionsParCommercial(commercialIds, start, endExclusive, params);

    const byUser: Record<string, any> = {};
    for (const u of users) {
      byUser[u.id] = {
        id: u.id, name: u.name, email: u.email, nbChantiers: 0,
        ...byCommercial[u.id],
        // Pertinent seulement en vue "mois" : suivi administratif enregistré pour le mois
        // affiché (fait sans montant, plus saisi à l'écran ; cf. route prime-mensuelle).
        suiviAdministratif: period === 'month' ? suiviAdminSet.has(`${u.id}:${moisPeriode[0]}`) : null,
        chantiers: [] as any[],
      };
    }

    // Détail par chantier (toutes périodes confondues, pour la vue détaillée).
    for (const c of chantiers) {
      if (!c.commercialId || !byUser[c.commercialId]) continue;
      const agg = byUser[c.commercialId];
      const m = computeChantierMetrics(c, params, true);
      agg.nbChantiers++;

      const dateCloture = dateClotureChantier(c);
      const valide = c.statut === 'TERMINE' && c.encaisse;
      const dansPeriode = valide && !!dateCloture && dateCloture >= start && dateCloture < endExclusive;
      let commissionEstimee: number | null = null;
      if (dansPeriode && dateCloture) {
        const moisKey = dateCloture.toISOString().slice(0, 7);
        const groupe = commissionsParMoisGroupe[`${c.commercialId}:${moisKey}`];
        const b = buckets[c.commercialId]?.[moisKey];
        if (groupe && b) {
          const margeGroupe = c.baremeReduit ? b.margeReduite : b.margeStandard;
          const commissionGroupe = c.baremeReduit ? groupe.reduit : groupe.standard;
          commissionEstimee = margeGroupe > 0 ? commissionGroupe * ((m.margeCommerciale ?? 0) / margeGroupe) : 0;
        }
      }

      agg.chantiers.push({
        id: c.id,
        nom: c.nom,
        client: c.client,
        statut: c.statut,
        dateDebut: c.dateDebut,
        dateFin: c.dateFin,
        baremeReduit: c.baremeReduit,
        encaisse: c.encaisse,
        dateEncaissement: c.dateEncaissement,
        budgetGlobalVendu: c.budgetGlobalVendu,
        margeCommerciale: m.margeCommerciale,
        valide,
        comptabiliseDansPeriode: dansPeriode,
        commissionEstimee,
      });
    }

    const list = Object.values(byUser)
      .map((a: any) => ({
        ...a,
        chantiers: a.chantiers.sort((x: any, y: any) => new Date(y.dateDebut).getTime() - new Date(x.dateDebut).getTime()),
      }))
      .sort((x: any, y: any) => y.caTotal - x.caTotal);

    res.json({
      period,
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: new Date(endExclusive.getTime() - 1).toISOString().slice(0, 10),
      // Ni barème ni objectifs : sans plan commercial, aucune règle de rémunération ne
      // s'applique (cf. computeCommissionsParCommercial).
      libelleBaremeReduit,
      commerciaux: list,
    });
  } catch (error) {
    res.status(500).json({ error: 'Error computing commerciaux stats' });
  }
});

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
