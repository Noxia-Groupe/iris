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
import { odooConfigured, odooSearchClients, odooSearchDevis, odooDevisMateriel, odooDevisAdresse } from './odoo';

dotenv.config();

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const app = express();
const prisma = new PrismaClient();
const port = process.env.PORT || 3001;

// Ne pas révéler la techno serveur (en-tête `X-Powered-By: Express`).
app.disable('x-powered-by');

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
    select: { id: true, name: true, email: true, role: true, theme: true },
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

// Le jeton n'authentifie QUE l'identité : le rôle est systématiquement relu en base, il
// n'est jamais repris du jeton. Un changement de droits (promotion superadmin au démarrage,
// rétrogradation décidée par la direction, révocation d'un compte) prend ainsi effet à la
// requête suivante, sans attendre l'expiration du jeton (7 jours) ni une reconnexion.
const requireAuth: express.RequestHandler = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentification requise' });
    return;
  }
  let payload: { id: string };
  try {
    payload = jwt.verify(header.slice(7), JWT_SECRET) as { id: string; role: string };
  } catch {
    res.status(401).json({ error: 'Session expirée ou invalide' });
    return;
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: payload.id }, select: { id: true, role: true } });
    if (!user) {
      res.status(401).json({ error: 'Compte introuvable ou révoqué' });
      return;
    }
    (req as AuthRequest).user = { id: user.id, role: user.role };
    next();
  } catch {
    res.status(500).json({ error: 'Error resolving authenticated user' });
  }
};

// --- Rôles de l'application ---
// SUPERADMIN : rôle « direction ». Il possède TOUS les droits d'un ADMIN (cf. isAdminRole,
// utilisé partout où l'application testait jusqu'ici `role === 'ADMIN'`) et, EN PLUS, les
// réglages qui lui sont réservés : gestion des comptes SUPERADMIN et activation ou
// désactivation des modules de l'application (cf. Parametres.planningActif). Un ADMIN ne
// peut ni se promouvoir superadmin, ni modifier/supprimer un compte superadmin — sans quoi
// la séparation entre les deux rôles n'aurait aucune valeur.
const ROLE_SUPERADMIN = 'SUPERADMIN';

function isAdminRole(role: string | undefined | null): boolean {
  return role === 'ADMIN' || role === ROLE_SUPERADMIN;
}
function isSuperAdminRole(role: string | undefined | null): boolean {
  return role === ROLE_SUPERADMIN;
}

const requireAdmin: express.RequestHandler = (req, res, next) => {
  if (!isAdminRole((req as AuthRequest).user?.role)) {
    res.status(403).json({ error: 'Accès réservé aux administrateurs' });
    return;
  }
  next();
};

// Réglages réservés au superadmin (modules de l'application, comptes superadmin).
const requireSuperAdmin: express.RequestHandler = (req, res, next) => {
  if (!isSuperAdminRole((req as AuthRequest).user?.role)) {
    res.status(403).json({ error: 'Accès réservé au super administrateur' });
    return;
  }
  next();
};

// Un commercial a un accès strictement en lecture à ses propres chantiers : ni création,
// ni modification (chantiers, achats, heures, photos), et pas d'accès aux statistiques
// globales/conducteur — uniquement à son propre résultat commercial.
const blockCommercial: express.RequestHandler = (req, res, next) => {
  if ((req as AuthRequest).user?.role === 'COMMERCIAL') {
    res.status(403).json({ error: 'Accès non autorisé pour un compte commercial.' });
    return;
  }
  next();
};

// Un administrateur peut être marqué "estCommercial" : il garde alors tous les droits
// d'administration (blockCommercial ne le concerne pas, il reste role === 'ADMIN'), mais
// apparaît EN PLUS comme un commercial pour l'affectation aux chantiers et les
// statistiques/marges de "Mes commerciaux" — au même titre qu'un compte de rôle
// COMMERCIAL. isCommercialLike() et COMMERCIAL_OR_FILTER couvrent les deux cas partout où
// l'appli devait jusqu'ici filtrer strictement sur role === 'COMMERCIAL'.
function isCommercialLike(u: { role: string; estCommercial?: boolean | null }): boolean {
  return u.role === 'COMMERCIAL' || (isAdminRole(u.role) && !!u.estCommercial);
}
const COMMERCIAL_OR_FILTER = [
  { role: 'COMMERCIAL' },
  { role: 'ADMIN', estCommercial: true },
  { role: ROLE_SUPERADMIN, estCommercial: true },
];

// Module Planning : quand un SUPERADMIN le désactive (Parametres.planningActif = false),
// il disparaît pour TOUS les autres comptes, administrateurs compris. Le blocage est ici,
// côté serveur — masquer le menu côté client ne serait qu'un habillage, l'API resterait
// appelable. Les données ne sont jamais supprimées : la réactivation restitue le planning
// tel quel. Ne s'applique pas au lien de partage public (cf. GET /api/planning/public/:token),
// qui garde son propre interrupteur (PlanningPublicShare.active).
const requirePlanningActif: express.RequestHandler = async (req, res, next) => {
  try {
    if (isSuperAdminRole((req as AuthRequest).user?.role)) return next();
    const { planningActif } = await getParametres();
    if (!planningActif) {
      res.status(403).json({ code: 'PLANNING_DESACTIVE', error: "Le module Planning est désactivé par l'administration." });
      return;
    }
    next();
  } catch (error) {
    res.status(500).json({ error: 'Error checking planning module' });
  }
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
interface Parametres { margeCommercialeActive: boolean; planningActif: boolean }

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
// La marge commerciale n'est calculée que si elle est activée ET pour les profils
// autorisés à la voir (admin partout ; conducteur responsable sur SA fiche chantier
// uniquement, cf. GET /api/chantiers/:id — pas sur la liste ni le tableau de bord).
function computeChantierMetrics(chantier: any, params: Parametres, canSeeMarge: boolean) {
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

  if (!canSeeMarge || !params.margeCommercialeActive) {
    return { ...base, margeBrute: null, margeCommerciale: null, margePct: null };
  }

  // Marge commerciale = budget vendu − dépenses réelles (matériel + main d'œuvre).
  // Il n'y a pas de variable sur cette marge pour les conducteurs de travaux (voir la
  // marge ne leur ouvre droit à rien) : seuls les commerciaux ont une rémunération
  // variable, calculée à part sur le barème progressif mensuel du "Système de
  // rémunération commerciale" (cf. BAREME_COMMERCIAL_* et
  // computeCommissionsParCommercial, utilisés par /api/stats/commerciaux) — sur la
  // marge cumulée du mois du commercial, pas chantier par chantier.
  const margeBrute = chantier.budgetGlobalVendu - totalDepenses;
  const margeCommerciale = margeBrute;
  const margePct = chantier.budgetGlobalVendu > 0 ? (margeCommerciale / chantier.budgetGlobalVendu) * 100 : 0;

  return { ...base, margeBrute, margeCommerciale, margePct };
}

// Sérialise un chantier pour le client en masquant les données commerciales aux profils
// non autorisés à les voir (cf. canSeeMarge ci-dessus).
function serializeChantier(chantier: any, params: Parametres, canSeeMarge: boolean) {
  const c = decimalToNumber(chantier);
  return {
    ...c,
    budgetGlobalVendu: canSeeMarge ? c.budgetGlobalVendu : null,
    metrics: computeChantierMetrics(c, params, canSeeMarge),
  };
}

// Configuration Multer pour le stockage local des photos.
// process.cwd() (et non __dirname) : le code compilé tourne depuis dist/ (__dirname y
// pointerait), alors que le volume Docker persistant est monté sur le répertoire de travail
// du conteneur (/app) — avec __dirname, les photos étaient écrites hors du volume et
// disparaissaient à chaque redéploiement (conteneur recréé).
const uploadDir = path.join(process.cwd(), 'uploads');
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
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, theme: user.theme } });
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

