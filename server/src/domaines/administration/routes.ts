import type { Express } from 'express';
import crypto from 'crypto';
import { prisma, transactionVerifiee } from '../../db';
import { isSuperAdminRole } from '../../droits/roles';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { requireSuperAdmin } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { API_SCOPES, type ApiScope, apiKeyHash, requireApiKey } from '../../http/cles-api';
import { changementsJournal, journaliserAdministration, verrouillerReglage } from '../../commun/journal-administration';
import { getParametres, getReglesRemuneration } from '../parametres/metier';
import { MODES_ENVOI } from '../documents/envoiMicrosoft365';
import { companySettingsPayload, getCompanySettings } from './metier';

function publicApiKey(key: { id: string; nom: string; prefixe: string; scopes: string[]; actif: boolean; expireLe: Date | null; dernierUsageLe: Date | null; creeLe: Date; revoqueLe: Date | null }) {
  return { id: key.id, nom: key.nom, prefixe: key.prefixe, scopes: key.scopes, actif: key.actif, expireLe: key.expireLe, dernierUsageLe: key.dernierUsageLe, creeLe: key.creeLe, revoqueLe: key.revoqueLe };
}

export function enregistrerRoutesClesIntegration(app: Express): void {
  app.get('/api/admin/api-keys', requireAuth, requireSuperAdmin, async (_req, res) => {
    try {
      const keys = await prisma.apiAccessKey.findMany({ orderBy: { creeLe: 'desc' } });
      res.json(keys.map(publicApiKey));
    } catch {
      res.status(500).json({ error: 'Error fetching API keys' });
    }
  });

  // Liste des scopes disponibles, pour que l'écran d'administration n'ait pas à les
  // dupliquer (une divergence donnerait une case à cocher que le serveur refuserait).
  app.get('/api/admin/api-scopes', requireAuth, requireSuperAdmin, (_req, res) => {
    res.json({ scopes: API_SCOPES });
  });

  app.post('/api/admin/api-keys', requireAuth, requireSuperAdmin, async (req, res) => {
    const nom = String(req.body?.nom || '').trim();
    const scopes = Array.isArray(req.body?.scopes)
      ? req.body.scopes.filter((s: unknown): s is ApiScope => typeof s === 'string' && (API_SCOPES as readonly string[]).includes(s))
      : [];
    const expireLe = req.body?.expireLe ? new Date(String(req.body.expireLe)) : null;
    if (!nom || nom.length > 100 || scopes.length === 0 || (expireLe && Number.isNaN(expireLe.getTime()))) {
      return res.status(400).json({ error: 'Nom, scopes autorisés et date d’expiration valide requis.' });
    }
    try {
      const secret = `iris_${crypto.randomBytes(32).toString('base64url')}`;
      const key = await transactionVerifiee(async (tx) => {
        const cle = await tx.apiAccessKey.create({
          data: { nom, prefixe: secret.slice(0, 14), secretHash: apiKeyHash(secret), scopes, expireLe, creeParId: (req as AuthRequest).user!.id },
        });
        // Ni le secret ni son empreinte : seulement le préfixe affiché dans l'administration.
        await journaliserAdministration(tx, req as AuthRequest, {
          domaine: 'REGLAGES', type: 'CLE_INTEGRATION', action: 'CREATION', cibleId: cle.id, cibleLibelle: cle.nom, reserveSuperAdmin: true,
          apres: { nom: cle.nom, prefixe: cle.prefixe, scopes: cle.scopes, expireLe: cle.expireLe },
        });
        return cle;
      });
      console.warn(`[API] Clé d'intégration créée : « ${nom} » (${scopes.join(', ')}) par ${(req as AuthRequest).user!.id}`);
      res.status(201).json({ apiKey: secret, key: publicApiKey(key), warning: 'Copiez cette clé maintenant : elle ne sera plus jamais affichée.' });
    } catch {
      res.status(500).json({ error: 'Création de la clé impossible.' });
    }
  });

  app.post('/api/admin/api-keys/:id/revoke', requireAuth, requireSuperAdmin, async (req, res) => {
    let key;
    try {
      key = await transactionVerifiee(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "ApiAccessKey" WHERE "id" = ${paramId(req)} FOR UPDATE`;
        const avant = await tx.apiAccessKey.findUnique({ where: { id: paramId(req) } });
        if (!avant) return null;
        // Une clé déjà révoquée le reste : ni nouvelle date de révocation, ni nouvelle entrée.
        if (!avant.actif && avant.revoqueLe) return avant;
        const cle = await tx.apiAccessKey.update({ where: { id: avant.id }, data: { actif: false, revoqueLe: new Date() } });
        await journaliserAdministration(tx, req as AuthRequest, {
          domaine: 'REGLAGES', type: 'CLE_INTEGRATION', action: 'REVOCATION', cibleId: cle.id, cibleLibelle: cle.nom, reserveSuperAdmin: true,
          avant: { actif: avant.actif, revoqueLe: avant.revoqueLe }, apres: { actif: cle.actif, revoqueLe: cle.revoqueLe },
        });
        return cle;
      });
    } catch {
      return res.status(500).json({ error: 'Révocation de la clé impossible.' });
    }
    if (!key) return res.status(404).json({ error: 'Clé API introuvable.' });
    console.warn(`[API] Clé d'intégration révoquée : « ${key.nom} »`);
    res.json(publicApiKey(key));
  });

  // Identité de la société : lecture seule pour un agent (en-tête de devis, mentions
  // légales d'un document qu'il rédige). L'écriture reste réservée à un superadmin humain.
  app.get('/api/v1/company', requireApiKey('company:read'), async (_req, res) => {
    try {
      res.json(await getCompanySettings());
    } catch {
      res.status(500).json({ error: 'Error fetching company settings' });
    }
  });
}

export function enregistrerRoutesSociete(app: Express): void {
  // --- Société de l'instance (singleton, hors paramètres métier) ---
  app.get('/api/company', requireAuth, async (_req, res) => {
    try {
      res.json(await getCompanySettings());
    } catch {
      res.status(500).json({ error: 'Error fetching company settings' });
    }
  });

  app.put('/api/company', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
      const data = companySettingsPayload(req.body ?? {});
      const company = await transactionVerifiee(async (tx) => {
        await verrouillerReglage(tx, 'CompanySettings');
        const avant = await tx.companySettings.findUnique({ where: { id: 'singleton' } });
        const apres = await tx.companySettings.upsert({
          where: { id: 'singleton' },
          update: data,
          create: { id: 'singleton', ...data },
        });
        const changements = changementsJournal(avant, apres, Object.keys(data));
        if (changements) await journaliserAdministration(tx, req as AuthRequest, { domaine: 'REGLAGES', type: 'SOCIETE', action: 'MODIFICATION', ...changements });
        return apres;
      });
      res.json(company);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error updating company settings';
      res.status(message.startsWith('Champ société invalide') || message.startsWith('Couleur invalide') || message.startsWith('Fuseau horaire invalide') ? 400 : 500)
        .json({ error: message });
    }
  });
}

