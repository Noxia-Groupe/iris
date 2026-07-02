import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import multer from 'multer';
import archiver from 'archiver';
import path from 'path';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

dotenv.config();

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const app = express();
const prisma = new PrismaClient();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// --- Sécurité : résolution du secret JWT ---
// En production, le secret est OBLIGATOIRE : on refuse de démarrer sinon.
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET manquant : définissez-le dans server/.env avant de démarrer en production.');
  }
  console.warn('[AVERTISSEMENT] JWT_SECRET non défini — clé de développement non sécurisée utilisée.');
  return 'dev_only_insecure_secret_change_me';
}
const JWT_SECRET = resolveJwtSecret();

// --- SSO Microsoft (OAuth 2.0 / OpenID Connect, endpoint v2.0) ---
// Le SSO n'est actif que si l'application Azure AD est renseignée (tenant + client).
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || '';
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || '';
const SSO_CONFIGURED = !!(AZURE_TENANT_ID && AZURE_CLIENT_ID);
const MS_ISSUER = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/v2.0`;
const MS_JWKS_URI = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/discovery/v2.0/keys`;

// Normalise un email pour les comparaisons/stockage (insensible à la casse).
function normalizeEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase();
}

// Cœur de la couche d'autorisation SSO : un email Microsoft n'est autorisé que s'il
// figure dans la liste des comptes (table User). Présent => autorisé, avec le rôle
// associé ; absent => `null` (connexion à refuser, redirection vers « accès refusé »).
async function resolveAuthorizedSsoUser(email: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return prisma.user.findUnique({
    where: { email: normalized },
    select: { id: true, name: true, email: true, role: true },
  });
}

// Récupère la clé publique de signature Microsoft correspondant au `kid` du jeton.
// Les clés (JWKS) sont mises en cache 1 h ; en cas de `kid` inconnu on rafraîchit une fois
// (rotation de clés). Utilise le support natif des JWK de Node (crypto.createPublicKey).
let msJwksCache: { keys: Array<Record<string, unknown>>; fetchedAt: number } | null = null;
async function getMicrosoftSigningKey(kid: string): Promise<crypto.KeyObject | null> {
  const fresh = msJwksCache && Date.now() - msJwksCache.fetchedAt < 3600_000;
  if (!fresh) {
    const res = await fetch(MS_JWKS_URI);
    if (!res.ok) return null;
    const data = (await res.json()) as { keys?: Array<Record<string, unknown>> };
    msJwksCache = { keys: data.keys || [], fetchedAt: Date.now() };
  }
  let jwk = msJwksCache!.keys.find((k) => k.kid === kid);
  if (!jwk) {
    // kid absent du cache : forcer un rafraîchissement (rotation possible).
    const res = await fetch(MS_JWKS_URI);
    if (!res.ok) return null;
    const data = (await res.json()) as { keys?: Array<Record<string, unknown>> };
    msJwksCache = { keys: data.keys || [], fetchedAt: Date.now() };
    jwk = msJwksCache.keys.find((k) => k.kid === kid);
  }
  if (!jwk) return null;
  return crypto.createPublicKey({ key: jwk as crypto.webcrypto.JsonWebKey, format: 'jwk' });
}

// Vérifie le jeton d'identité Microsoft (idToken) fourni par le client (MSAL) et en
// extrait l'email VÉRIFIÉ. Contrôles : signature RS256 par une clé Microsoft, audience =
// client_id de notre app, issuer = notre tenant. Retourne null si quoi que ce soit échoue.
async function verifyMicrosoftIdentity(req: express.Request): Promise<string | null> {
  const idToken = String(req.body?.idToken || '');
  if (!idToken) return null;
  try {
    const decoded = jwt.decode(idToken, { complete: true }) as { header?: { kid?: string } } | null;
    const kid = decoded?.header?.kid;
    if (!kid) return null;
    const key = await getMicrosoftSigningKey(kid);
    if (!key) return null;
    const pem = key.export({ type: 'spki', format: 'pem' }) as string;
    const payload = jwt.verify(idToken, pem, {
      algorithms: ['RS256'],
      audience: AZURE_CLIENT_ID,
      issuer: MS_ISSUER,
    }) as jwt.JwtPayload;
    // Comptes professionnels : `preferred_username` porte l'UPN/email ; `email` en secours.
    const email = (payload.email as string) || (payload.preferred_username as string) || '';
    return email || null;
  } catch {
    return null;
  }
}

