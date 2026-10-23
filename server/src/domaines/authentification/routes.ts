import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../../db';
import { ROLE_SUPERADMIN } from '../../droits/roles';
import { permissionsEffectives } from '../../droits/permissions';
import { type AuthRequest, JWT_SECRET, requireAuth } from '../../http/auth';
import { AZURE_TENANT_ID, AZURE_CLIENT_ID, SSO_CONFIGURED, resolveAuthorizedSsoUser, verifyMicrosoftIdentity } from './sso';
import {
  BREAK_GLASS_EMAIL, BREAK_GLASS_TOKEN, BREAK_GLASS_MIN_LONGUEUR, BREAK_GLASS_ACTIF, BREAK_GLASS_ADRESSE_RESERVEE, secretIdentique, essaisSecours, tropDEssaisSecours,
} from './secours';

export function enregistrerRoutesAuthentification(app: Express): void {
  // Routes de base (publiques)
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  // Configuration publique nécessaire au client SSO.
  // clientId et tenantId ne sont PAS secrets pour une SPA MSAL (ils figurent dans le
  // bundle front) : on peut les exposer pour configurer la connexion Microsoft.
  app.get('/api/config', (req, res) => {
    res.json({
      ssoConfigured: SSO_CONFIGURED,
      ssoClientId: AZURE_CLIENT_ID || null,
      ssoTenantId: AZURE_TENANT_ID || null,
    });
  });

  // Connexion via SSO Microsoft — point d'application de la couche d'autorisation.
  // Une fois l'identité Microsoft VÉRIFIÉE, l'email est confronté à la liste blanche
  // (table User) : autorisé => jeton applicatif avec le rôle associé ; sinon 403 (le client
  // redirige alors vers « /acces-refuse »). Le flux OAuth lui-même reste à câbler ; tant que
  // le SSO n'est pas configuré la route est inactive et n'émet aucun jeton.
  app.post('/api/auth/sso', async (req, res) => {
    try {
      if (!SSO_CONFIGURED) {
        return res.status(503).json({ code: 'SSO_NOT_CONFIGURED', error: "La connexion Microsoft SSO n'est pas encore activée. Contactez l'administrateur." });
      }
      const email = await verifyMicrosoftIdentity(req);
      if (!email) {
        return res.status(401).json({ code: 'SSO_TOKEN_INVALID', error: 'Jeton Microsoft invalide ou non vérifié.' });
      }
      const user = await resolveAuthorizedSsoUser(email);
      if (!user) {
        return res.status(403).json({ code: 'SSO_NOT_AUTHORIZED', error: "Accès refusé : votre compte n'est pas autorisé. Contactez l'administrateur." });
      }
      const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, user: { ...user, permissions: permissionsEffectives(user) } });
    } catch (error) {
      res.status(500).json({ error: 'Erreur lors de la connexion SSO' });
    }
  });

  if (BREAK_GLASS_ADRESSE_RESERVEE) {
    console.warn(`[SECOURS] Accès de secours INACTIF : ${BREAK_GLASS_EMAIL} est l'adresse réservée du compte système, qui ne se connecte jamais.`);
  } else if (BREAK_GLASS_TOKEN && !BREAK_GLASS_ACTIF) {
    // Un secret trop court est refusé plutôt qu'accepté en silence : le croire actif alors
    // qu'il ne l'est pas serait le pire des deux mondes le jour où on en a besoin.
    console.warn(
      `[SECOURS] Accès de secours INACTIF : BREAK_GLASS_TOKEN doit faire au moins ${BREAK_GLASS_MIN_LONGUEUR} caractères` +
        (BREAK_GLASS_EMAIL ? '.' : ' et BREAK_GLASS_EMAIL doit être renseigné.')
    );
  } else if (BREAK_GLASS_ACTIF) {
    console.log(`[SECOURS] Accès de secours actif pour ${BREAK_GLASS_EMAIL} (session limitée à 1 h).`);
  }

  // Publie l'existence du mécanisme (pas le secret) pour que la page /secours sache si elle
  // doit s'afficher. Volontairement sans authentification, comme /api/config : savoir qu'une
  // porte de service existe n'aide pas à l'ouvrir.
  app.get('/api/auth/secours/etat', (_req, res) => {
    res.json({ disponible: BREAK_GLASS_ACTIF });
  });

  app.post('/api/auth/secours', async (req, res) => {
    const ip = req.ip || 'inconnue';
    if (!BREAK_GLASS_ACTIF) {
      return res.status(503).json({ code: 'SECOURS_INACTIF', error: "L'accès de secours n'est pas configuré sur cette instance." });
    }
    if (tropDEssaisSecours(ip)) {
      console.warn(`[SECOURS] Trop de tentatives depuis ${ip} — blocage temporaire.`);
      return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quinze minutes.' });
    }
    const token = String(req.body?.token || '');
    if (!token || !secretIdentique(token, BREAK_GLASS_TOKEN)) {
      console.warn(`[SECOURS] Tentative d'accès de secours REFUSÉE depuis ${ip}.`);
      return res.status(401).json({ error: 'Jeton de secours invalide.' });
    }
    try {
      const user = await prisma.user.findFirst({
        where: { email: BREAK_GLASS_EMAIL, actif: true, role: ROLE_SUPERADMIN },
        select: { id: true, name: true, email: true, role: true, theme: true, accesFinance: true, permissions: true },
      });
      // Le secret seul ne suffit pas : il ouvre un compte précis, qui doit encore exister,
      // être actif et être superadmin. Un compte rétrogradé ou désactivé ferme la porte.
      if (!user) {
        console.warn(`[SECOURS] Jeton valide mais compte ${BREAK_GLASS_EMAIL} absent, inactif ou non superadmin.`);
        return res.status(403).json({ error: "Le compte de secours n'est pas un super administrateur actif." });
      }
      const jeton = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
      console.warn(`[SECOURS] ACCÈS DE SECOURS UTILISÉ par ${user.email} depuis ${ip} — session d'une heure.`);
      essaisSecours.delete(ip);
      res.json({ token: jeton, user: { ...user, permissions: permissionsEffectives(user) }, expiresIn: 3600 });
    } catch {
      res.status(500).json({ error: "Erreur lors de l'ouverture de la session de secours." });
    }
  });

  // Compte connecté, tel qu'il est EN BASE à l'instant présent. Le client s'en sert pour
  // resynchroniser le rôle qu'il a mémorisé à la connexion : sans cela, une promotion (ou
  // une rétrogradation) resterait invisible dans les menus jusqu'à la prochaine connexion,
  // alors que l'API, elle, applique déjà les nouveaux droits (cf. requireAuth).
  app.get('/api/me', requireAuth, async (req, res) => {
    try {
      const authUser = (req as AuthRequest).user!;
      const user = await prisma.user.findUnique({
        where: { id: authUser.id },
        select: { id: true, name: true, email: true, role: true, theme: true, accesFinance: true, permissions: true },
      });
      if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
      res.json({ ...user, permissions: permissionsEffectives(user) });
    } catch {
      res.status(500).json({ error: 'Error fetching current user' });
    }
  });

  // Préférence d'affichage (clair/sombre) : chaque utilisateur (admin ou conducteur) ne
  // peut modifier que la sienne — l'id vient du jeton, jamais du corps de la requête.
  app.put('/api/me/theme', requireAuth, async (req, res) => {
    try {
      const theme = req.body.theme === 'dark' ? 'dark' : 'light';
      const authUser = (req as AuthRequest).user!;
      const user = await prisma.user.update({
        where: { id: authUser.id },
        data: { theme },
        select: { id: true, name: true, email: true, role: true, theme: true },
      });
      res.json(user);
    } catch (error) {
      res.status(500).json({ error: 'Error updating theme' });
    }
  });
}