export function enregistrerRoutesModules(app: Express): void {
  // --- Modules de l'application (activation par le superadmin) ---
  // Lecture : accessible à TOUT compte authentifié — le client en a besoin pour savoir
  // quelles entrées de menu afficher. On renvoie la visibilité EFFECTIVE pour le compte
  // connecté : un superadmin garde toujours accès au planning, même désactivé (c'est lui
  // qui le pilote), les autres suivent le réglage global. Le mode d'envoi des documents (lot 6b-1b)
  // est rendu tel quel.
  app.get('/api/modules', requireAuth, async (req, res) => {
    try {
      const { planningActif, modeEnvoi } = await getParametres();
      const isSuper = isSuperAdminRole((req as AuthRequest).user?.role);
      // Le libellé du barème réduit voyage avec les modules : c'est le seul réglage lu par
      // TOUS les comptes (la route /parametres/remuneration, elle, est réservée aux admins),
      // et il s'affiche sur la fiche chantier comme sur les écrans commerciaux.
      const { libelleBaremeReduit } = await getReglesRemuneration();
      res.json({ planningActif: isSuper || planningActif, planningActifGlobal: planningActif, libelleBaremeReduit, modeEnvoi });
    } catch (error) {
      res.status(500).json({ error: 'Error fetching modules' });
    }
  });

  // Écriture : superadmin uniquement. Désactiver le planning ne supprime RIEN — les
  // affectations et types d'événements restent en base et réapparaissent à la réactivation.
  // Réglage champ par champ (lot 6b-1b, V2 du cadrage) : un champ absent garde sa valeur, comme dans
  // PUT /api/parametres ; un champ présent mais invalide est refusé (400), sans rien écrire.
  //   - planningActif : un vrai booléen (choix le plus restrictif, à confirmer, comme PUT /api/parametres) ;
  //   - modeEnvoi : le mode d'envoi des documents, MICROSOFT_365 ou MESSAGERIE (lot 6b-1b ; réglé par le
  //     super administrateur seul, choix le plus restrictif, à confirmer).
  // Chaque réglage changé a sa propre ligne au journal d'administration.
  app.put('/api/modules', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
      const corps = req.body ?? {};
      const data: { planningActif?: boolean; modeEnvoi?: string } = {};
      if ('planningActif' in corps) {
        if (typeof corps.planningActif !== 'boolean') return res.status(400).json({ error: 'L’activation du planning se règle par oui ou non.' });
        data.planningActif = corps.planningActif;
      }
      if ('modeEnvoi' in corps) {
        if (!MODES_ENVOI.includes(corps.modeEnvoi)) return res.status(400).json({ error: 'Mode d’envoi des documents inconnu : choisissez MICROSOFT_365 ou MESSAGERIE.' });
        data.modeEnvoi = corps.modeEnvoi;
      }
      const p = await transactionVerifiee(async (tx) => {
        await verrouillerReglage(tx, 'Parametres');
        const avant = await tx.parametres.findUnique({ where: { id: 'singleton' } });
        const apres = await tx.parametres.upsert({
          where: { id: 'singleton' },
          update: data,
          create: { id: 'singleton', ...data },
        });
        const planning = changementsJournal(avant, apres, ['planningActif']);
        if (planning) await journaliserAdministration(tx, req as AuthRequest, { domaine: 'REGLAGES', type: 'MODULES', action: apres.planningActif ? 'ACTIVATION' : 'DESACTIVATION', cibleLibelle: 'Planning', ...planning });
        const mode = changementsJournal(avant, apres, ['modeEnvoi']);
        if (mode) await journaliserAdministration(tx, req as AuthRequest, { domaine: 'REGLAGES', type: 'MODULES', action: 'MODIFICATION', cibleLibelle: 'Mode d’envoi des documents', ...mode });
        return apres;
      });
      res.json({ planningActif: true, planningActifGlobal: p.planningActif, modeEnvoi: p.modeEnvoi });
    } catch (error) {
      res.status(500).json({ error: 'Error updating modules' });
    }
  });
}