// --- Middlewares d'authentification / autorisation ---
interface AuthRequest extends express.Request {
  user?: { id: string; role: string };
}

const requireAuth: express.RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentification requise' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { id: string; role: string };
    (req as AuthRequest).user = { id: payload.id, role: payload.role };
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée ou invalide' });
  }
};

const requireAdmin: express.RequestHandler = (req, res, next) => {
  if ((req as AuthRequest).user?.role !== 'ADMIN') {
    res.status(403).json({ error: 'Accès réservé aux administrateurs' });
    return;
  }
  next();
};

// Express 5 type les valeurs de req.params comme `string | string[]`. Nos routes
// n'utilisent que des paramètres simples (:id) : on en extrait toujours une string.
function paramId(req: express.Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}

// Convertit récursivement les Decimal Prisma en nombres pour la sérialisation JSON
// (sinon ils seraient sérialisés en chaînes côté client). Les montants sont stockés
// en Decimal (précis) en base, et exposés en `number` à l'API.
function decimalToNumber(value: any): any {
  if (value === null || value === undefined) return value;
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toNumber();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(decimalToNumber);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = decimalToNumber(value[key]);
    }
    return out;
  }
  return value;
}

// --- Paramètres globaux (singleton) ---
interface Parametres { margeCommercialeActive: boolean }

// Retourne les paramètres avec les Decimal convertis en nombres.
// upsert atomique (INSERT ... ON CONFLICT) pour éviter toute race entre requêtes
// concurrentes au premier chargement (deux créations simultanées du singleton).
async function getParametres(): Promise<Parametres> {
  const p = await prisma.parametres.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  });
  return decimalToNumber(p) as Parametres;
}

// --- Calcul centralisé des métriques d'un chantier (source unique de vérité) ---
// La marge commerciale n'est calculée que pour les admins ET si elle est activée.
function computeChantierMetrics(chantier: any, params: Parametres, isAdmin: boolean) {
  const achats: any[] = chantier.achats || [];
  const pointages: any[] = chantier.pointages || [];

  const materielReel = achats.reduce((s: number, a: any) => s + a.montantHT, 0);
  let heuresRealisees = 0;
  let moReel = 0;
  for (const p of pointages) {
    heuresRealisees += p.nbrHeures;
    moReel += p.nbrHeures * p.tauxHoraireApplique;
  }
  const totalDepenses = materielReel + moReel;
  const diffHeures = chantier.heuresVendues - heuresRealisees;
  const pctMateriel = chantier.budgetMaterielVendu > 0 ? (materielReel / chantier.budgetMaterielVendu) * 100 : 0;
  const pctHeures = chantier.heuresVendues > 0 ? (heuresRealisees / chantier.heuresVendues) * 100 : 0;

  const base = { materielReel, moReel, totalDepenses, heuresRealisees, diffHeures, pctMateriel, pctHeures };

  if (!isAdmin || !params.margeCommercialeActive) {
    return { ...base, tauxCommission: null, commission: null, margeBrute: null, margeCommerciale: null, margeNette: null, margePct: null };
  }

  // Marge commerciale = budget vendu − dépenses réelles (matériel + main d'œuvre).
  const margeBrute = chantier.budgetGlobalVendu - totalDepenses;
  const margeCommerciale = margeBrute;

  // Commission du conducteur = POURCENTAGE de la marge commerciale (plus aucun €/h).
  // Le taux de base (tauxFixe) s'applique toujours ; en mode DYNAMIQUE il est ajusté :
  // bonus si le chantier est en avance sur les heures, malus s'il est en retard.
  const comm = chantier.commissionnement;
  let tauxCommission = comm ? comm.tauxFixe : 0;
  if (comm && comm.mode === 'DYNAMIQUE') {
    if (diffHeures > 0) tauxCommission += comm.bonusHeure;       // en avance -> bonus
    else if (diffHeures < 0) tauxCommission -= comm.malusHeure;  // en retard -> malus
  }
  tauxCommission = Math.min(100, Math.max(0, tauxCommission));    // borné à [0 %, 100 %]
  const commission = margeCommerciale > 0 ? margeCommerciale * (tauxCommission / 100) : 0;
  const margeNette = margeCommerciale - commission;               // marge après commission versée
  const margePct = chantier.budgetGlobalVendu > 0 ? (margeCommerciale / chantier.budgetGlobalVendu) * 100 : 0;

  return { ...base, tauxCommission, commission, margeBrute, margeCommerciale, margeNette, margePct };
}