// Compte connecté, tel qu'il est EN BASE à l'instant présent. Le client s'en sert pour
// resynchroniser le rôle qu'il a mémorisé à la connexion : sans cela, une promotion (ou
// une rétrogradation) resterait invisible dans les menus jusqu'à la prochaine connexion,
// alors que l'API, elle, applique déjà les nouveaux droits (cf. requireAuth).
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const authUser = (req as AuthRequest).user!;
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { id: true, name: true, email: true, role: true, theme: true },
    });
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
    res.json(user);
  } catch (error) {
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

// Champs publics d'un responsable ou d'un commercial rattaché à un chantier : jamais le
// hash de mot de passe, et jamais le rôle non plus — l'application n'en a pas l'usage ici,
// et un commercial rattaché peut être un super administrateur, dont le rôle ne doit pas
// transparaître dans les données d'un chantier renvoyées à un simple administrateur.
const RESPONSABLE_SELECT = { select: { id: true, name: true, email: true } } as const;

// Types de chantier (liste fermée, plusieurs possibles par chantier) — sert aussi de
// liste blanche pour ne jamais stocker de valeur arbitraire envoyée par le client.
const TYPES_CHANTIER = ['Vidéo', 'Alarme', "Contrôle d'accès", 'Interphonie', 'Câblage réseau'];
function sanitizeTypes(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : input ? [input] : [];
  return TYPES_CHANTIER.filter((t) => arr.includes(t));
}

// Recherche de clients Odoo (lecture seule, cf. odoo.ts) pour le champ "Client" d'un
// chantier. Ne renvoie jamais d'erreur HTTP : odooAvailable:false (Odoo non configuré,
// injoignable, ou en erreur) laisse simplement l'utilisateur saisir le client en texte
// libre côté client, sans qu'aucune donnée ne soit jamais écrite dans Odoo.
app.get('/api/odoo/clients', requireAuth, async (req, res) => {
  if (!odooConfigured()) return res.json({ odooAvailable: false, clients: [] });
  try {
    const clients = await odooSearchClients(String(req.query.q || ''), 20);
    res.json({ odooAvailable: true, clients });
  } catch (error) {
    console.error('Odoo search error:', error);
    res.json({ odooAvailable: false, clients: [] });
  }
});

// Recherche de devis Odoo (lecture seule, cf. odoo.ts) pour préremplir le budget global
// vendu (HT) d'un chantier à partir de son numéro de devis. Même contrat que
// /api/odoo/clients ci-dessus : jamais d'erreur HTTP, odooAvailable:false si indisponible,
// l'utilisateur reste libre de saisir le numéro et le montant à la main.
// partnerId (optionnel) restreint aux devis du client Odoo déjà sélectionné dans le
// formulaire, pour ne pas faire chercher le bon devis dans toute la base — la saisie
// libre du numéro reste toujours possible, filtrée ou non.
app.get('/api/odoo/devis', requireAuth, async (req, res) => {
  if (!odooConfigured()) return res.json({ odooAvailable: false, devis: [] });
  try {
    const partnerId = req.query.partnerId ? Number(req.query.partnerId) : undefined;
    const devis = await odooSearchDevis(String(req.query.q || ''), 20, partnerId && !Number.isNaN(partnerId) ? partnerId : undefined);
    res.json({ odooAvailable: true, devis });
  } catch (error) {
    console.error('Odoo search error (devis):', error);
    res.json({ odooAvailable: false, devis: [] });
  }
});

// Sous-total de la section "Matériel" d'un devis Odoo (lecture seule, cf.
// odoo.ts:odooDevisMateriel) pour préremplir le champ "Dont Matériel" d'un chantier une
// fois un devis sélectionné. Même contrat que les routes Odoo ci-dessus : jamais d'erreur
// HTTP, montantMateriel:null si indisponible ou si le devis n'a pas de section "Matériel"
// — l'utilisateur reste libre de saisir/corriger le montant à la main.
app.get('/api/odoo/devis/:id/materiel', requireAuth, async (req, res) => {
  if (!odooConfigured()) return res.json({ odooAvailable: false, montantMateriel: null });
  try {
    const devisId = Number(req.params.id);
    if (Number.isNaN(devisId)) return res.json({ odooAvailable: false, montantMateriel: null });
    const montantMateriel = await odooDevisMateriel(devisId);
    res.json({ odooAvailable: true, montantMateriel });
  } catch (error) {
    console.error('Odoo search error (devis materiel):', error);
    res.json({ odooAvailable: false, montantMateriel: null });
  }
});

// Adresse du site d'un devis Odoo (lecture seule, cf. odoo.ts:odooDevisAdresse) pour
// préremplir le champ "Adresse" d'un chantier une fois un devis sélectionné. Même contrat
// que les routes Odoo ci-dessus : jamais d'erreur HTTP, adresse:null si indisponible —
// l'utilisateur reste libre de saisir/corriger l'adresse à la main.
app.get('/api/odoo/devis/:id/adresse', requireAuth, async (req, res) => {
  if (!odooConfigured()) return res.json({ odooAvailable: false, adresse: null });
  try {
    const devisId = Number(req.params.id);
    if (Number.isNaN(devisId)) return res.json({ odooAvailable: false, adresse: null });
    const adresse = await odooDevisAdresse(devisId);
    res.json({ odooAvailable: true, adresse });
  } catch (error) {
    console.error('Odoo search error (devis adresse):', error);
    res.json({ odooAvailable: false, adresse: null });
  }
});

// Chantiers — un conducteur ne voit que les chantiers dont il est responsable ;
// un admin voit tout. Un chantier sans responsable reste invisible aux conducteurs
// jusqu'à ce qu'un admin lui en affecte un.
app.get('/api/chantiers', requireAuth, async (req, res) => {
  try {
    const authUser = (req as AuthRequest).user!;
    const isAdmin = isAdminRole(authUser.role);
    const params = await getParametres();
    const where = isAdmin
      ? {}
      : authUser.role === 'COMMERCIAL'
        ? { commercialId: authUser.id }
        : { responsableId: authUser.id };
    const chantiers = await prisma.chantier.findMany({
      where,
      include: {
        responsable: RESPONSABLE_SELECT,
        commercial: RESPONSABLE_SELECT,
        achats: true,
        pointages: true,
        photos: true,
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
    const authUser = (req as AuthRequest).user!;
    const isAdmin = isAdminRole(authUser.role);
    const params = await getParametres();
    const chantier = await prisma.chantier.findUnique({
      where: { id: paramId(req) },
      include: {
        responsable: RESPONSABLE_SELECT,
        commercial: RESPONSABLE_SELECT,
        achats: { include: { categorie: true, fournisseur: true }, orderBy: { date: 'desc' } },
        pointages: { include: { intervenant: true }, orderBy: { date: 'desc' } },
        photos: { orderBy: { createdAt: 'desc' } },
      }
    });
    // 404 (et non 403) pour un chantier auquel on n'est pas rattaché : on ne révèle pas son existence.
    const isOwner = !!chantier && (chantier.responsableId === authUser.id || chantier.commercialId === authUser.id);
    if (!chantier || (!isAdmin && !isOwner)) {
      return res.status(404).json({ error: 'Chantier introuvable' });
    }
    // Sur SA fiche chantier (pas sur la liste ni le tableau de bord), le conducteur
    // responsable voit désormais la marge commerciale et le budget vendu comme un admin —
    // pas le commercial, qui a sa propre vue "Résultat commercial" à l'échelle du mois.
    const canSeeMarge = isAdmin || (authUser.role === 'CONDUCTEUR_TRAVAUX' && chantier.responsableId === authUser.id);
    res.json(serializeChantier(chantier, params, canSeeMarge));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching chantier' });
  }
});

app.post('/api/chantiers', requireAuth, blockCommercial, async (req, res) => {
  try {
    const authUser = (req as AuthRequest).user!;
    const isAdmin = isAdminRole(authUser.role);
    // Un conducteur qui crée un chantier en devient automatiquement le responsable ;
    // un admin doit obligatoirement désigner un responsable (sinon le chantier créé
    // resterait invisible à tout conducteur, cf. filtrage ci-dessus).
    let responsableId: string;
    if (isAdmin) {
      responsableId = String(req.body.responsableId || '');
      if (!responsableId) {
        return res.status(400).json({ error: 'Veuillez sélectionner le conducteur responsable de ce chantier.' });
      }
      const responsable = await prisma.user.findUnique({ where: { id: responsableId } });
      if (!responsable) {
        return res.status(400).json({ error: 'Conducteur responsable introuvable.' });
      }
    } else {
      responsableId = authUser.id;
    }

    // Commercial rattaché : obligatoire dès la création (par l'admin ou le conducteur),
    // sauf si aucun compte commercial n'est encore autorisé dans l'application — sinon
    // la création de chantiers serait bloquée tant qu'aucun commercial n'existe.
    let commercialId: string | null = null;
    if (req.body.commercialId) {
      const commercial = await prisma.user.findUnique({ where: { id: String(req.body.commercialId) } });
      if (!commercial || !isCommercialLike(commercial)) {
        return res.status(400).json({ error: 'Commercial introuvable.' });
      }
      commercialId = commercial.id;
    } else if ((await prisma.user.count({ where: { OR: COMMERCIAL_OR_FILTER } })) > 0) {
      return res.status(400).json({ error: 'Veuillez sélectionner le commercial rattaché à ce chantier.' });
    }

    const numeroDevis = String(req.body.numeroDevis || '').trim();
    if (!numeroDevis) {
      return res.status(400).json({ error: 'Veuillez saisir le numéro de devis.' });
    }

    // Le type de chantier n'est pas un champ texte : au moins une case doit être cochée
    // (dossierNoxia est une case à part, non concernée par cette règle).
    const types = sanitizeTypes(req.body.types);
    if (types.length === 0) {
      return res.status(400).json({ error: 'Veuillez sélectionner au moins un type de chantier.' });
    }

    const chantier = await prisma.chantier.create({
      data: {
        nom: req.body.nom,
        client: req.body.client,
        adresse: String(req.body.adresse || '').trim() || null,
        numeroDevis,
        dateDebut: new Date(req.body.dateDebut).toISOString(),
        dateFin: req.body.dateFin ? new Date(req.body.dateFin).toISOString() : null,
        budgetGlobalVendu: parseFloat(req.body.budgetGlobalVendu) || 0,
        budgetMaterielVendu: parseFloat(req.body.budgetMaterielVendu) || 0,
        budgetMainOeuvreVendu: parseFloat(req.body.budgetMainOeuvreVendu) || 0,
        heuresVendues: parseFloat(req.body.heuresVendues) || 0,
        responsableId,
        commercialId,
        statut: req.body.statut || "EN_COURS",
        types,
        dossierNoxia: !!req.body.dossierNoxia,
      },
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
      if (key !== 'responsableId' && key !== 'numeroDevis' && key in req.body) data[key] = req.body[key];
    }
    // Le numéro de devis est obligatoire : on interdit de le vider.
    if ('numeroDevis' in req.body) {
      const numeroDevis = String(req.body.numeroDevis || '').trim();
      if (!numeroDevis) {
        return res.status(400).json({ error: 'Le numéro de devis est obligatoire.' });
      }
      data.numeroDevis = numeroDevis;
    }
    // Un chantier doit toujours avoir un responsable (les conducteurs ne voient que
    // leurs chantiers) : on interdit de le vider, et on vérifie qu'il existe.
    if ('responsableId' in req.body) {
      const responsableId = String(req.body.responsableId || '');
      if (!responsableId) {
        return res.status(400).json({ error: 'Un chantier doit toujours avoir un conducteur responsable.' });
      }
      const responsable = await prisma.user.findUnique({ where: { id: responsableId } });
      if (!responsable) {
        return res.status(400).json({ error: 'Conducteur responsable introuvable.' });
      }
      data.responsableId = responsableId;
    }
    for (const key of numericFields) {
      if (key in req.body) data[key] = parseFloat(req.body[key]) || 0;
    }
    for (const key of dateFields) {
      if (key in req.body && req.body[key]) data[key] = new Date(req.body[key]).toISOString();
    }
    // Facultative (contrairement au numéro de devis) : peut être vidée.
    if ('adresse' in req.body) data.adresse = String(req.body.adresse || '').trim() || null;
    if ('types' in req.body) data.types = sanitizeTypes(req.body.types);
    if ('dossierNoxia' in req.body) data.dossierNoxia = !!req.body.dossierNoxia;

    const chantier = await prisma.chantier.update({
      where: { id: paramId(req) },
      data
    });
    res.json(chantier);
  } catch (error) {
    res.status(500).json({ error: 'Error updating chantier' });
  }
});

// Clôture / réouverture d'un chantier. Un conducteur peut clôturer (uniquement
// clôturer, uniquement ses propres chantiers en cours) : une fois TERMINE, il ne
// peut plus y ajouter d'heures ou de dépenses (cf. POST /achats et /heures).
// Seul un admin peut réouvrir un chantier clôturé (repasser en EN_COURS).
app.patch('/api/chantiers/:id/statut', requireAuth, blockCommercial, async (req, res) => {
  try {
    const authUser = (req as AuthRequest).user!;
    const isAdmin = isAdminRole(authUser.role);
    const nextStatut = req.body.statut;
    if (nextStatut !== 'EN_COURS' && nextStatut !== 'TERMINE') {
      return res.status(400).json({ error: 'Statut invalide.' });
    }

    const chantier = await prisma.chantier.findUnique({ where: { id: paramId(req) } });
    if (!chantier || (!isAdmin && chantier.responsableId !== authUser.id)) {
      return res.status(404).json({ error: 'Chantier introuvable' });
    }

    if (!isAdmin && (nextStatut !== 'TERMINE' || chantier.statut !== 'EN_COURS')) {
      return res.status(403).json({ error: 'Seul un administrateur peut réouvrir un chantier clôturé.' });
    }

    // La date de clôture sert de mois de rattachement à la rémunération commerciale
    // (barème progressif + primes d'objectifs, cf. /api/stats/commerciaux) : on la
    // renseigne automatiquement à la clôture si elle n'a pas déjà été saisie à la main.
    const data: Record<string, unknown> = { statut: nextStatut };
    if (nextStatut === 'TERMINE' && !chantier.dateFin) {
      data.dateFin = new Date();
    }

    const updated = await prisma.chantier.update({ where: { id: chantier.id }, data });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Error updating chantier status' });
  }
});

// Affectation du commercial sur un chantier déjà créé — modifiable par l'admin ou par
// le conducteur responsable du chantier (pas par le commercial lui-même, ni par un tiers).
app.patch('/api/chantiers/:id/commercial', requireAuth, async (req, res) => {
  try {
    const authUser = (req as AuthRequest).user!;
    const isAdmin = isAdminRole(authUser.role);
    const chantier = await prisma.chantier.findUnique({ where: { id: paramId(req) } });
    if (!chantier) {
      return res.status(404).json({ error: 'Chantier introuvable' });
    }
    if (!isAdmin && chantier.responsableId !== authUser.id) {
      return res.status(403).json({ error: 'Action non autorisée' });
    }

    let commercialId: string | null = null;
    if (req.body.commercialId) {
      const commercial = await prisma.user.findUnique({ where: { id: String(req.body.commercialId) } });
      if (!commercial || !isCommercialLike(commercial)) {
        return res.status(400).json({ error: 'Commercial introuvable.' });
      }
      commercialId = commercial.id;
    } else if ((await prisma.user.count({ where: { OR: COMMERCIAL_OR_FILTER } })) > 0) {
      return res.status(400).json({ error: 'Un chantier doit toujours avoir un commercial rattaché.' });
    }

    const updated = await prisma.chantier.update({
      where: { id: chantier.id },
      data: { commercialId },
      include: { commercial: RESPONSABLE_SELECT },
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Error updating commercial' });
  }
});

// Users (administration réservée aux admins)
// La liste des comptes EST la liste blanche d'autorisation SSO : seuls les emails
// présents ici peuvent se connecter (via SSO Microsoft ou en local si un mot de passe
// est défini). `hasPassword` distingue un compte local (mot de passe) d'un compte
// autorisé SSO uniquement (sans mot de passe).
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Le rôle SUPERADMIN n'existe pas du point de vue d'un ADMIN : les comptes qui le
    // portent sont retirés de la liste qui lui est renvoyée. Il ne peut donc ni les voir,
    // ni découvrir l'existence de ce niveau de droits, ni tenter de se l'attribuer (les
    // routes d'écriture le refusent déjà, cf. refuseSuperAdminTarget).
    const isSuper = isSuperAdminRole((req as AuthRequest).user?.role);
    const users = await prisma.user.findMany({
      where: isSuper ? {} : { role: { not: ROLE_SUPERADMIN } },
      select: { id: true, name: true, email: true, role: true, password: true, estCommercial: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users.map((u: { id: string; name: string; email: string; role: string; password: string | null; estCommercial: boolean }) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, hasPassword: !!u.password, estCommercial: u.estCommercial,
    })));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching users' });
  }
});

// Autorise un nouveau compte à se connecter (liste blanche SSO / création de compte).
// Aucun mot de passe n'est défini : le compte se connecte via le SSO Microsoft. Un
// administrateur peut ensuite lui attribuer un mot de passe local via « Changer Mdp ».
const ALLOWED_ROLES = [ROLE_SUPERADMIN, 'ADMIN', 'CONDUCTEUR_TRAVAUX', 'COMMERCIAL'];

// Un compte SUPERADMIN n'est administrable QUE par un superadmin : le créer, lui changer
// de rôle, lui réattribuer un mot de passe ou le révoquer sont autant de moyens, pour un
// simple ADMIN, de s'emparer des droits de la direction. Renvoie un message d'erreur si
// l'opération doit être refusée, sinon null.
function refuseSuperAdminTarget(req: express.Request, targetRole: string | null | undefined): string | null {
  if (!isSuperAdminRole(targetRole)) return null;
  if (isSuperAdminRole((req as AuthRequest).user?.role)) return null;
  return 'Seul un super administrateur peut gérer un compte super administrateur.';
}

// Garde-fou : l'application doit toujours conserver au moins un compte superadmin, sinon
// plus personne ne peut piloter les modules ni rendre la main à un autre superadmin.
async function isLastSuperAdmin(userId: string): Promise<boolean> {
  const count = await prisma.user.count({ where: { role: ROLE_SUPERADMIN } });
  if (count > 1) return false;
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return isSuperAdminRole(target?.role);
}

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const name = String(req.body.name ?? '').trim();
    const role = ALLOWED_ROLES.includes(req.body.role) ? req.body.role : 'CONDUCTEUR_TRAVAUX';
    const refus = refuseSuperAdminTarget(req, role);
    if (refus) {
      return res.status(403).json({ error: refus });
    }
    // "estCommercial" n'a de sens que pour un ADMIN/SUPERADMIN (cf. isCommercialLike) :
    // ignoré pour les autres rôles, pour éviter un état orphelin sans effet mais trompeur
    // en base.
    const estCommercial = isAdminRole(role) && !!req.body.estCommercial;

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
      data: { email, name, role, estCommercial }, // pas de mot de passe : accès via SSO Microsoft
      select: { id: true, name: true, email: true, role: true, estCommercial: true },
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
    const refus = refuseSuperAdminTarget(req, target.role);
    if (refus) {
      return res.status(403).json({ error: refus });
    }
    if (await isLastSuperAdmin(target.id)) {
      return res.status(409).json({ error: 'Impossible de révoquer le dernier compte super administrateur.' });
    }
    await prisma.$transaction([
      prisma.chantier.updateMany({ where: { responsableId: id }, data: { responsableId: null } }),
      prisma.chantier.updateMany({ where: { commercialId: id }, data: { commercialId: null } }),
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
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Rôle invalide' });
    }
    const target = await prisma.user.findUnique({ where: { id: paramId(req) } });
    if (!target) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }
    // Refus dans les DEUX sens : un ADMIN ne peut ni rétrograder un superadmin, ni
    // promouvoir qui que ce soit (lui compris) au rang de superadmin.
    const refus = refuseSuperAdminTarget(req, target.role) || refuseSuperAdminTarget(req, role);
    if (refus) {
      return res.status(403).json({ error: refus });
    }
    if (!isSuperAdminRole(role) && (await isLastSuperAdmin(target.id))) {
      return res.status(409).json({ error: 'Impossible de retirer le rôle du dernier compte super administrateur.' });
    }
    const user = await prisma.user.update({
      where: { id: target.id },
      // "estCommercial" n'a de sens que pour un ADMIN/SUPERADMIN : on le retire si le
      // compte quitte ces rôles, pour ne pas laisser un état orphelin qui réapparaîtrait
      // s'il y revenait plus tard sans qu'on l'ait explicitement redemandé.
      data: isAdminRole(role) ? { role } : { role, estCommercial: false },
      select: { id: true, name: true, email: true, role: true, estCommercial: true }
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Error updating user role' });
  }
});

// Bascule "estCommercial" sur un compte ADMIN : il apparaît alors, en plus de ses droits
// d'administration intacts, comme un choix possible de commercial rattaché à un chantier
// et dans les statistiques/marges de "Mes commerciaux" (cf. isCommercialLike). Réservé aux
// ADMIN : un COMMERCIAL est déjà commercial, un conducteur n'a pas vocation à y apparaître.
app.patch('/api/users/:id/est-commercial', requireAuth, requireAdmin, async (req, res) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: paramId(req) } });
    if (!target) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }
    if (!isAdminRole(target.role)) {
      return res.status(400).json({ error: 'Seul un compte Administrateur peut être marqué "aussi commercial".' });
    }
    const refus = refuseSuperAdminTarget(req, target.role);
    if (refus) {
      return res.status(403).json({ error: refus });
    }
    const user = await prisma.user.update({
      where: { id: target.id },
      data: { estCommercial: !!req.body.estCommercial },
      select: { id: true, name: true, email: true, role: true, estCommercial: true },
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Error updating estCommercial' });
  }
});