// Sérialise un chantier pour le client en masquant les données commerciales aux non-admins.
function serializeChantier(chantier: any, params: Parametres, isAdmin: boolean) {
  const c = decimalToNumber(chantier);
  return {
    ...c,
    budgetGlobalVendu: isAdmin ? c.budgetGlobalVendu : null,
    commissionnement: isAdmin ? c.commissionnement : null,
    metrics: computeChantierMetrics(c, params, isAdmin),
  };
}

// Configuration Multer pour le stockage local des photos
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Servir statiquement le dossier uploads
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 Mo max par fichier
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Seules les images sont autorisées.'));
  }
});

// Wrapper pour transformer les erreurs Multer (taille/type) en réponses JSON propres
const uploadPhoto: express.RequestHandler = (req, res, next) => {
  upload.single('photo')(req, res, (err: unknown) => {
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Upload invalide' });
      return;
    }
    next();
  });
};

// Routes de base (publiques)
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Configuration globale (publique : état de l'IA et paramètres SSO côté client).
// clientId et tenantId ne sont PAS secrets pour une SPA MSAL (ils figurent dans le
// bundle front) : on peut les exposer pour configurer la connexion Microsoft.
app.get('/api/config', (req, res) => {
  res.json({
    aiEnabled: !!process.env.GEMINI_API_KEY,
    ssoConfigured: SSO_CONFIGURED,
    ssoClientId: AZURE_CLIENT_ID || null,
    ssoTenantId: AZURE_TENANT_ID || null,
  });
});

// Auth Login (publique)
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });

    if (!user || !user.password) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
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
    res.json({ token, user });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la connexion SSO' });
  }
});

// Champs publics d'un responsable (jamais le hash de mot de passe).
const RESPONSABLE_SELECT = { select: { id: true, name: true, email: true, role: true } } as const;

// Chantiers
app.get('/api/chantiers', requireAuth, async (req, res) => {
  try {
    const isAdmin = (req as AuthRequest).user?.role === 'ADMIN';
    const params = await getParametres();
    const chantiers = await prisma.chantier.findMany({
      include: {
        responsable: RESPONSABLE_SELECT,
        achats: true,
        pointages: true,
        photos: true,
        commissionnement: true
      }
    });
    res.json(chantiers.map((c: any) => serializeChantier(c, params, isAdmin)));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching chantiers' });
  }
});

// Détail d'un chantier : mêmes métriques que la liste, enrichies des relations
// nécessaires aux répartitions (achats par catégorie/fournisseur, heures par
// intervenant) et triées de la plus récente à la plus ancienne pour les journaux.
app.get('/api/chantiers/:id', requireAuth, async (req, res) => {
  try {
    const isAdmin = (req as AuthRequest).user?.role === 'ADMIN';
    const params = await getParametres();
    const chantier = await prisma.chantier.findUnique({
      where: { id: paramId(req) },
      include: {
        responsable: RESPONSABLE_SELECT,
        achats: { include: { categorie: true, fournisseur: true }, orderBy: { date: 'desc' } },
        pointages: { include: { intervenant: true }, orderBy: { date: 'desc' } },
        photos: { orderBy: { createdAt: 'desc' } },
        commissionnement: true
      }
    });
    if (!chantier) return res.status(404).json({ error: 'Chantier introuvable' });
    res.json(serializeChantier(chantier, params, isAdmin));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching chantier' });
  }
});

app.post('/api/chantiers', requireAuth, async (req, res) => {
  try {
    const authUser = (req as AuthRequest).user!;
    // Un conducteur qui crée un chantier en devient automatiquement le responsable ;
    // un admin peut désigner librement le responsable (ou aucun).
    const responsableId = authUser.role === 'ADMIN' ? (req.body.responsableId || null) : authUser.id;
    const chantier = await prisma.chantier.create({
      data: {
        nom: req.body.nom,
        client: req.body.client,
        numeroDevis: req.body.numeroDevis,
        dateDebut: new Date(req.body.dateDebut).toISOString(),
        dateFin: req.body.dateFin ? new Date(req.body.dateFin).toISOString() : null,
        budgetGlobalVendu: parseFloat(req.body.budgetGlobalVendu) || 0,
        budgetMaterielVendu: parseFloat(req.body.budgetMaterielVendu) || 0,
        budgetMainOeuvreVendu: parseFloat(req.body.budgetMainOeuvreVendu) || 0,
        heuresVendues: parseFloat(req.body.heuresVendues) || 0,
        responsableId,
        statut: req.body.statut || "EN_COURS"
      },
    });
    // Create default commissionnement
    await prisma.commissionnement.create({
      data: { chantierId: chantier.id }
    });
    res.json(chantier);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error creating chantier' });
  }
});

// Update Chantier (pour le statut, le budget, etc.) — champs en liste blanche (anti mass-assignment)
app.patch('/api/chantiers/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const allowed = ['nom', 'client', 'numeroDevis', 'statut', 'responsableId'];
    const numericFields = ['budgetGlobalVendu', 'budgetMaterielVendu', 'budgetMainOeuvreVendu', 'heuresVendues'];
    const dateFields = ['dateDebut', 'dateFin'];

    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in req.body) data[key] = req.body[key];
    }
    for (const key of numericFields) {
      if (key in req.body) data[key] = parseFloat(req.body[key]) || 0;
    }
    for (const key of dateFields) {
      if (key in req.body && req.body[key]) data[key] = new Date(req.body[key]).toISOString();
    }

    const chantier = await prisma.chantier.update({
      where: { id: paramId(req) },
      data
    });
    res.json(chantier);
  } catch (error) {
    res.status(500).json({ error: 'Error updating chantier' });
  }
});

// Users (administration réservée aux admins)
// La liste des comptes EST la liste blanche d'autorisation SSO : seuls les emails
// présents ici peuvent se connecter (via SSO Microsoft ou en local si un mot de passe
// est défini). `hasPassword` distingue un compte local (mot de passe) d'un compte
// autorisé SSO uniquement (sans mot de passe).
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, name: true, email: true, role: true, password: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users.map((u: { id: string; name: string; email: string; role: string; password: string | null }) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, hasPassword: !!u.password,
    })));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching users' });
  }
});

// Autorise un nouveau compte à se connecter (liste blanche SSO / création de compte).
// Aucun mot de passe n'est défini : le compte se connecte via le SSO Microsoft. Un
// administrateur peut ensuite lui attribuer un mot de passe local via « Changer Mdp ».
app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const name = String(req.body.name ?? '').trim();
    const role = req.body.role === 'ADMIN' ? 'ADMIN' : 'CONDUCTEUR_TRAVAUX';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse email invalide.' });
    }
    if (!name) {
      return res.status(400).json({ error: 'Le nom est requis.' });
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'Un compte existe déjà pour cet email.' });
    }
    const user = await prisma.user.create({
      data: { email, name, role }, // pas de mot de passe : accès via SSO Microsoft
      select: { id: true, name: true, email: true, role: true },
    });
    res.status(201).json({ ...user, hasPassword: false });
  } catch (error) {
    res.status(500).json({ error: 'Error creating user' });
  }
});

// Révoque un compte (retire l'autorisation d'accès). Les références nullables
// (chantiers dont il est responsable, photos qu'il a prises) sont détachées d'abord.
app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = paramId(req);
    if (id === (req as AuthRequest).user?.id) {
      return res.status(403).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
    }
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }
    await prisma.$transaction([
      prisma.chantier.updateMany({ where: { responsableId: id }, data: { responsableId: null } }),
      prisma.photoChantier.updateMany({ where: { auteurId: id }, data: { auteurId: null } }),
      prisma.user.delete({ where: { id } }),
    ]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting user' });
  }
});