app.put('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères.' });
    }
    const target = await prisma.user.findUnique({ where: { id: paramId(req) } });
    if (!target) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }
    // Réattribuer le mot de passe d'un superadmin, c'est prendre sa place : réservé aux
    // superadmins (un superadmin peut donc changer le sien et celui de ses pairs).
    const refus = refuseSuperAdminTarget(req, target.role);
    if (refus) {
      return res.status(403).json({ error: refus });
    }
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: target.id },
      data: { password: hashedPassword }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error updating password' });
  }
});

// Liste minimale des commerciaux (id + nom), pour peupler les sélecteurs d'affectation
// (création de chantier, réattribution). Contrairement à /api/users, accessible à tout
// utilisateur authentifié (pas seulement les admins) : un conducteur doit pouvoir choisir
// le commercial rattaché à un chantier qu'il crée ou dont il est responsable. Inclut les
// admins marqués "estCommercial" (cf. isCommercialLike).
app.get('/api/commerciaux', requireAuth, async (req, res) => {
  try {
    const commerciaux = await prisma.user.findMany({
      where: { OR: COMMERCIAL_OR_FILTER },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json(commerciaux);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching commerciaux' });
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
// Ses affectations du planning d'intervention sont purement prévisionnelles : il en est
// simplement retiré (cascade de la table de liaison), et celles dont il était le SEUL
// technicien sont supprimées — une affectation sans personne n'aurait plus de sens.
app.delete('/api/intervenants/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = paramId(req);
    const used = await prisma.pointageHeure.count({ where: { intervenantId: id } });
    if (used > 0) {
      return res.status(409).json({ error: `Suppression impossible : cet intervenant a ${used} pointage(s) d'heures dans l'historique.` });
    }
    const affectationsSolo = await prisma.planningEvent.findMany({
      where: { intervenants: { some: { id }, every: { id } } },
      select: { id: true },
    });
    await prisma.$transaction([
      prisma.planningEvent.deleteMany({ where: { id: { in: affectationsSolo.map((e) => e.id) } } }),
      prisma.intervenant.delete({ where: { id } }),
    ]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting intervenant' });
  }
});

// --- Planning d'intervention (module réservé aux administrateurs) ---
// Affectation PRÉVISIONNELLE des techniciens : sur un chantier suivi, sur un chantier ou
// une intervention non suivi (ex: SAV — nom libre + client Odoo ou saisie libre), ou sur
// un événement personnalisé (type réutilisable avec couleur). Aucun lien avec les heures
// réelles : le planning n'écrit jamais dans PointageHeure — les heures des chantiers
// restent saisies manuellement dans le Journal des Heures.

const PLANNING_CATEGORIES = ['CHANTIER', 'HORS_CHANTIER', 'EVENEMENT'];
const PLANNING_CRENEAUX = ['JOURNEE', 'MATIN', 'APRES_MIDI', 'HEURES'];

// Jour du planning : on ne stocke que la date (minuit UTC), jamais d'heure — le créneau
// horaire éventuel est porté par creneau/heureDebut/heureFin.
function parsePlanningJour(value: unknown): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parsePlanningHeure(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
}

function parsePlanningCouleur(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}

const PLANNING_EVENT_INCLUDE = {
  chantier: { select: { id: true, nom: true, client: true, statut: true, adresse: true } },
  typeEvent: true,
  intervenants: { select: { id: true, nom: true, role: true } },
} as const;

// Valide le contenu complet d'une affectation (à la création comme à l'édition : le PATCH
// fusionne le corps reçu avec l'existant puis revalide le tout — mêmes règles partout).
// Retourne { error } ou { data, intervenantIds } prêts pour Prisma. Les champs des autres
// catégories sont systématiquement remis à null : changer une affectation de catégorie ne
// laisse jamais traîner un chantier ou un type d'événement orphelin.
async function validatePlanningEvent(body: Record<string, unknown>): Promise<{ error?: string; data?: Record<string, unknown>; intervenantIds?: string[] }> {
  const categorie = String(body.categorie || '');
  if (!PLANNING_CATEGORIES.includes(categorie)) return { error: 'Catégorie invalide.' };

  const dateDebut = parsePlanningJour(body.dateDebut);
  if (!dateDebut) return { error: 'Date de début invalide.' };
  const dateFin = body.dateFin ? parsePlanningJour(body.dateFin) : dateDebut;
  if (!dateFin) return { error: 'Date de fin invalide.' };
  if (dateFin < dateDebut) return { error: 'La date de fin doit être postérieure ou égale à la date de début.' };

  const creneau = PLANNING_CRENEAUX.includes(String(body.creneau)) ? String(body.creneau) : 'JOURNEE';
  let heureDebut: string | null = null;
  let heureFin: string | null = null;
  if (creneau === 'HEURES') {
    heureDebut = parsePlanningHeure(body.heureDebut);
    heureFin = parsePlanningHeure(body.heureFin);
    if (!heureDebut || !heureFin) return { error: 'Heure de début et heure de fin requises (format HH:MM).' };
    if (heureFin <= heureDebut) return { error: "L'heure de fin doit être postérieure à l'heure de début." };
  }

  const intervenantIds = [...new Set((Array.isArray(body.intervenantIds) ? body.intervenantIds : []).map(String))];
  if (intervenantIds.length === 0) return { error: 'Sélectionnez au moins un technicien.' };
  const nbTrouves = await prisma.intervenant.count({ where: { id: { in: intervenantIds } } });
  if (nbTrouves !== intervenantIds.length) return { error: 'Un des techniciens sélectionnés est introuvable.' };

  const data: Record<string, unknown> = {
    categorie, dateDebut, dateFin, creneau, heureDebut, heureFin,
    commentaire: String(body.commentaire || '').trim() || null,
    chantierId: null, titre: null, client: null, adresse: null, typeEventId: null,
  };

  if (categorie === 'CHANTIER') {
    const chantier = await prisma.chantier.findUnique({ where: { id: String(body.chantierId || '') } });
    if (!chantier) return { error: 'Chantier introuvable.' };
    data.chantierId = chantier.id;
  } else if (categorie === 'HORS_CHANTIER') {
    const titre = String(body.titre || '').trim();
    if (!titre) return { error: "Saisissez le nom du chantier ou de l'intervention." };
    data.titre = titre;
    data.client = String(body.client || '').trim() || null;
    // Adresse du site (facultative), préremplie depuis le client Odoo choisi (cf.
    // ClientAutocomplete) : contrairement à categorie CHANTIER, il n'existe pas de fiche
    // chantier à côté de laquelle la stocker — elle vit uniquement sur cette affectation.
    data.adresse = String(body.adresse || '').trim() || null;
  } else {
    const typeEvent = await prisma.planningEventType.findUnique({ where: { id: String(body.typeEventId || '') } });
    if (!typeEvent) return { error: "Type d'événement introuvable." };
    data.typeEventId = typeEvent.id;
  }

  return { data, intervenantIds };
}

// Liste des chantiers pour peupler le sélecteur "Chantier suivi" du planning — TOUS les
// chantiers (pas seulement ceux du conducteur connecté, contrairement à GET /api/chantiers) :
// le planning est un outil d'équipe partagé entre conducteurs, il faut pouvoir y affecter un
// technicien sur n'importe quel chantier en cours, pas seulement les siens. N'affecte en rien
// la visibilité des chantiers ailleurs dans l'application (Liste des Chantiers, Tableau de
// bord...), qui reste strictement scoped par responsable pour un conducteur.
app.get('/api/planning/chantiers', requireAuth, blockCommercial, requirePlanningActif, async (req, res) => {
  try {
    const chantiers = await prisma.chantier.findMany({
      select: { id: true, nom: true, client: true, statut: true },
      orderBy: { nom: 'asc' },
    });
    res.json(chantiers);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching planning chantiers' });
  }
});

// Affectations chevauchant la plage de jours [start, end] (bornes incluses).
app.get('/api/planning/events', requireAuth, blockCommercial, requirePlanningActif, async (req, res) => {
  try {
    const start = parsePlanningJour(req.query.start);
    const end = parsePlanningJour(req.query.end);
    if (!start || !end) return res.status(400).json({ error: 'Plage de dates invalide (start et end requis, format YYYY-MM-DD).' });
    const events = await prisma.planningEvent.findMany({
      where: { dateDebut: { lte: end }, dateFin: { gte: start } },
      include: PLANNING_EVENT_INCLUDE,
      orderBy: [{ dateDebut: 'asc' }, { createdAt: 'asc' }],
    });
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching planning events' });
  }
});

app.post('/api/planning/events', requireAuth, blockCommercial, requirePlanningActif, async (req, res) => {
  try {
    const { error, data, intervenantIds } = await validatePlanningEvent(req.body);
    if (error) return res.status(400).json({ error });
    const event = await prisma.planningEvent.create({
      data: { ...data, intervenants: { connect: intervenantIds!.map((id) => ({ id })) } } as never,
      include: PLANNING_EVENT_INCLUDE,
    });
    res.status(201).json(event);
  } catch (error) {
    res.status(500).json({ error: 'Error creating planning event' });
  }
});

// Édition complète ou déplacement (glisser-déposer) : fusion existant + corps reçu,
// puis revalidation de l'ensemble — cf. validatePlanningEvent.
app.patch('/api/planning/events/:id', requireAuth, blockCommercial, requirePlanningActif, async (req, res) => {
  try {
    const existing = await prisma.planningEvent.findUnique({
      where: { id: paramId(req) },
      include: { intervenants: { select: { id: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Affectation introuvable.' });

    const merged = {
      categorie: existing.categorie,
      dateDebut: existing.dateDebut.toISOString(),
      dateFin: existing.dateFin.toISOString(),
      creneau: existing.creneau,
      heureDebut: existing.heureDebut,
      heureFin: existing.heureFin,
      chantierId: existing.chantierId,
      titre: existing.titre,
      client: existing.client,
      adresse: existing.adresse,
      typeEventId: existing.typeEventId,
      commentaire: existing.commentaire,
      intervenantIds: existing.intervenants.map((i) => i.id),
      ...req.body,
    };
    const { error, data, intervenantIds } = await validatePlanningEvent(merged);
    if (error) return res.status(400).json({ error });
    const event = await prisma.planningEvent.update({
      where: { id: existing.id },
      data: { ...data, intervenants: { set: intervenantIds!.map((id) => ({ id })) } } as never,
      include: PLANNING_EVENT_INCLUDE,
    });
    res.json(event);
  } catch (error) {
    res.status(500).json({ error: 'Error updating planning event' });
  }
});

app.delete('/api/planning/events/:id', requireAuth, blockCommercial, requirePlanningActif, async (req, res) => {
  try {
    const existing = await prisma.planningEvent.findUnique({ where: { id: paramId(req) } });
    if (!existing) return res.status(404).json({ error: 'Affectation introuvable.' });
    await prisma.planningEvent.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting planning event' });
  }
});

// Types d'événements personnalisés du planning (libellé + couleur, réutilisables).
app.get('/api/planning/types', requireAuth, blockCommercial, requirePlanningActif, async (req, res) => {
  try {
    res.json(await prisma.planningEventType.findMany({ orderBy: { nom: 'asc' } }));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching planning types' });
  }
});

app.post('/api/planning/types', requireAuth, blockCommercial, requirePlanningActif, async (req, res) => {
  try {
    const nom = String(req.body.nom || '').trim();
    if (!nom) return res.status(400).json({ error: 'Le libellé du type est requis.' });
    const couleur = parsePlanningCouleur(req.body.couleur) || '#f59e0b';
    res.status(201).json(await prisma.planningEventType.create({ data: { nom, couleur } }));
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Un type porte déjà ce libellé.' });
    res.status(500).json({ error: 'Error creating planning type' });
  }
});

app.put('/api/planning/types/:id', requireAuth, blockCommercial, requirePlanningActif, async (req, res) => {
  try {
    const data: Record<string, unknown> = {};
    if (typeof req.body.nom === 'string' && req.body.nom.trim()) data.nom = req.body.nom.trim();
    const couleur = parsePlanningCouleur(req.body.couleur);
    if (couleur) data.couleur = couleur;
    res.json(await prisma.planningEventType.update({ where: { id: paramId(req) }, data }));
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Un type porte déjà ce libellé.' });
    res.status(500).json({ error: 'Error updating planning type' });
  }
});

// Supprimer un type d'événement. Bloqué si des affectations du planning l'utilisent.
app.delete('/api/planning/types/:id', requireAuth, blockCommercial, requirePlanningActif, async (req, res) => {
  try {
    const id = paramId(req);
    const used = await prisma.planningEvent.count({ where: { typeEventId: id } });
    if (used > 0) {
      return res.status(409).json({ error: `Suppression impossible : ${used} affectation(s) du planning utilisent ce type.` });
    }
    await prisma.planningEventType.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting planning type' });
  }
});

// --- Partage public du planning (lien type "OneDrive", sans authentification) ---
// Un seul lien actif à la fois (ligne singleton) : les techniciens, qui n'ont pas de
// compte dans l'application, y accèdent en LECTURE SEULE via GET /api/planning/public/:token.
// Le token ne change qu'à la régénération volontaire par un administrateur (bouton
// "Renouveler le lien") ; `active` permet de couper l'accès sans en générer un nouveau
// (bouton "Désactiver le partage"), en conservant le même token pour une réactivation
// ultérieure avec le lien déjà communiqué.
function generateShareToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function paramToken(req: express.Request): string {
  const t = req.params.token;
  return Array.isArray(t) ? t[0] : t;
}

function serializeShare(share: { token: string; active: boolean; updatedAt: Date } | null) {
  return {
    published: !!share,
    active: !!share?.active,
    token: share?.token || null,
    updatedAt: share?.updatedAt?.toISOString() || null,
  };
}

app.get('/api/planning/share', requireAuth, requireAdmin, requirePlanningActif, async (req, res) => {
  try {
    const share = await prisma.planningPublicShare.findUnique({ where: { id: 'singleton' } });
    res.json(serializeShare(share));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching planning share' });
  }
});

// Publie le planning (1ère fois) ou renouvelle le lien existant : génère TOUJOURS un
// nouveau token aléatoire et (ré)active le partage — l'ancien lien devient aussitôt
// invalide (cf. GET /api/planning/public/:token, qui compare le token reçu au token stocké).
app.post('/api/planning/share', requireAuth, requireAdmin, requirePlanningActif, async (req, res) => {
  try {
    const token = generateShareToken();
    const share = await prisma.planningPublicShare.upsert({
      where: { id: 'singleton' },
      update: { token, active: true },
      create: { id: 'singleton', token, active: true },
    });
    res.json(serializeShare(share));
  } catch (error) {
    res.status(500).json({ error: 'Error publishing planning share' });
  }
});

// Active/désactive le partage SANS changer le token (contrairement à la régénération
// ci-dessus) : permet de couper l'accès temporairement puis de le rétablir avec le même
// lien déjà communiqué aux techniciens.
app.patch('/api/planning/share', requireAuth, requireAdmin, requirePlanningActif, async (req, res) => {
  try {
    const existing = await prisma.planningPublicShare.findUnique({ where: { id: 'singleton' } });
    if (!existing) return res.status(404).json({ error: "Le planning n'a encore jamais été publié." });
    const share = await prisma.planningPublicShare.update({
      where: { id: 'singleton' },
      data: { active: !!req.body.active },
    });
    res.json(serializeShare(share));
  } catch (error) {
    res.status(500).json({ error: 'Error updating planning share' });
  }
});

// Consultation PUBLIQUE et SANS authentification du planning (lien de partage) —
// destinée aux techniciens qui n'ont pas de compte. Lecture seule : mêmes affectations
// que GET /api/planning/events, réduites à ce qui leur est utile (aucun montant, aucune
// marge — ces champs n'existent de toute façon pas sur Chantier "lite"). Token invalide
// OU partage désactivé renvoient la MÊME erreur générique, pour ne jamais révéler si un
// token a existé.
app.get('/api/planning/public/:token', async (req, res) => {
  try {
    const token = paramToken(req);
    const share = token ? await prisma.planningPublicShare.findUnique({ where: { token } }) : null;
    if (!share || !share.active) {
      return res.status(404).json({ error: "Ce lien de planning n'est plus disponible. Contactez votre administrateur." });
    }

    const start = parsePlanningJour(req.query.start);
    const end = parsePlanningJour(req.query.end);
    if (!start || !end) return res.status(400).json({ error: 'Plage de dates invalide (start et end requis, format YYYY-MM-DD).' });

    // `select` explicite (plutôt qu'`include`, qui renverrait aussi tous les champs
    // scalaires bruts de PlanningEvent) : n'expose que ce qui est utile à un technicien,
    // jamais d'identifiant interne (chantierId, typeEventId) ni de donnée de gestion.
    const [events, intervenants] = await Promise.all([
      prisma.planningEvent.findMany({
        where: { dateDebut: { lte: end }, dateFin: { gte: start } },
        select: {
          id: true, categorie: true, dateDebut: true, dateFin: true, creneau: true,
          heureDebut: true, heureFin: true, titre: true, client: true, adresse: true, commentaire: true,
          chantier: { select: { nom: true, client: true, adresse: true } },
          typeEvent: { select: { nom: true, couleur: true } },
          intervenants: { select: { id: true, nom: true, role: true } },
        },
        orderBy: [{ dateDebut: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.intervenant.findMany({ select: { id: true, nom: true }, orderBy: { nom: 'asc' } }),
    ]);

    res.json({ events, intervenants });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching public planning' });
  }
});

// --- Categories & Fournisseurs ---
// Référentiels partagés du Journal des Achats : leur tenue à jour est ouverte aux
// CONDUCTEURS DE TRAVAUX en plus des administrateurs (ils saisissent les achats au
// quotidien et ont besoin de créer un fournisseur ou une catégorie manquante sans
// attendre la Direction), d'où `blockCommercial` plutôt que `requireAdmin` : seuls les
// commerciaux, dont l'accès est strictement en lecture, en restent exclus.
app.get('/api/categories', requireAuth, async (req, res) => res.json(await prisma.categorie.findMany({ orderBy: { nom: 'asc' } })));
app.post('/api/categories', requireAuth, blockCommercial, async (req, res) => res.json(await prisma.categorie.create({ data: { nom: req.body.nom, description: req.body.description || null } })));

// Modifier une catégorie (nom, description).
app.put('/api/categories/:id', requireAuth, blockCommercial, async (req, res) => {
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
app.delete('/api/categories/:id', requireAuth, blockCommercial, async (req, res) => {
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
app.post('/api/fournisseurs', requireAuth, blockCommercial, async (req, res) => res.json(await prisma.fournisseur.create({ data: { nom: req.body.nom, contact: req.body.contact || null } })));

// Modifier un fournisseur (nom, contact).
app.put('/api/fournisseurs/:id', requireAuth, blockCommercial, async (req, res) => {
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
app.delete('/api/fournisseurs/:id', requireAuth, blockCommercial, async (req, res) => {
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

// Un chantier clôturé (TERMINE) devient en lecture seule pour les conducteurs : ils ne
// peuvent plus y ajouter d'heures ou de dépenses ; un admin garde un accès total (c'est
// lui seul qui peut d'ailleurs réouvrir un chantier clôturé, cf. PATCH .../statut).
// Envoie la réponse d'erreur et retourne null si l'écriture est refusée.
async function assertChantierWritable(req: express.Request, res: express.Response, chantierId: string) {
  const isAdmin = isAdminRole((req as AuthRequest).user?.role);
  const chantier = await prisma.chantier.findUnique({ where: { id: chantierId } });
  if (!chantier) {
    res.status(404).json({ error: 'Chantier introuvable' });
    return null;
  }
  if (!isAdmin && chantier.statut !== 'EN_COURS') {
    res.status(403).json({ error: 'Ce chantier est clôturé : impossible d\'y ajouter une dépense ou des heures.' });
    return null;
  }
  return chantier;
}

// Achats
app.get('/api/achats', requireAuth, async (req, res) => {
  try {
    res.json(decimalToNumber(await prisma.achatReel.findMany({ include: { chantier: true, categorie: true, fournisseur: true } })));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching achats' });
  }
});

app.post('/api/achats', requireAuth, blockCommercial, async (req, res) => {
  try {
    if (!(await assertChantierWritable(req, res, req.body.chantierId))) return;
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

// Correction d'un achat déjà saisi (erreur de montant, de fournisseur, de catégorie...) —
// mêmes droits que la saisie (tout compte non-commercial, sur un chantier EN_COURS ou
// n'importe quel chantier pour un admin, cf. assertChantierWritable). Ne permet pas de
// changer le chantier de l'achat, comme pour PATCH /api/heures/:id.
app.patch('/api/achats/:id', requireAuth, blockCommercial, async (req, res) => {
  try {
    const achatId = paramId(req);
    const achat = await prisma.achatReel.findUnique({ where: { id: achatId } });
    if (!achat) return res.status(404).json({ error: 'Achat introuvable.' });
    if (!(await assertChantierWritable(req, res, achat.chantierId))) return;

    const data: Record<string, unknown> = {};
    if ('date' in req.body) data.date = new Date(req.body.date).toISOString();
    if ('numeroFacture' in req.body) data.numeroFacture = req.body.numeroFacture || null;
    if ('description' in req.body) data.description = req.body.description;
    if ('montantHT' in req.body) data.montantHT = parseFloat(req.body.montantHT) || 0;
    if ('fournisseurId' in req.body) {
      const fournisseur = await prisma.fournisseur.findUnique({ where: { id: String(req.body.fournisseurId) } });
      if (!fournisseur) return res.status(404).json({ error: 'Fournisseur introuvable.' });
      data.fournisseurId = fournisseur.id;
    }
    if ('categorieId' in req.body) {
      const categorie = await prisma.categorie.findUnique({ where: { id: String(req.body.categorieId) } });
      if (!categorie) return res.status(404).json({ error: 'Catégorie introuvable.' });
      data.categorieId = categorie.id;
    }

    res.json(await prisma.achatReel.update({ where: { id: achatId }, data }));
  } catch (error) {
    res.status(500).json({ error: 'Error updating achat' });
  }
});

// Suppression d'un achat saisi par erreur (doublon, mauvais chantier...) — mêmes droits
// que la correction ci-dessus (PATCH), cf. assertChantierWritable.
app.delete('/api/achats/:id', requireAuth, blockCommercial, async (req, res) => {
  try {
    const achatId = paramId(req);
    const achat = await prisma.achatReel.findUnique({ where: { id: achatId } });
    if (!achat) return res.status(404).json({ error: 'Achat introuvable.' });
    if (!(await assertChantierWritable(req, res, achat.chantierId))) return;

    await prisma.achatReel.delete({ where: { id: achatId } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting achat' });
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

app.post('/api/heures', requireAuth, blockCommercial, async (req, res) => {
  try {
    const intervenant = await prisma.intervenant.findUnique({ where: { id: req.body.intervenantId } });
    if (!intervenant) return res.status(404).json({ error: 'Intervenant not found' });
    if (!(await assertChantierWritable(req, res, req.body.chantierId))) return;

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

// Correction d'un pointage d'heures déjà saisi (erreur de date, d'intervenant, de nombre
// d'heures...) — mêmes droits que la saisie (tout compte non-commercial, sur un chantier
// EN_COURS ou n'importe quel chantier pour un admin, cf. assertChantierWritable). Ne
// permet pas de changer le chantier du pointage : ce n'est pas une réaffectation, juste
// une correction de saisie sur le chantier d'origine.
app.patch('/api/heures/:id', requireAuth, blockCommercial, async (req, res) => {
  try {
    const pointageId = paramId(req);
    const pointage = await prisma.pointageHeure.findUnique({ where: { id: pointageId } });
    if (!pointage) return res.status(404).json({ error: 'Pointage introuvable.' });
    if (!(await assertChantierWritable(req, res, pointage.chantierId))) return;

    const data: Record<string, unknown> = {};
    if ('date' in req.body) data.date = new Date(req.body.date).toISOString();
    if ('nbrHeures' in req.body) data.nbrHeures = parseFloat(req.body.nbrHeures) || 0;
    if ('commentaire' in req.body) data.commentaire = req.body.commentaire || null;
    // Changer l'intervenant réapplique son taux horaire chargé ACTUEL (même logique qu'à
    // la création) : le taux figé de l'ancien intervenant n'a pas de sens pour le nouveau.
    if ('intervenantId' in req.body && req.body.intervenantId !== pointage.intervenantId) {
      const intervenant = await prisma.intervenant.findUnique({ where: { id: String(req.body.intervenantId) } });
      if (!intervenant) return res.status(404).json({ error: 'Intervenant introuvable.' });
      data.intervenantId = intervenant.id;
      data.tauxHoraireApplique = intervenant.tauxHoraireCharge;
    }

    res.json(await prisma.pointageHeure.update({ where: { id: pointageId }, data }));
  } catch (error) {
    res.status(500).json({ error: 'Error updating pointage' });
  }
});

// Suppression d'un pointage saisi par erreur (doublon, mauvais chantier...) — mêmes
// droits que la correction ci-dessus (PATCH), cf. assertChantierWritable.
app.delete('/api/heures/:id', requireAuth, blockCommercial, async (req, res) => {
  try {
    const pointageId = paramId(req);
    const pointage = await prisma.pointageHeure.findUnique({ where: { id: pointageId } });
    if (!pointage) return res.status(404).json({ error: 'Pointage introuvable.' });
    if (!(await assertChantierWritable(req, res, pointage.chantierId))) return;

    await prisma.pointageHeure.delete({ where: { id: pointageId } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting pointage' });
  }
});

// Photos Upload & Purge
app.post('/api/chantiers/:id/photos', requireAuth, blockCommercial, uploadPhoto, async (req, res) => {
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
      const filePath = path.join(process.cwd(), p.url);
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
      const filePath = path.join(process.cwd(), p.url);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: path.basename(filePath) });
      }
    }
    await archive.finalize();
  } catch (error) {
    res.status(500).json({ error: 'Error exporting photos' });
  }
});

// Clause de sécurisation des commissions : une commission n'est définitivement due
// que si le chantier est Terminé ET Encaissé (cf. règle 6 du système de rémunération
// commerciale — annulation/litige/impayé => la commission n'est pas due ou est récupérée).
// Réservé aux admins ; togglable indépendamment du statut Terminé/En cours.
app.patch('/api/chantiers/:id/encaisse', requireAuth, requireAdmin, async (req, res) => {
  try {
    const encaisse = !!req.body.encaisse;
    const chantier = await prisma.chantier.update({
      where: { id: paramId(req) },
      data: { encaisse, dateEncaissement: encaisse ? new Date() : null },
    });
    res.json(decimalToNumber(chantier));
  } catch (error) {
    res.status(500).json({ error: 'Error updating encaissement' });
  }
});

// Prime "suivi administratif" (qualité et rigueur) du système de rémunération
// commerciale — ne peut pas être déduite des données de gestion, validée à la main
// par un administrateur, mois par mois (periode "YYYY-MM").
app.put('/api/commerciaux/:id/prime-mensuelle', requireAuth, requireAdmin, async (req, res) => {
  try {
    const periode = String(req.body.periode || '');
    if (!/^\d{4}-\d{2}$/.test(periode)) {
      return res.status(400).json({ error: 'Période invalide (attendu "YYYY-MM").' });
    }
    const commercial = await prisma.user.findUnique({ where: { id: paramId(req) } });
    if (!commercial || !isCommercialLike(commercial)) {
      return res.status(404).json({ error: 'Commercial introuvable.' });
    }
    const suiviAdministratif = !!req.body.suiviAdministratif;
    const prime = await prisma.primeMensuelleCommercial.upsert({
      where: { commercialId_periode: { commercialId: commercial.id, periode } },
      update: { suiviAdministratif },
      create: { commercialId: commercial.id, periode, suiviAdministratif },
    });
    res.json(prime);
  } catch (error) {
    res.status(500).json({ error: 'Error updating prime mensuelle' });
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

// N'écrit QUE margeCommercialeActive : l'activation des modules (planningActif) est
// réservée au superadmin et passe par PUT /api/modules — un ADMIN ne doit pas pouvoir la
// modifier, même en glissant le champ dans le corps de cette requête.
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

// --- Modules de l'application (activation par le superadmin) ---
// Lecture : accessible à TOUT compte authentifié — le client en a besoin pour savoir
// quelles entrées de menu afficher. On renvoie la visibilité EFFECTIVE pour le compte
// connecté : un superadmin garde toujours accès au planning, même désactivé (c'est lui
// qui le pilote), les autres suivent le réglage global.
app.get('/api/modules', requireAuth, async (req, res) => {
  try {
    const { planningActif } = await getParametres();
    const isSuper = isSuperAdminRole((req as AuthRequest).user?.role);
    res.json({ planningActif: isSuper || planningActif, planningActifGlobal: planningActif });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching modules' });
  }
});

// Écriture : superadmin uniquement. Désactiver le planning ne supprime RIEN — les
// affectations et types d'événements restent en base et réapparaissent à la réactivation.
app.put('/api/modules', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const planningActif = !!req.body.planningActif;
    const p = await prisma.parametres.upsert({
      where: { id: 'singleton' },
      update: { planningActif },
      create: { id: 'singleton', planningActif },
    });
    res.json({ planningActif: true, planningActifGlobal: p.planningActif });
  } catch (error) {
    res.status(500).json({ error: 'Error updating modules' });
  }
});

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
    const { start, endExclusive } = periodBounds(period, req.query.ref);

    const where = isAdmin
      ? {}
      : isCommercial
        ? { commercialId: user.id }
        : { responsableId: user.id };
    const chantiers = decimalToNumber(await prisma.chantier.findMany({
      where,
      include: { achats: true, pointages: true },
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

    if (!isCommercial) {
      // ADMIN + CONDUCTEUR : total des achats de la période (peu importe le statut du
      // chantier — un achat facturé ce mois compte, chantier ouvert ou non).
      result.achatsTotal = achatsTotal;
    }
    if (!isAdmin && !isCommercial) {
      // CONDUCTEUR : heures totales enregistrées sur la période, tous ses chantiers.
      result.heuresTotal = heuresTotal;
    }

    if (params.margeCommercialeActive) {
      if (isAdmin) {
        // CA vendu / marge / commission commerciale de la période, tous commerciaux
        // confondus — même définition que la commission (chantiers Terminés ET
        // Encaissés, rattachés au mois de leur clôture) : ce sont des résultats
        // FINALISÉS du mois, pas un cumul de portefeuille en cours.
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
      } else if (isCommercial) {
        const { byCommercial } = await computeCommissionsParCommercial([user.id], start, endExclusive, params);
        const mine = byCommercial[user.id];
        result.margeTotal = mine?.margeTotal ?? 0;
        result.commissionTotal = mine?.commissionTotal ?? 0;
      }
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Error computing global stats' });
  }
});

// Statistiques par conducteur de travaux (admin uniquement) : marge/CA, avance/retard
// sur les chantiers en cours (heures et matériel), et taux d'objectifs respectés sur
// les chantiers terminés (livrés sans dépassement).
// NB : pas de "taux de remplissage heures" ici (heures réalisées / heures vendues) —
// cet indicateur mélangeait avancement du CHANTIER et assiduité du CONDUCTEUR : un
// chantier fini en avance y ferait mécaniquement baisser le score, un chantier en
// dérive le ferait monter. L'assiduité de saisie a sa propre route ci-dessous
// (GET /stats/conducteurs/assiduite), basée sur le rythme réel de saisie.
app.get('/api/stats/conducteurs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const params = await getParametres();
    const users = await prisma.user.findMany({ where: { role: 'CONDUCTEUR_TRAVAUX' }, select: { id: true, name: true, email: true } });
    const chantiers = decimalToNumber(await prisma.chantier.findMany({
      include: { achats: true, pointages: true },
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
      agg.caTotal += c.budgetGlobalVendu;
      agg.depensesTotal += m.totalDepenses;
      agg.margeTotal += m.margeCommerciale ?? (c.budgetGlobalVendu - m.totalDepenses);

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
      .map((a: any) => ({
        ...a,
        margePct: a.caTotal > 0 ? (a.margeTotal / a.caTotal) * 100 : 0,
        tauxObjectifsRespectes: a.nbChantiersTermines > 0 ? (a.nbObjectifsRespectes / a.nbChantiersTermines) * 100 : null,
        // % d'heures consommées au-delà du total vendu, sur les seuls chantiers TERMINES
        // (résultat définitif) — un chantier en cours en avance compenserait à tort un
        // chantier terminé en net dépassement si on les mélangeait.
        tauxDepassementHeures: a.heuresVenduesTermineTotal > 0
          ? (Math.max(0, a.heuresRealiseesTermineTotal - a.heuresVenduesTermineTotal) / a.heuresVenduesTermineTotal) * 100
          : null,
      }))
      .sort((x: any, y: any) => y.margeTotal - x.margeTotal);

    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Error computing conducteurs stats' });
  }
});

// Bornes lundi 00:00 -> samedi 00:00 (exclusif) de la semaine civile contenant `ref`,
// en UTC. `weekParam` est une date quelconque de la semaine visée (ex: "2026-06-29").
function weekBoundsFrom(weekParam: unknown): { monday: Date; friday: Date; saturdayExclusive: Date } {
  const parsed = typeof weekParam === 'string' && weekParam ? new Date(weekParam) : new Date();
  const ref = isNaN(parsed.getTime()) ? new Date() : parsed;
  const day = ref.getUTCDay(); // 0 = dimanche ... 6 = samedi
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate() + diffToMonday));
  const friday = new Date(monday.getTime() + 4 * 86400000);
  const saturdayExclusive = new Date(monday.getTime() + 5 * 86400000);
  return { monday, friday, saturdayExclusive };
}

const JOURS_OUVRES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];

// Assiduité de saisie des conducteurs (admin uniquement), semaine civile lundi-vendredi.
// Mesure leur usage réel de l'application — et non l'avancement de leurs chantiers :
// jours où ils ont saisi au moins une heure, volume saisi par jour, et à quelle heure
// de la journée ils saisissent habituellement (basé sur `createdAt`, l'instant de
// saisie — pas `date`, qui est la date du travail effectué et n'a pas d'heure fiable).
// Un conducteur est associé aux pointages des chantiers dont IL est responsable (il n'y
// a pas d'auteur direct sur un pointage ; en pratique, un conducteur ne saisit que sur
// ses propres chantiers en cours, cf. POST /heures).
app.get('/api/stats/conducteurs/assiduite', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { monday, friday, saturdayExclusive } = weekBoundsFrom(req.query.week);
    const users = await prisma.user.findMany({ where: { role: 'CONDUCTEUR_TRAVAUX' }, select: { id: true, name: true, email: true } });
    const userIds = users.map((u) => u.id);

    const pointages = decimalToNumber(await prisma.pointageHeure.findMany({
      where: {
        createdAt: { gte: monday, lt: saturdayExclusive },
        chantier: { responsableId: { in: userIds } },
      },
      select: { nbrHeures: true, createdAt: true, chantier: { select: { responsableId: true } } },
    }));

    interface DayAgg { date: string; label: string; nbSaisies: number; heuresSaisies: number }
    const byUser: Record<string, { days: DayAgg[]; heuresParHeureJournee: Record<number, number> }> = {};
    for (const u of users) {
      byUser[u.id] = {
        days: JOURS_OUVRES.map((label, i) => ({
          date: new Date(monday.getTime() + i * 86400000).toISOString().slice(0, 10),
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
      const dayIndex = Math.round((Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate()) - monday.getTime()) / 86400000);
      if (dayIndex >= 0 && dayIndex < 5) {
        agg.days[dayIndex].nbSaisies += 1;
        agg.days[dayIndex].heuresSaisies += p.nbrHeures;
      }
      const heure = created.getUTCHours();
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
      weekStart: monday.toISOString().slice(0, 10),
      weekEnd: friday.toISOString().slice(0, 10),
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
// suivant, 7 jours), "mois civil", "trimestre civil" (janv-mars, avr-juin, juil-sept,
// oct-déc) ou "année civile" contenant `refParam`, en UTC.
function periodBounds(period: 'week' | 'month' | 'quarter' | 'year', refParam: unknown): { start: Date; endExclusive: Date } {
  const parsed = typeof refParam === 'string' && refParam ? new Date(refParam) : new Date();
  const ref = isNaN(parsed.getTime()) ? new Date() : parsed;
  if (period === 'year') {
    return {
      start: new Date(Date.UTC(ref.getUTCFullYear(), 0, 1)),
      endExclusive: new Date(Date.UTC(ref.getUTCFullYear() + 1, 0, 1)),
    };
  }
  if (period === 'quarter') {
    const quarterStartMonth = Math.floor(ref.getUTCMonth() / 3) * 3;
    return {
      start: new Date(Date.UTC(ref.getUTCFullYear(), quarterStartMonth, 1)),
      endExclusive: new Date(Date.UTC(ref.getUTCFullYear(), quarterStartMonth + 3, 1)),
    };
  }
  if (period === 'month') {
    return {
      start: new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1)),
      endExclusive: new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1)),
    };
  }
  const day = ref.getUTCDay(); // 0 = dimanche ... 6 = samedi
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate() + diffToMonday));
  return { start, endExclusive: new Date(start.getTime() + 7 * 86400000) };
}

// Classement des intervenants par heures travaillées (semaine civile / mois civil /
// année civile, navigable) — visible par les conducteurs ET les admins. Basé sur la
// date du travail effectué (`date`), pas l'instant de saisie.
app.get('/api/stats/intervenants', requireAuth, blockCommercial, async (req, res) => {
  try {
    const period = (['week', 'month', 'year'] as const).includes(req.query.period as any) ? (req.query.period as 'week' | 'month' | 'year') : 'week';
    const { start, endExclusive } = periodBounds(period, req.query.ref);

    const intervenants = await prisma.intervenant.findMany({ select: { id: true, nom: true, role: true } });
    const pointages = decimalToNumber(await prisma.pointageHeure.findMany({
      where: { date: { gte: start, lt: endExclusive } },
      select: { intervenantId: true, nbrHeures: true, tauxHoraireApplique: true },
    }));

    const byIntervenant: Record<string, { heures: number; cout: number }> = {};
    for (const p of pointages) {
      const cur = byIntervenant[p.intervenantId] || { heures: 0, cout: 0 };
      cur.heures += p.nbrHeures;
      cur.cout += p.nbrHeures * p.tauxHoraireApplique;
      byIntervenant[p.intervenantId] = cur;
    }

    const list = intervenants
      .map((i) => ({ id: i.id, nom: i.nom, role: i.role, heures: byIntervenant[i.id]?.heures || 0, cout: byIntervenant[i.id]?.cout || 0 }))
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

// Total des achats par fournisseur (mois civil / année civile, navigable) — visible
// par les conducteurs ET les admins (même périmètre que le Journal des Achats).
app.get('/api/stats/fournisseurs', requireAuth, blockCommercial, async (req, res) => {
  try {
    const period = req.query.period === 'year' ? 'year' : 'month';
    const { start, endExclusive } = periodBounds(period, req.query.ref);

    const fournisseurs = await prisma.fournisseur.findMany({ select: { id: true, nom: true } });
    const achats = decimalToNumber(await prisma.achatReel.findMany({
      where: { date: { gte: start, lt: endExclusive } },
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
app.get('/api/stats/types-chantiers', requireAuth, blockCommercial, async (req, res) => {
  try {
    const authUser = (req as AuthRequest).user!;
    const isAdmin = isAdminRole(authUser.role);
    const period = req.query.period === 'year' ? 'year' : 'month';
    const { start, endExclusive } = periodBounds(period, req.query.ref);

    const chantiers = await prisma.chantier.findMany({
      where: {
        dateDebut: { gte: start, lt: endExclusive },
        ...(isAdmin ? {} : { responsableId: authUser.id }),
      },
      select: { types: true },
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

// --- Système de rémunération commerciale : barème progressif mensuel ---
// (cf. document "Système de rémunération commerciale" fourni par la direction).
// Chaque tranche de marge du MOIS est commissionnée à son propre taux, comme un barème
// d'impôt progressif : atteindre la tranche haute ne fait pas basculer toute la marge à
// son taux, seule la fraction qui la dépasse l'est.
const BAREME_COMMERCIAL_STANDARD = [
  { plafond: 20000, taux: 16 },
  { plafond: 30000, taux: 20 },
  { plafond: Infinity, taux: 25 },
];
// Barème réduit pour les dossiers rattachés à NOXIA (cf. Chantier.dossierNoxia).
const BAREME_COMMERCIAL_NOXIA = [
  { plafond: 20000, taux: 8 },
  { plafond: 30000, taux: 10 },
  { plafond: Infinity, taux: 12.5 },
];
const OBJECTIF_CA_MENSUEL = 70000;
const OBJECTIF_MARGE_MENSUEL = 17000;
const PRIME_OBJECTIF_CA = 450;
const PRIME_OBJECTIF_MARGE = 450;
const PRIME_SUIVI_ADMINISTRATIF = 250;

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
async function computeCommissionsParCommercial(commercialIds: string[], start: Date, endExclusive: Date, params: Parametres) {
  const commercialIdSet = new Set(commercialIds);
  const chantiers = decimalToNumber(await prisma.chantier.findMany({
    where: { commercialId: { in: commercialIds } },
    include: { achats: true, pointages: true },
  }));

  const moisPeriode = moisKeysDansPeriode(start, endExclusive);
  const primesAdmin = await prisma.primeMensuelleCommercial.findMany({
    where: { commercialId: { in: commercialIds }, periode: { in: moisPeriode } },
  });
  const suiviAdminSet = new Set(primesAdmin.filter((p) => p.suiviAdministratif).map((p) => `${p.commercialId}:${p.periode}`));

  const buckets: Record<string, Record<string, { ca: number; margeStandard: number; margeNoxia: number }>> = {};
  for (const c of chantiers) {
    if (!c.commercialId || !commercialIdSet.has(c.commercialId)) continue;
    const dateCloture = dateClotureChantier(c);
    if (!c.encaisse || !dateCloture || dateCloture < start || dateCloture >= endExclusive) continue;
    const m = computeChantierMetrics(c, params, true);
    const moisKey = dateCloture.toISOString().slice(0, 7);
    buckets[c.commercialId] ??= {};
    buckets[c.commercialId][moisKey] ??= { ca: 0, margeStandard: 0, margeNoxia: 0 };
    const b = buckets[c.commercialId][moisKey];
    b.ca += c.budgetGlobalVendu;
    if (c.dossierNoxia) b.margeNoxia += m.margeCommerciale ?? 0;
    else b.margeStandard += m.margeCommerciale ?? 0;
  }

  const commissionsParMoisGroupe: Record<string, { standard: number; noxia: number }> = {};
  const byCommercial: Record<string, any> = {};
  for (const id of commercialIds) {
    const buck = buckets[id] || {};
    let commissionStandard = 0, commissionNoxia = 0, primeCA = 0, primeMarge = 0, primeAdmin = 0, caTotal = 0, margeTotal = 0, margeStandard = 0, margeNoxia = 0;
    for (const [moisKey, b] of Object.entries(buck)) {
      const cStandard = commissionBaremeProgressif(b.margeStandard, BAREME_COMMERCIAL_STANDARD);
      const cNoxia = commissionBaremeProgressif(b.margeNoxia, BAREME_COMMERCIAL_NOXIA);
      commissionsParMoisGroupe[`${id}:${moisKey}`] = { standard: cStandard, noxia: cNoxia };
      commissionStandard += cStandard;
      commissionNoxia += cNoxia;
      caTotal += b.ca;
      margeStandard += b.margeStandard;
      margeNoxia += b.margeNoxia;
      margeTotal += b.margeStandard + b.margeNoxia;
      if (b.ca >= OBJECTIF_CA_MENSUEL) primeCA += PRIME_OBJECTIF_CA;
      if (b.margeStandard + b.margeNoxia >= OBJECTIF_MARGE_MENSUEL) primeMarge += PRIME_OBJECTIF_MARGE;
      if (suiviAdminSet.has(`${id}:${moisKey}`)) primeAdmin += PRIME_SUIVI_ADMINISTRATIF;
    }
    const commissionBareme = commissionStandard + commissionNoxia;
    byCommercial[id] = {
      caTotal, margeTotal, margeStandard, margeNoxia,
      commissionBareme, commissionStandard, commissionNoxia, primeCA, primeMarge, primeAdmin,
      commissionTotal: commissionBareme + primeCA + primeMarge + primeAdmin,
    };
  }

  return { byCommercial, chantiers, buckets, commissionsParMoisGroupe, moisPeriode, suiviAdminSet };
}

// Résultat commercial : CA vendu / marge / commission (barème progressif + primes
// d'objectifs) par commercial, mois civil ou année civile en cours (navigable), classé
// par CA vendu décroissant. Un admin voit tous les commerciaux (menu « Mes commerciaux »),
// un commercial ne voit que sa propre ligne (menu « Résultat commercial »).
//
// Le barème et les primes d'objectifs sont MENSUELS (cf. doc) : seuls les chantiers
// Terminés ET Encaissés comptent (clause de sécurisation), rattachés au mois de leur
// clôture. La vue "Année" agrège 12 calculs mensuels indépendants — elle n'applique
// jamais le barème à une marge annuelle globale. La liste `chantiers` de chaque
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
    const { start, endExclusive } = periodBounds(period, req.query.ref);
    const params = await getParametres();

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
        // Pertinent seulement en vue "mois" (l'objectif est mensuel) : état de la prime
        // pour le mois actuellement affiché, pour la case à cocher admin.
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
          const margeGroupe = c.dossierNoxia ? b.margeNoxia : b.margeStandard;
          const commissionGroupe = c.dossierNoxia ? groupe.noxia : groupe.standard;
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
        dossierNoxia: c.dossierNoxia,
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
      bareme: { standard: BAREME_COMMERCIAL_STANDARD, noxia: BAREME_COMMERCIAL_NOXIA },
      objectifs: { ca: OBJECTIF_CA_MENSUEL, marge: OBJECTIF_MARGE_MENSUEL, primeCA: PRIME_OBJECTIF_CA, primeMarge: PRIME_OBJECTIF_MARGE, primeAdmin: PRIME_SUIVI_ADMINISTRATIF },
      commerciaux: list,
    });
  } catch (error) {
    res.status(500).json({ error: 'Error computing commerciaux stats' });
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

// --- Comptes super administrateurs de départ ---
// Deux comptes doivent TOUJOURS exister avec le rôle SUPERADMIN, quelle que soit
// l'ancienneté de la base (installation neuve comme base déjà en production) :
//   - nelson@noxia-groupe.fr : compte de la direction, connexion via le SSO Microsoft
//     (aucun mot de passe local n'est créé — il n'en a pas besoin) ;
//   - admin@cybexia.fr : compte local « de base », qui garde son mot de passe existant.
// La liste est surchargeable via SUPERADMIN_EMAILS (emails séparés par des virgules).
// Traitement IDEMPOTENT et non destructif : un compte déjà présent est simplement promu
// SUPERADMIN (son nom, son mot de passe et ses rattachements sont conservés) ; un compte
// absent est créé. Aucun compte n'est jamais rétrogradé ici — retirer le rôle superadmin
// se fait depuis Administration > Utilisateurs, par un superadmin.
const SUPERADMIN_LOCAL_EMAIL = 'admin@cybexia.fr';
const DEFAULT_SUPERADMIN_EMAILS = ['nelson@noxia-groupe.fr', SUPERADMIN_LOCAL_EMAIL];

// « nelson@noxia-groupe.fr » -> « Nelson » : nom d'affichage par défaut d'un compte créé
// automatiquement, que son titulaire ou un superadmin pourra corriger ensuite.
function nameFromEmail(email: string): string {
  const local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local.replace(/\b\w/g, (c) => c.toUpperCase()) || email;
}

const ensureSuperAdmins = async () => {
  const emails = (process.env.SUPERADMIN_EMAILS || DEFAULT_SUPERADMIN_EMAILS.join(','))
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);

  for (const email of emails) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      if (existing.role !== ROLE_SUPERADMIN) {
        await prisma.user.update({ where: { id: existing.id }, data: { role: ROLE_SUPERADMIN } });
        console.log(`Compte promu super administrateur : ${email}`);
      }
      continue;
    }
    // Compte local « de base » : on ne lui pose un mot de passe que si ADMIN_PASSWORD est
    // fourni. Sans cela, aucun mot de passe par défaut n'est inventé (ce serait un accès
    // ouvert) : le compte existe, autorisé, et un superadmin lui en attribuera un depuis
    // Administration > Utilisateurs > « Changer Mdp ».
    const motDePasse = email === SUPERADMIN_LOCAL_EMAIL ? process.env.ADMIN_PASSWORD : undefined;
    await prisma.user.create({
      data: {
        email,
        name: email === SUPERADMIN_LOCAL_EMAIL ? 'Administrateur' : nameFromEmail(email),
        role: ROLE_SUPERADMIN,
        password: motDePasse ? await bcrypt.hash(motDePasse, 10) : null,
      },
    });
    console.log(
      `Compte super administrateur créé : ${email}` +
        (motDePasse ? ' (mot de passe local défini)' : " (connexion SSO ; définissez un mot de passe depuis Administration > Utilisateurs si besoin d'un accès local)")
    );
  }

  const total = await prisma.user.count({ where: { role: ROLE_SUPERADMIN } });
  if (total === 0) {
    console.warn('[AVERTISSEMENT] Aucun compte super administrateur : les modules de l\'application ne peuvent pas être pilotés.');
  }
};

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
  await ensureSuperAdmins();
  console.log(`Server running on port ${port}`);
});