app.patch('/api/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    if (role !== 'ADMIN' && role !== 'CONDUCTEUR_TRAVAUX') {
      return res.status(400).json({ error: 'Rôle invalide' });
    }
    const user = await prisma.user.update({
      where: { id: paramId(req) },
      data: { role },
      select: { id: true, name: true, email: true, role: true }
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Error updating user role' });
  }
});

app.put('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères.' });
    }
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: paramId(req) },
      data: { password: hashedPassword }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error updating password' });
  }
});

// Intervenants
app.get('/api/intervenants', requireAuth, async (req, res) => {
  try {
    res.json(decimalToNumber(await prisma.intervenant.findMany()));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching intervenants' });
  }
});

app.post('/api/intervenants', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await prisma.intervenant.create({
      data: {
        nom: req.body.nom,
        role: req.body.role,
        tauxHoraireCharge: parseFloat(req.body.tauxHoraireCharge)
      }
    }));
  } catch (error) {
    res.status(500).json({ error: 'Error creating intervenant' });
  }
});

// Modifier un intervenant (nom, fonction, coût horaire). Le nouveau taux ne s'applique
// qu'aux pointages FUTURS : les pointages passés conservent le taux figé au moment de la saisie.
app.put('/api/intervenants/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data: Record<string, unknown> = {};
    if (typeof req.body.nom === 'string' && req.body.nom.trim()) data.nom = req.body.nom.trim();
    if (typeof req.body.role === 'string' && req.body.role.trim()) data.role = req.body.role.trim();
    if (req.body.tauxHoraireCharge !== undefined) data.tauxHoraireCharge = parseFloat(req.body.tauxHoraireCharge) || 0;
    const intervenant = await prisma.intervenant.update({ where: { id: paramId(req) }, data });
    res.json(decimalToNumber(intervenant));
  } catch (error) {
    res.status(500).json({ error: 'Error updating intervenant' });
  }
});

// Supprimer un intervenant. Bloqué s'il possède des pointages (historique préservé).
app.delete('/api/intervenants/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = paramId(req);
    const used = await prisma.pointageHeure.count({ where: { intervenantId: id } });
    if (used > 0) {
      return res.status(409).json({ error: `Suppression impossible : cet intervenant a ${used} pointage(s) d'heures dans l'historique.` });
    }
    await prisma.intervenant.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting intervenant' });
  }
});

// Categories & Fournisseurs
app.get('/api/categories', requireAuth, async (req, res) => res.json(await prisma.categorie.findMany({ orderBy: { nom: 'asc' } })));
app.post('/api/categories', requireAuth, requireAdmin, async (req, res) => res.json(await prisma.categorie.create({ data: { nom: req.body.nom, description: req.body.description || null } })));

// Modifier une catégorie (nom, description).
app.put('/api/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data: Record<string, unknown> = {};
    if (typeof req.body.nom === 'string' && req.body.nom.trim()) data.nom = req.body.nom.trim();
    if ('description' in req.body) data.description = req.body.description || null;
    res.json(await prisma.categorie.update({ where: { id: paramId(req) }, data }));
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Une catégorie porte déjà ce nom.' });
    res.status(500).json({ error: 'Error updating categorie' });
  }
});

// Supprimer une catégorie. Bloqué si des achats ou lignes de budget l'utilisent.
app.delete('/api/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = paramId(req);
    const achats = await prisma.achatReel.count({ where: { categorieId: id } });
    const lignes = await prisma.ligneBudgetPrevisionnel.count({ where: { categorieId: id } });
    if (achats + lignes > 0) {
      return res.status(409).json({ error: `Suppression impossible : ${achats} achat(s) et ${lignes} ligne(s) de budget utilisent cette catégorie.` });
    }
    await prisma.categorie.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting categorie' });
  }
});

app.get('/api/fournisseurs', requireAuth, async (req, res) => res.json(await prisma.fournisseur.findMany({ orderBy: { nom: 'asc' } })));
app.post('/api/fournisseurs', requireAuth, async (req, res) => res.json(await prisma.fournisseur.create({ data: { nom: req.body.nom, contact: req.body.contact || null } })));

// Modifier un fournisseur (nom, contact).
app.put('/api/fournisseurs/:id', requireAuth, async (req, res) => {
  try {
    const data: Record<string, unknown> = {};
    if (typeof req.body.nom === 'string' && req.body.nom.trim()) data.nom = req.body.nom.trim();
    if ('contact' in req.body) data.contact = req.body.contact || null;
    res.json(await prisma.fournisseur.update({ where: { id: paramId(req) }, data }));
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Un fournisseur porte déjà ce nom.' });
    res.status(500).json({ error: 'Error updating fournisseur' });
  }
});

// Supprimer un fournisseur. Bloqué si des achats y sont rattachés (historique préservé).
app.delete('/api/fournisseurs/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = paramId(req);
    const used = await prisma.achatReel.count({ where: { fournisseurId: id } });
    if (used > 0) {
      return res.status(409).json({ error: `Suppression impossible : ${used} achat(s) sont rattachés à ce fournisseur.` });
    }
    await prisma.fournisseur.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting fournisseur' });
  }
});

// Achats
app.get('/api/achats', requireAuth, async (req, res) => {
  try {
    res.json(decimalToNumber(await prisma.achatReel.findMany({ include: { chantier: true, categorie: true, fournisseur: true } })));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching achats' });
  }
});

app.post('/api/achats', requireAuth, async (req, res) => {
  try {
    res.json(await prisma.achatReel.create({
      data: {
        date: new Date(req.body.date).toISOString(),
        fournisseurId: req.body.fournisseurId,
        numeroFacture: req.body.numeroFacture || null,
        description: req.body.description,
        montantHT: parseFloat(req.body.montantHT),
        chantierId: req.body.chantierId,
        categorieId: req.body.categorieId
      }
    }));
  } catch (error) {
    res.status(500).json({ error: 'Error creating achat' });
  }
});

// Pointages (Heures)
app.get('/api/heures', requireAuth, async (req, res) => {
  try {
    res.json(decimalToNumber(await prisma.pointageHeure.findMany({ include: { chantier: true, intervenant: true } })));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching heures' });
  }
});

app.post('/api/heures', requireAuth, async (req, res) => {
  try {
    const intervenant = await prisma.intervenant.findUnique({ where: { id: req.body.intervenantId } });
    if (!intervenant) return res.status(404).json({ error: 'Intervenant not found' });

    res.json(await prisma.pointageHeure.create({
      data: {
        date: new Date(req.body.date).toISOString(),
        intervenantId: req.body.intervenantId,
        chantierId: req.body.chantierId,
        nbrHeures: parseFloat(req.body.nbrHeures),
        tauxHoraireApplique: intervenant.tauxHoraireCharge,
        commentaire: req.body.commentaire || null
      }
    }));
  } catch (error) {
    res.status(500).json({ error: 'Error creating pointage' });
  }
});

// Photos Upload & Purge
app.post('/api/chantiers/:id/photos', requireAuth, uploadPhoto, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const url = `/uploads/${req.file.filename}`;
    const photo = await prisma.photoChantier.create({
      data: {
        url,
        legende: req.body.legende || '',
        chantierId: paramId(req),
        auteurId: (req as AuthRequest).user?.id || null
      }
    });
    res.json(photo);
  } catch (error) {
    res.status(500).json({ error: 'Error uploading photo' });
  }
});

app.delete('/api/chantiers/:id/photos/purge', requireAuth, requireAdmin, async (req, res) => {
  try {
    const photos = await prisma.photoChantier.findMany({ where: { chantierId: paramId(req) } });
    for (const p of photos) {
      const filePath = path.join(__dirname, p.url);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await prisma.photoChantier.deleteMany({ where: { chantierId: paramId(req) } });
    res.json({ message: 'Purge terminée' });
  } catch (error) {
    res.status(500).json({ error: 'Error purging photos' });
  }
});

app.get('/api/chantiers/:id/photos/export', requireAuth, async (req, res) => {
  try {
    const chantier = await prisma.chantier.findUnique({ where: { id: paramId(req) } });
    if (!chantier) return res.status(404).json({ error: 'Chantier not found' });

    const photos = await prisma.photoChantier.findMany({ where: { chantierId: paramId(req) } });

    res.attachment(`photos-${chantier.nom.replace(/\s+/g, '_')}.zip`);
    // @ts-ignore — typage de la lib archiver variable selon les versions (export = function)
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    for (const p of photos) {
      const filePath = path.join(__dirname, p.url);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: path.basename(filePath) });
      }
    }
    await archive.finalize();
  } catch (error) {
    res.status(500).json({ error: 'Error exporting photos' });
  }
});

// Commissionnement (réservé aux admins) — champs en liste blanche
app.put('/api/chantiers/:id/commissionnement', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = {
      mode: req.body.mode === 'DYNAMIQUE' ? 'DYNAMIQUE' : 'FIXE',
      tauxFixe: parseFloat(req.body.tauxFixe) || 0,
      bonusHeure: parseFloat(req.body.bonusHeure) || 0,
      malusHeure: parseFloat(req.body.malusHeure) || 0
    };
    const comm = await prisma.commissionnement.upsert({
      where: { chantierId: paramId(req) },
      update: data,
      create: { ...data, chantierId: paramId(req) }
    });
    res.json(comm);
  } catch (error) {
    res.status(500).json({ error: 'Error updating commissionnement' });
  }
});

// Paramètres globaux (admin uniquement)
app.get('/api/parametres', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await getParametres());
  } catch (error) {
    res.status(500).json({ error: 'Error fetching parametres' });
  }
});

app.put('/api/parametres', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = {
      margeCommercialeActive: !!req.body.margeCommercialeActive,
    };
    const p = await prisma.parametres.upsert({
      where: { id: 'singleton' },
      update: data,
      create: { id: 'singleton', ...data },
    });
    res.json(decimalToNumber(p));
  } catch (error) {
    res.status(500).json({ error: 'Error updating parametres' });
  }
});

// Statistiques globales (agrégées côté serveur, périmètre selon le rôle)
app.get('/api/stats/global', requireAuth, async (req, res) => {
  try {
    const user = (req as AuthRequest).user!;
    const isAdmin = user.role === 'ADMIN';
    const params = await getParametres();
    // Un conducteur ne voit que les chantiers dont il est responsable.
    const where = isAdmin ? {} : { responsableId: user.id };
    const chantiers = decimalToNumber(await prisma.chantier.findMany({
      where,
      include: { achats: true, pointages: true, commissionnement: true },
    }));

    let nbEnCours = 0;
    let nbTermines = 0;
    let materielReel = 0;
    let moReel = 0;
    let heuresVendues = 0;
    let heuresRealisees = 0;
    let caTotal = 0;
    let depensesTotal = 0;
    let margeTotal = 0;

    for (const c of chantiers) {
      if (c.statut === 'EN_COURS') nbEnCours++;
      else if (c.statut === 'TERMINE') nbTermines++;
      const m = computeChantierMetrics(c, params, isAdmin);
      materielReel += m.materielReel;
      moReel += m.moReel;
      heuresRealisees += m.heuresRealisees;
      heuresVendues += c.heuresVendues;
      depensesTotal += m.totalDepenses;
      if (isAdmin) {
        caTotal += c.budgetGlobalVendu;
        margeTotal += m.margeCommerciale ?? 0;
      }
    }

    const result: Record<string, unknown> = {
      nbChantiers: chantiers.length,
      nbEnCours,
      nbTermines,
      materielReel,
      moReel,
      depensesTotal,
      heuresVendues,
      heuresRealisees,
      tauxRemplissageHeures: heuresVendues > 0 ? (heuresRealisees / heuresVendues) * 100 : 0,
    };
    if (isAdmin && params.margeCommercialeActive) {
      result.caTotal = caTotal;
      result.margeTotal = margeTotal;
      result.margePct = caTotal > 0 ? (margeTotal / caTotal) * 100 : 0;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Error computing global stats' });
  }
});

// Statistiques par conducteur de travaux (admin uniquement, classées par marge générée)
app.get('/api/stats/conducteurs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const params = await getParametres();
    const users = await prisma.user.findMany({ select: { id: true, name: true, email: true } });
    const chantiers = decimalToNumber(await prisma.chantier.findMany({
      include: { achats: true, pointages: true, commissionnement: true },
    }));

    const byUser: Record<string, any> = {};
    for (const u of users) {
      byUser[u.id] = {
        id: u.id, name: u.name, email: u.email,
        nbChantiers: 0, caTotal: 0, depensesTotal: 0, margeTotal: 0,
        heuresVendues: 0, heuresRealisees: 0,
      };
    }

    for (const c of chantiers) {
      if (!c.responsableId || !byUser[c.responsableId]) continue;
      const agg = byUser[c.responsableId];
      const m = computeChantierMetrics(c, params, true);
      agg.nbChantiers++;
      agg.caTotal += c.budgetGlobalVendu;
      agg.depensesTotal += m.totalDepenses;
      agg.margeTotal += m.margeCommerciale ?? (c.budgetGlobalVendu - m.totalDepenses);
      agg.heuresVendues += c.heuresVendues;
      agg.heuresRealisees += m.heuresRealisees;
    }

    const list = Object.values(byUser)
      .filter((a: any) => a.nbChantiers > 0)
      .map((a: any) => ({
        ...a,
        margePct: a.caTotal > 0 ? (a.margeTotal / a.caTotal) * 100 : 0,
        tauxRemplissageHeures: a.heuresVendues > 0 ? (a.heuresRealisees / a.heuresVendues) * 100 : 0,
      }))
      .sort((x: any, y: any) => y.margeTotal - x.margeTotal);

    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Error computing conducteurs stats' });
  }
});

// IA Analysis
app.post('/api/chantiers/:id/analyze', requireAuth, async (req, res) => {
  try {
    if (!ai) {
      return res.status(403).json({ error: "L'IA n'est pas activée (GEMINI_API_KEY manquante)." });
    }

    // Collect all data for the prompt
    const chantierRaw = await prisma.chantier.findUnique({
      where: { id: paramId(req) },
      include: { pointages: { include: { intervenant: true } }, achats: true }
    });

    if (!chantierRaw) return res.status(404).json({ error: 'Chantier introuvable' });

    const chantier = decimalToNumber(chantierRaw);
    let heuresRealisees = 0;
    chantier.pointages.forEach((p: { nbrHeures: number }) => heuresRealisees += p.nbrHeures);
    const totalAchats = chantier.achats.reduce((acc: number, a: { montantHT: number }) => acc + a.montantHT, 0);

    const prompt = `En tant qu'expert en gestion de chantier, analyse ce dossier:
Nom: ${chantier.nom} (Client: ${chantier.client})
Statut: ${chantier.statut}
Budget Vendu: ${chantier.budgetGlobalVendu} €
Budget Matériel Prévu: ${chantier.budgetMaterielVendu} € / Réel: ${totalAchats} €
Heures Prévues: ${chantier.heuresVendues} h / Réelles: ${heuresRealisees} h

Rédige un compte-rendu exécutif d'environ 150-200 mots résumant la situation financière (marge brute), l'avancement temporel, et donne 1 ou 2 recommandations concrètes pour le conducteur de travaux. Utilise un formatage Markdown propre et professionnel.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    res.json({ report: response.text });
  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ error: 'Erreur lors de la génération IA' });
  }
});

// Initialisation BDD (Seeding)
const initDb = async () => {
  // Garantit l'existence de la ligne de paramètres (singleton) dès le démarrage.
  await prisma.parametres.upsert({ where: { id: 'singleton' }, update: {}, create: { id: 'singleton' } });

  const users = await prisma.user.findMany();
  if (users.length === 0) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@noxia.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Administrateur',
        role: 'ADMIN',
        password: hashedPassword
      }
    });
    console.log(`Compte administrateur créé : ${adminEmail}`);

    // Créer un conducteur factice pour tester
    await prisma.user.create({
      data: {
        email: 'jean@noxia.com',
        name: 'Jean Dupont (Conducteur)',
        role: 'CONDUCTEUR_TRAVAUX',
        password: await bcrypt.hash('conducteur123', 10)
      }
    });
  }
};

app.listen(port, async () => {
  await initDb();
  console.log(`Server running on port ${port}`);
});
