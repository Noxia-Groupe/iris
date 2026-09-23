import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const port = process.env.PORT || 3001;

// Ne pas révéler la techno serveur (en-tête `X-Powered-By: Express`).
app.disable('x-powered-by');

app.use(cors());
app.use(express.json());

// --- Sécurité : résolution du secret JWT ---
// En production, le secret est OBLIGATOIRE : on refuse de démarrer sinon.
export function resolveJwtSecret(secret = process.env.JWT_SECRET, environnement = process.env.NODE_ENV): string {
  if (!secret) {
    if (environnement === 'production') throw new Error('JWT_SECRET manquant : définissez-le dans server/.env avant de démarrer en production.');
    console.warn('[AVERTISSEMENT] JWT_SECRET non défini — clé de développement non sécurisée utilisée.');
    return 'dev_only_insecure_secret_change_me';
  }
  if (environnement === 'production' && /^CHANGE_ME(?:_|$)/.test(secret)) throw new Error('JWT_SECRET est resté la valeur d’exemple : générez-en un avec openssl rand -base64 48.');
  return secret;
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
// Un compte désactivé (départ de l'entreprise) n'est plus « autorisé » : il est traité
// exactement comme un email absent de la liste blanche. Ses données, elles, restent en base.
async function resolveAuthorizedSsoUser(email: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return prisma.user.findFirst({
    where: { email: normalized, actif: true },
    select: { id: true, name: true, email: true, role: true, theme: true, accesFinance: true, permissions: true },
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
  user?: { id: string; name: string; role: string; accesFinance: boolean; permissions: string[]; equipeIds: string[] };
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
    const user = await prisma.user.findUnique({ where: { id: payload.id }, select: { id: true, name: true, role: true, accesFinance: true, permissions: true, actif: true } });
    if (!user) {
      res.status(401).json({ error: 'Compte introuvable ou révoqué' });
      return;
    }
    // Désactivation en cours de session : les jetons déjà émis cessent d'être acceptés à la
    // requête suivante, sans attendre leur expiration (même logique que la relecture du rôle).
    if (!user.actif) {
      res.status(401).json({ code: 'COMPTE_DESACTIVE', error: 'Ce compte est désactivé.' });
      return;
    }
    const equipeIds = user.role === ROLE_RESPONSABLE
      // Les collaborateurs inactifs restent inclus : leur historique chantier ne disparaît pas du périmètre hiérarchique.
      ? (await prisma.user.findMany({ where: { responsableHierarchiqueId: user.id }, select: { id: true } })).map((collaborateur) => collaborateur.id)
      : [];
    (req as AuthRequest).user = { id: user.id, name: user.name, role: user.role, accesFinance: user.accesFinance, permissions: user.permissions, equipeIds };
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
const ROLE_ASSISTANTE_COMMERCIALE = 'ASSISTANTE_COMMERCIALE';
const ROLE_TECHNICIEN = 'TECHNICIEN';
const ROLE_COMPTABLE = 'COMPTABLE';
const ROLE_DIRECTEUR_COMMERCIAL = 'DIRECTEUR_COMMERCIAL';
const ROLE_RESPONSABLE = 'RESPONSABLE';

// Droits par défaut des types de compte. Ils restent volontairement limités aux modules
// existants ; SAV, maintenance, facturation, banques et objectifs seront ajoutés avec
// leurs routes métier, jamais anticipés par des accès fictifs.
const DEFAULT_USER_PERMISSIONS: Record<string, string[]> = {
  ADMIN: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read'],
  CONDUCTEUR_TRAVAUX: ['chantiers:read'],
  COMMERCIAL: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read'],
  [ROLE_ASSISTANTE_COMMERCIALE]: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read'],
  [ROLE_COMPTABLE]: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read'],
  [ROLE_DIRECTEUR_COMMERCIAL]: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read'],
  [ROLE_RESPONSABLE]: ['chantiers:read'],
  [ROLE_TECHNICIEN]: ['chantiers:read'],
};

function permissionsEffectives(user: { role: string; accesFinance?: boolean | null; permissions?: string[] }): string[] {
  const droits = new Set([...(DEFAULT_USER_PERMISSIONS[user.role] ?? []), ...(user.permissions ?? [])]);
  if (user.accesFinance) droits.add('finances:read');
  // Un superadministrateur ne dépend jamais d'une liste fragile de permissions.
  if (isSuperAdminRole(user.role)) API_SCOPES.forEach((permission) => droits.add(permission));
  return [...droits].sort();
}

function hasUserPermission(user: AuthRequest['user'], permission: string): boolean {
  return !!user && permissionsEffectives(user).includes(permission);
}

function requirePermission(permission: string): express.RequestHandler {
  return (req, res, next) => {
    if (!hasUserPermission((req as AuthRequest).user, permission)) return void res.status(403).json({ error: `Permission requise : ${permission}` });
    next();
  };
}

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

// --- API d'intégration machine-à-machine (agents et connecteurs) ---
// Deuxième porte d'entrée de l'application, à côté de Microsoft Entra ID : un agent
// (Hermes) ou un connecteur n'a pas de compte Microsoft et ne doit pas en avoir. Il
// s'authentifie avec une clé Iris, dont le secret n'est JAMAIS stocké — seule son
// empreinte SHA-256 l'est, et la valeur n'est affichée qu'une fois, à sa création.
//
// Le SHA-256 nu suffit ici, contrairement à un mot de passe : le secret est tiré de 32
// octets aléatoires (256 bits d'entropie), il n'est ni mémorisable ni devinable, donc il
// n'y a rien à ralentir par un bcrypt. Le hachage protège la base, pas la clé.
const API_SCOPES = [
  'clients:read', 'clients:write',
  'catalogue:read', 'catalogue:write',
  'equipements:read', 'equipements:write',
  'devis:read', 'devis:write',
  'company:read',
  // Domaine chantier : les chantiers eux-mêmes, leurs achats et leurs heures. Un agent
  // qui prépare un devis ou un rapport a besoin des trois, qui décrivent le même objet.
  'chantiers:read',
  // Montants vendus et marge. Scope SÉPARÉ, jamais inclus dans chantiers:read : côté
  // interface ces champs sont déjà réservés à certains rôles (cf. serializeChantier), une
  // clé d'intégration ne doit pas les obtenir par le simple fait de lire un chantier.
  'finances:read',
] as const;
type ApiScope = typeof API_SCOPES[number];
interface ApiRequest extends express.Request { apiKey?: { id: string; nom: string; scopes: string[] }; }

function apiKeyHash(key: string) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

const requireApiKey = (scope: ApiScope): express.RequestHandler => async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer iris_') ? header.slice(7) : '';
  if (!token) return void res.status(401).json({ error: 'Clé API Iris requise' });
  try {
    const key = await prisma.apiAccessKey.findUnique({ where: { secretHash: apiKeyHash(token) } });
    if (!key || !key.actif || key.revoqueLe || (key.expireLe && key.expireLe <= new Date())) {
      return void res.status(401).json({ error: 'Clé API invalide, expirée ou révoquée' });
    }
    if (!key.scopes.includes(scope)) {
      return void res.status(403).json({ error: `Scope requis : ${scope}` });
    }
    (req as ApiRequest).apiKey = { id: key.id, nom: key.nom, scopes: key.scopes };
    // Trace de dernière utilisation : sans attente ni échec bloquant, elle sert à repérer
    // une clé oubliée (jamais utilisée) ou toujours vivante avant de la révoquer.
    void prisma.apiAccessKey.update({ where: { id: key.id }, data: { dernierUsageLe: new Date() } }).catch(() => undefined);
    next();
  } catch {
    res.status(500).json({ error: "Erreur d'authentification de la clé API" });
  }
};

// Monte une même opération sur les deux portes d'entrée de l'application :
//   - /api/…    : session humaine (Entra ID ou accès de secours) ;
//   - /api/v1/… : clé d'intégration (agent, connecteur) portant le scope demandé.
// Un seul handler pour les deux : impossible qu'un agent contourne une règle appliquée à
// l'interface, ou qu'une correction ne soit faite que d'un côté.
//
// `gardes` protège la porte interface. Par défaut requireAdmin, qui convient aux
// référentiels (clients, catalogue). Les journaux d'achats et d'heures, eux, sont ouverts
// à tous les rôles : ce n'est pas l'accès à la route qui les restreint, mais le périmètre
// de ce qu'elle renvoie (cf. perimetreChantiers) — passer [] est donc délibéré, pas un
// oubli. La porte /api/v1 ne prend jamais de garde de rôle : une clé n'en a pas.
type MethodeHttp = 'get' | 'post' | 'put' | 'delete';
function routeMixte(
  methode: MethodeHttp,
  chemin: string,
  scope: ApiScope,
  handler: express.RequestHandler,
  gardes: express.RequestHandler[] = [requireAdmin],
) {
  app[methode](`/api${chemin}`, requireAuth, ...gardes, handler);
  app[methode](`/api/v1${chemin}`, requireApiKey(scope), handler);
}

// --- Périmètre de lecture du domaine chantier ---
// Une même liste (achats, heures, chantiers) ne montre pas la même chose selon qui la
// demande. Deux natures de porteur, deux façons de le décider :
//
//   - session humaine : le RÔLE décide. Un administrateur voit tout ; un conducteur de
//     travaux, les chantiers dont il est responsable ; un commercial, ceux qu'il a vendus.
//     C'est exactement la règle qu'applique déjà GET /api/chantiers.
//   - clé d'intégration : le SCOPE décide. Une clé ne représente personne en particulier,
//     elle n'a donc pas de rôle à interroger ; porter `chantiers:read` vaut autorisation
//     sur le domaine, et c'est au superadmin de ne délivrer que les scopes utiles.
//
// Renvoie un filtre Prisma applicable à un champ `chantier` imbriqué comme à un chantier
// racine ; `{}` signifie « aucune restriction ».
// Une affaire ANNULÉE sort du périmètre de tout le monde, administrateurs compris : elle
// n'a plus à peser sur une liste, un coût, une marge ou une commission. Elle n'est pas
// perdue pour autant — GET /api/chantiers/:id la rend toujours, avec le motif de son
// annulation, et c'est bien là qu'on va la chercher quand on veut comprendre.
const AFFAIRE_NON_ANNULEE = { statut: { not: 'ANNULE' } } as const;

function perimetreChantiers(req: express.Request): Prisma.ChantierWhereInput {
  return { ...AFFAIRE_NON_ANNULEE, ...perimetreDemandeur(req) };
}

function perimetreDemandeur(req: express.Request): Prisma.ChantierWhereInput {
  if ((req as ApiRequest).apiKey) return {};
  const user = (req as AuthRequest).user;
  if (!user || isAdminRole(user.role)) return {};
  if (user.role === 'COMMERCIAL') return { commercialId: user.id };
  if (user.role === ROLE_RESPONSABLE) return { responsableId: { in: [user.id, ...user.equipeIds] } };
  return { responsableId: user.id };
}

// Le chantier tel qu'il accompagne un achat ou un pointage : de quoi l'identifier, rien
// de plus. `include: { chantier: true }` renvoyait l'enregistrement ENTIER — budget
// global vendu, budget matériel, budget main-d'œuvre — à tout compte connecté, y compris
// ceux à qui serializeChantier masque précisément ces montants ailleurs. Un `select`
// explicite ferme la fuite par construction : ce qui n'est pas listé ne peut pas sortir.
const CHANTIER_LITE_SELECT = { id: true, nom: true, client: true, statut: true } as const;

// Les montants vendus et la marge ne sortent que pour un porteur autorisé : un rôle
// d'administration côté session, le scope finances:read côté clé d'intégration.
function peutVoirMontantsVendus(req: express.Request): boolean {
  const cle = (req as ApiRequest).apiKey;
  if (cle) return cle.scopes.includes('finances:read');
  return isAdminRole((req as AuthRequest).user?.role);
}

// Accès aux données financières : accordé au cas par cas, indépendamment du rôle
// (User.accesFinance, case « Finance » dans Administration > Utilisateurs). Un superadmin
// y accède toujours, sans avoir besoin de la case.
//
// L'autorisation est conservée bien qu'aucun écran ne l'utilise aujourd'hui : elle est
// native à Iris — pas héritée de l'intégration retirée — et c'est elle qui gardera la
// facturation (phase 8) puis les paiements et le rapprochement bancaire (phase 9). La
// retirer imposerait de supprimer la colonne pour la recréer à l'identique deux phases
// plus loin, en perdant au passage les droits déjà accordés aux utilisateurs.
export function peutVoirFinance(user: { role: string; accesFinance?: boolean | null } | undefined): boolean {
  return !!user && (isSuperAdminRole(user.role) || !!user.accesFinance);
}

// Écriture de suivi Travaux : réservée aux administrateurs, conducteurs affectés et
// responsables affectés (la hiérarchie élargie attend son modèle explicite).
const requireTravauxWrite: express.RequestHandler = (req, res, next) => {
  const role = (req as AuthRequest).user?.role;
  if (isAdminRole(role) || role === 'CONDUCTEUR_TRAVAUX' || role === ROLE_RESPONSABLE) return next();
  res.status(403).json({ error: 'Accès réservé au suivi Travaux.' });
};

// Statistiques Travaux : administration globale, responsable équipe déclarée, conducteur périmètre propre.
const requireTravauxRead: express.RequestHandler = (req, res, next) => {
  const role = (req as AuthRequest).user?.role;
  if (isAdminRole(role) || role === ROLE_RESPONSABLE || role === 'CONDUCTEUR_TRAVAUX') return next();
  res.status(403).json({ error: 'Accès réservé au suivi Travaux.' });
};

// Un commercial a un accès strictement en lecture à ses propres chantiers : ni création,
// ni modification (chantiers, achats, heures), et pas d'accès aux statistiques
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

// Référence d'affaire portée par le chantier : celle du devis Iris dont il est issu
// (A26-0001), attribuée par la séquence annuelle à la création du devis et recopiée
// telle quelle par la conversion. Le format est donc celui qu'Iris émet lui-même —
// `nouveauNumeroDevis()` en est la seule source. La saisie reste normalisée (espaces
// retirés, minuscule acceptée) pour qu'une référence recopiée à la main soit acceptée.
const FORMAT_NUMERO_DEVIS = /^A\d{2}-\d{4,}$/;

function normaliserNumeroDevis(valeur: unknown): string {
  return String(valeur ?? '').trim().toUpperCase();
}

// Retourne un message d'erreur si la référence est absente ou mal formée, sinon null.
function erreurNumeroDevis(numeroDevis: string): string | null {
  if (!numeroDevis) return 'Veuillez saisir la référence d’affaire.';
  if (!FORMAT_NUMERO_DEVIS.test(numeroDevis)) {
    return 'La référence d’affaire doit être au format AAA-NNNN : un A, l’année sur deux chiffres, un tiret et le rang (exemple : A26-0001).';
  }
  return null;
}

// Vérifie qu'aucun AUTRE chantier ne porte déjà cette référence. Le contrôle est
// volontairement applicatif et non porté par un index unique en base : un chantier peut
// couvrir deux affaires du même client, et un index rendrait ces cas immodifiables. La
// règle ne s'applique donc qu'aux références nouvellement saisies.
async function numeroDevisDejaPris(numeroDevis: string, chantierIdExclu?: string): Promise<boolean> {
  const existant = await prisma.chantier.findFirst({ where: { numeroDevis }, select: { id: true } });
  return !!existant && existant.id !== chantierIdExclu;
}

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
interface Parametres { margeCommercialeActive: boolean; planningActif: boolean; tauxAcompteDefaut: number }

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

const COMPANY_TEXT_FIELDS = [
  'raisonSociale', 'nomCommercial', 'siret', 'tvaIntra', 'adresse', 'codePostal',
  'ville', 'pays', 'telephone', 'email', 'siteWeb', 'logoUrl', 'prefixeFacture', 'prefixeAvoir', 'piedFacture',
] as const;
const COULEUR_HEX = /^#[0-9a-fA-F]{6}$/;
const FUSEAUX_HORAIRES_FRANCAIS = [
  'Europe/Paris', 'America/Guadeloupe', 'America/Martinique', 'America/Cayenne',
  'America/Miquelon', 'Indian/Mayotte', 'Indian/Reunion', 'Pacific/Noumea',
  'Pacific/Wallis', 'Pacific/Tahiti', 'Pacific/Marquesas', 'Pacific/Gambier',
] as const;
const FUSEAU_HORAIRE_PAR_DEFAUT = 'Europe/Paris';

function fuseauHoraireEntrepriseValide(fuseauHoraire: unknown): fuseauHoraire is typeof FUSEAUX_HORAIRES_FRANCAIS[number] {
  return typeof fuseauHoraire === 'string' && (FUSEAUX_HORAIRES_FRANCAIS as readonly string[]).includes(fuseauHoraire);
}

// Un jour civil dérivé d'un instant doit toujours être lu dans le fuseau de l'entreprise,
// jamais dans UTC ou dans le fuseau de la machine qui exécute le serveur.
function jourCivilEntreprise(instant: Date, fuseauHoraire = FUSEAU_HORAIRE_PAR_DEFAUT): string {
  const parties = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuseauHoraire, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const valeur = (type: Intl.DateTimeFormatPartTypes) => parties.find((partie) => partie.type === type)?.value;
  return `${valeur('year')}-${valeur('month')}-${valeur('day')}`;
}

function aujourdHuiEntreprise(fuseauHoraire = FUSEAU_HORAIRE_PAR_DEFAUT, instant = new Date()): string {
  return jourCivilEntreprise(instant, fuseauHoraire);
}

// Les références annuelles sont dérivées d'un instant de création : leur exercice est
// donc celui du jour civil de l'entreprise, jamais celui d'UTC ou de la machine serveur.
function anneeEntreprise(instant: Date, fuseauHoraire = FUSEAU_HORAIRE_PAR_DEFAUT): number {
  return Number(jourCivilEntreprise(instant, fuseauHoraire).slice(0, 4));
}

// La règle « pas de facture postdatée » compare des JOURS CIVILS de l'entreprise, jamais
// des instants. `instant` est injectable pour que la règle soit testable sans dépendre de
// l'heure qu'il est au moment où la suite tourne.
function dateEmissionEstFuture(dateEmission: string, fuseauHoraire: string, instant = new Date()): boolean {
  return dateSeuleEnJourCivil(dateEmission) > aujourdHuiEntreprise(fuseauHoraire, instant);
}

function dateSeuleEnJourCivil(dateSeule: Date | string): string {
  // Une date-seule est stockée à minuit UTC et ne désigne pas un instant : on lit ses
  // composantes telles quelles. La relire dans un fuseau la ferait basculer d'un jour
  // à l'ouest de Greenwich — et d'un exercice quand la date est un 1er janvier.
  return (typeof dateSeule === 'string' ? dateSeule : dateSeule.toISOString()).slice(0, 10);
}

function companySettingsPayload(body: Record<string, unknown>): Record<string, string | null> {
  const data: Record<string, string | null> = {};
  for (const field of COMPANY_TEXT_FIELDS) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string' || body[field].length > 2000) {
      throw new Error(`Champ société invalide : ${field}`);
    }
    data[field] = body[field].trim() || null;
  }
  for (const field of ['couleurPrimaire', 'couleurSecondaire'] as const) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string' || !COULEUR_HEX.test(body[field])) {
      throw new Error(`Couleur invalide : ${field}`);
    }
    data[field] = body[field].toLowerCase();
  }
  if (body.fuseauHoraire !== undefined) {
    if (!fuseauHoraireEntrepriseValide(body.fuseauHoraire)) throw new Error('Fuseau horaire invalide.');
    data.fuseauHoraire = body.fuseauHoraire;
  }
  return data;
}

const EMAIL_SIMPLE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function optionalClientText(value: unknown, field: string, max = 500): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw new Error(`Champ client invalide : ${field}`);
  return value.trim() || null;
}
function optionalClientEmail(value: unknown): string | null {
  const email = optionalClientText(value, 'email', 254);
  if (email && !EMAIL_SIMPLE.test(email)) throw new Error('Champ client invalide : email');
  return email?.toLowerCase() || null;
}
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Champ client invalide : ${field}`);
  return value;
}
function clientPayload(body: Record<string, unknown>, creation = false) {
  const raisonSociale = optionalClientText(body.raisonSociale, 'raisonSociale');
  if (creation && !raisonSociale) throw new Error('La raison sociale est obligatoire.');
  // Le SIREN est saisi (et lu sur un Kbis) par groupes de trois : « 123 456 789 ». On le
  // normalise avant de le valider, sinon la mise en forme habituelle serait refusée.
  const sirenSaisi = optionalClientText(body.siren, 'siren', 20);
  const siren = sirenSaisi ? sirenSaisi.replace(/[\s.-]/g, '') : null;
  if (siren && !/^\d{9}$/.test(siren)) throw new Error('Le SIREN doit contenir 9 chiffres.');
  const data: Record<string, unknown> = {};
  if (raisonSociale !== null) data.raisonSociale = raisonSociale;
  for (const field of ['nomCommercial', 'tvaIntra', 'telephone'] as const) {
    if (body[field] !== undefined) data[field] = optionalClientText(body[field], field);
  }
  if (body.siren !== undefined) data.siren = siren;
  if (body.email !== undefined) data.email = optionalClientEmail(body.email);
  const actif = optionalBoolean(body.actif, 'actif');
  if (actif !== undefined) data.actif = actif;
  return data;
}
function contactPayload(body: Record<string, unknown>, creation = false) {
  const nom = optionalClientText(body.nom, 'nom');
  if (creation && !nom) throw new Error('Le nom du contact est obligatoire.');
  const data: Record<string, unknown> = {};
  if (nom) data.nom = nom;
  for (const field of ['prenom', 'fonction', 'telephone'] as const) {
    if (body[field] !== undefined) data[field] = optionalClientText(body[field], field);
  }
  if (body.email !== undefined) data.email = optionalClientEmail(body.email);
  for (const field of ['principal', 'estDecisionnaire', 'estSignataire'] as const) {
    const value = optionalBoolean(body[field], field);
    if (value !== undefined) data[field] = value;
  }
  return data;
}
function sitePayload(body: Record<string, unknown>, creation = false) {
  const required = ['nom', 'adresse', 'codePostal', 'ville'] as const;
  const data: Record<string, unknown> = {};
  for (const field of [...required, 'complementAdresse', 'pays'] as const) {
    const value = optionalClientText(body[field], field);
    if (creation && required.includes(field as any) && !value) throw new Error(`Le champ ${field} est obligatoire.`);
    if (value !== null) data[field] = value;
  }
  for (const field of ['estSiegeSocial', 'estSiteFacturation', 'estSiteIntervention', 'principal'] as const) {
    const value = optionalBoolean(body[field], field);
    if (value !== undefined) data[field] = value;
  }
  return data;
}

async function getCompanySettings() {
  return prisma.companySettings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  });
}

// --- Calcul centralisé des métriques d'un chantier (source unique de vérité) ---
// La marge commerciale n'est calculée que si elle est activée ET pour les profils
// autorisés à la voir (admin partout ; conducteur responsable sur SA fiche chantier
// uniquement, cf. GET /api/chantiers/:id — pas sur la liste ni le tableau de bord).
function computeChantierMetrics(chantier: any, params: Parametres, canSeeMarge: boolean) {
  // Défense en profondeur : une archive ne doit jamais déformer un coût, une marge ou une commission.
  const achats: any[] = (chantier.achats || []).filter((a: any) => !a.archivedAt);
  const pointages: any[] = (chantier.pointages || []).filter((p: any) => !p.archivedAt);

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
  // rémunération commerciale" (cf. ParametresRemuneration et
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

// --- Interventions SAV natives ---
async function journaliserIntervention(tx: Prisma.TransactionClient, req: AuthRequest, action: string, intervention: unknown, avant?: unknown, motif?: string) {
  const user = req.user!;
  const cibleId = String((intervention as { id: string }).id);
  await tx.journalSaisieChantier.create({ data: {
    chantierId: null, interventionId: cibleId, cible: 'INTERVENTION', cibleId, action,
    auteurId: user.id, auteurNom: user.name,
    avant: avant ? valeurJournal(avant) as Prisma.InputJsonValue : undefined,
    apres: valeurJournal(intervention) as Prisma.InputJsonValue, motif: motif || null,
  } });
}

async function journaliserContrat(tx: Prisma.TransactionClient, req: AuthRequest, action: 'SUSPENSION' | 'REACTIVATION' | 'CLOTURE', contrat: unknown, avant: unknown, motif?: string) {
  const user = req.user!;
  const cibleId = String((contrat as { id: string }).id);
  await tx.journalSaisieChantier.create({ data: {
    chantierId: null, interventionId: null, contratMaintenanceId: cibleId, cible: 'CONTRAT', cibleId, action,
    auteurId: user.id, auteurNom: user.name,
    avant: valeurJournal(avant) as Prisma.InputJsonValue,
    apres: valeurJournal(contrat) as Prisma.InputJsonValue,
    motif: motif || null,
  } });
}

// --- Facturation française native ---
const factureInclude = { client: { select: { id: true, raisonSociale: true } }, factureOrigine: { select: { id: true, numero: true } }, avoirs: { select: { id: true, numero: true, type: true, statut: true, estAvoirAnnulation: true }, orderBy: { createdAt: 'asc' as const } }, mentionsLegalesVersion: { select: { id: true, version: true, mentions: true, cgv: true, penalites: true, escompte: true, publieeLe: true } }, lignes: { orderBy: { ordre: 'asc' as const } }, ventilationTva: { orderBy: { tauxTva: 'asc' as const } } };

// L'adresse du client est sélectionnée depuis son site de facturation, puis figée à l'émission.
const SITE_FACTURATION_ORDRE = [{ estSiteFacturation: 'desc' as const }, { principal: 'desc' as const }, { estSiegeSocial: 'desc' as const }, { nom: 'asc' as const }];
function formaterAdresseFacturation(site: { adresse: string; complementAdresse: string | null; codePostal: string; ville: string; pays: string }) {
  return [site.adresse, site.complementAdresse, `${site.codePostal} ${site.ville}`.trim(), site.pays && site.pays !== 'France' ? site.pays : null].filter(Boolean).join('\n');
}

function formatMontantFacture(valeur: unknown) {
  return `${Number(valeur).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function formatDateFacture(valeur: Date | string) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC' }).format(new Date(valeur)).replace(/\//g, '-');
}

async function rendreDocumentFacturePdf(facture: any, societe: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Facture ${facture.numero}` } });
    const morceaux: Buffer[] = [];
    pdf.on('data', (morceau: Buffer) => morceaux.push(morceau));
    pdf.on('end', () => resolve(Buffer.concat(morceaux)));
    pdf.on('error', reject);
    // Les polices standards PDFKit sont WinAnsi : normaliser les caractères typographiques non encodables avant impression.
    const winAnsi = (texte: string) => [...String(texte)].map((caractere) => {
      const code = caractere.codePointAt(0);
      if (code === 0x2007 || code === 0x2009 || code === 0x202f) return ' ';
      if (code === 0x2011) return '-';
      return caractere;
    }).join('');
    const ligne = (texte: string, options: { taille?: number } & Record<string, unknown> = {}) => {
      const { taille, ...reste } = options;
      if (taille) pdf.fontSize(taille);
      return pdf.text(winAnsi(texte), reste as any);
    };
    const replier = (texte: string, largeur: number) => {
      const lignes: string[] = []; let courante = '';
      for (let mot of String(texte).split(/\s+/).filter(Boolean)) {
        while (mot.length > largeur) { if (courante) { lignes.push(courante); courante = ''; } lignes.push(mot.slice(0, largeur)); mot = mot.slice(largeur); }
        const essai = courante ? `${courante} ${mot}` : mot;
        if (essai.length <= largeur) courante = essai; else { lignes.push(courante); courante = mot; }
      }
      if (courante || !lignes.length) lignes.push(courante); return lignes;
    };
    const legal = facture.mentionsLegalesVersion;
    const couleurPrimaire = /^#[0-9a-f]{6}$/i.test(societe.couleurPrimaire || '') ? societe.couleurPrimaire : '#1e3a8a';
    // Une valeur large ne doit jamais se coller à la colonne précédente : on garde au moins un séparateur.
    const colonne = (valeur: string, largeur: number) => (valeur.length >= largeur ? ` ${valeur}` : valeur.padStart(largeur));
    const colonnes = (a: string, b: string, c: string, d: string, e: string) => a.padEnd(38) + colonne(b, 9) + colonne(c, 16) + colonne(d, 8) + colonne(e, 16);

    // L'identité de l'émetteur est portée par la version légale figée à l'émission, jamais par les paramètres vivants.
    pdf.fillColor(couleurPrimaire);
    const estAvoir = facture.type === 'AVOIR';
    ligne(`${estAvoir ? 'AVOIR' : 'FACTURE'} ${facture.numero}`, { taille: 18 });
    pdf.fillColor('#000000');
    ligne(`Émise le ${formatDateFacture(facture.dateEmission)} · Échéance : ${formatDateFacture(facture.dateEcheance)}`, { taille: 10 });
    if (estAvoir) ligne(`Facture d’origine : ${facture.factureOrigine?.numero || 'référence indisponible'}`, { taille: 10 });
    // Les documents de statuts post-émission doivent expliciter leur situation : un PDF
    // annulé muet serait indistinguable d'une créance toujours due.
    if (facture.statut === 'ANNULEE') { pdf.fillColor('#b91c1c'); ligne('FACTURE ANNULÉE — ce document ne vaut pas justificatif de créance.', { taille: 12 }); pdf.fillColor('#000000'); }
    else if (facture.statut === 'REGLEE') ligne('Facture réglée.', { taille: 10 });
    pdf.moveDown();
    ligne('Émetteur', { taille: 11 });
    ligne(legal.mentions, { taille: 9 });
    pdf.moveDown();
    ligne('Client', { taille: 11 });
    ligne(facture.clientRaisonSociale, { taille: 12 });
    ligne(facture.clientAdresse, { taille: 9 });
    pdf.moveDown();
    pdf.font('Courier');
    ligne(colonnes('Désignation', 'Qté', 'PU HT', 'TVA', 'Total HT'), { taille: 9 });
    for (const item of facture.lignes) {
      const [premiere, ...suite] = replier(String(item.designation), 36);
      ligne(colonnes(premiere, String(item.quantite), formatMontantFacture(item.prixUnitaireHt), `${Number(item.tauxTva)} %`, formatMontantFacture(item.totalHt)), { taille: 9 });
      for (const reste of suite) ligne(reste, { taille: 9 });
    }
    pdf.font('Helvetica');
    pdf.moveDown();
    const tvaParTaux = ventilationFacture(facture).map(ventilation => ({ taux: ventilation.tauxTva, ht: ventilation.totalHt, tva: ventilation.totalTva }));
    ligne(`Total HT : ${formatMontantFacture(facture.totalHt)}`, { taille: 10, align: 'right' });
    for (const cumul of tvaParTaux) ligne(`TVA ${cumul.taux} % sur ${formatMontantFacture(cumul.ht)} : ${formatMontantFacture(cumul.tva)}`, { taille: 10, align: 'right' });
    ligne(`TVA totale : ${formatMontantFacture(facture.totalTva)}`, { taille: 10, align: 'right' });
    ligne(`Total TTC : ${formatMontantFacture(facture.totalTtc)}`, { taille: 13, align: 'right' });
    pdf.moveDown();
    ligne(`Mentions légales et CGV — version ${legal.version}`, { taille: 10 });
    ligne(legal.cgv, { taille: 8 });
    ligne(`Pénalités : ${legal.penalites}`, { taille: 8 });
    if (legal.escompte) ligne(`Escompte : ${legal.escompte}`, { taille: 8 });
    pdf.end();
  });
}
const PLAFOND_MONTANT = 9_999_999_999.99;
class FactureInvalideError extends Error {}

type LigneTaxable = { tauxTva: unknown; totalHt: unknown };
const tauxUtilises = (lignes: LigneTaxable[]) => [...new Set(lignes.map(ligne => Number(ligne.tauxTva)))];
const baseHtDuTaux = (lignes: LigneTaxable[], taux: number) => centimes(lignes.filter(ligne => Number(ligne.tauxTva) === taux).reduce((somme, ligne) => somme + Number(ligne.totalHt), 0));
const tvaDuTaux = (lignes: LigneTaxable[], taux: number) => {
  const baseCentimes = entierDecimal(baseHtDuTaux(lignes, taux), 2);
  const millièmesTaux = entierDecimal(taux, 3);
  return Number((baseCentimes * millièmesTaux + 50000n) / 100000n) / 100;
};
type VentilationTva = { tauxTva: number; totalHt: number; totalTva: number; totalTtc: number };
const ventilationTvaDerivee = (lignes: LigneTaxable[]): VentilationTva[] => tauxUtilises(lignes).sort((a, b) => a - b).map(tauxTva => {
  const totalHt = baseHtDuTaux(lignes, tauxTva);
  const totalTva = tvaDuTaux(lignes, tauxTva);
  return { tauxTva, totalHt, totalTva, totalTtc: centimes(totalHt + totalTva) };
});
// Le fallback ne sert qu'aux documents historiques, qui n'ont volontairement pas été réécrits.
const ventilationFacture = (facture: { lignes: LigneTaxable[]; ventilationTva?: { tauxTva: unknown; totalHt: unknown; totalTva: unknown; totalTtc: unknown }[] }): VentilationTva[] =>
  facture.ventilationTva?.length ? facture.ventilationTva.map(v => ({ tauxTva: Number(v.tauxTva), totalHt: Number(v.totalHt), totalTva: Number(v.totalTva), totalTtc: Number(v.totalTtc) })) : ventilationTvaDerivee(facture.lignes);

function lignesAvoirPartiel(brutes: unknown): { ordre: number; designation: string; nature: string; quantite: number; prixUnitaireHt: number; tauxTva: number; totalHt: number; totalTtc: number }[] {
  const lignesBrutes = Array.isArray(brutes) ? brutes : [];
  if (!lignesBrutes.length) throw new FactureInvalideError('Un avoir partiel doit contenir au moins une ligne.');
  return lignesBrutes.map((ligne: any, ordre: number) => {
    const designation = String(ligne?.designation || '').trim();
    const quantite = nombreDecimalNonNegatif(ligne?.quantite, 9, false, 3);
    const prixUnitaireHt = nombreDecimalNonNegatif(ligne?.prixUnitaireHt, 10, true);
    const tauxTva = nombreDecimalNonNegatif(ligne?.tauxTva, 3, true);
    const nature = String(ligne?.nature || 'PRESTATION');
    if (!designation || designation.length > 500 || !['PRESTATION', 'ARTICLE'].includes(nature) || quantite === null || quantite <= 0 || prixUnitaireHt === null || prixUnitaireHt <= 0 || tauxTva === null || tauxTva > 100) throw new FactureInvalideError('Ligne d’avoir partiel invalide.');
    const totalHt = arrondiCommercialLigneHt(ligne?.quantite, ligne?.prixUnitaireHt);
    const totalTtc = centimesTtcLigne(totalHt, ligne?.tauxTva);
    if (totalTtc > PLAFOND_MONTANT) throw new FactureInvalideError('Montant de ligne hors des limites acceptées.');
    return { ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc };
  });
}
class AvoirPlafondError extends Error {}

app.get('/api/factures', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const factures = await prisma.facture.findMany({ include: factureInclude, orderBy: [{ dateEmission: 'desc' }, { createdAt: 'desc' }] });
    res.json(decimalToNumber(factures));
  } catch (error) { res.status(500).json({ error: 'Lecture des factures impossible.' }); }
});

app.get('/api/factures/:id/document.pdf', requireAuth, requireAdmin, async (req, res) => {
  try {
    const facture = await prisma.facture.findUnique({ where: { id: String(req.params.id) }, include: factureInclude });
    if (!facture) return res.status(404).json({ error: 'Facture introuvable.' });
    if (!['EMISE', 'REGLEE', 'ANNULEE'].includes(facture.statut)) return res.status(409).json({ error: 'Le document est disponible uniquement pour une facture émise.' });
    if (!facture.mentionsLegalesVersion) return res.status(409).json({ error: 'Les mentions légales figées sont introuvables.' });
    if (!facture.clientAdresse) return res.status(409).json({ error: 'L’adresse de facturation figée est absente de cette facture : le document ne peut pas être imprimé sans cette mention obligatoire.' });
    const pdf = await rendreDocumentFacturePdf(decimalToNumber(facture), await getCompanySettings());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${facture.numero}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    return res.send(pdf);
  } catch { return res.status(500).json({ error: 'Lecture du document de facture impossible.' }); }
});

app.get('/api/factures/:id/journal', requireAuth, requireAdmin, async (req, res) => {
  try {
    const factureId = String(req.params.id);
    const facture = await prisma.facture.findUnique({ where: { id: factureId }, select: { id: true } });
    if (!facture) return res.status(404).json({ error: 'Facture introuvable.' });
    res.json(await prisma.journalFacture.findMany({ where: { factureId }, orderBy: { createdAt: 'asc' } }));
  } catch { res.status(500).json({ error: 'Lecture du journal de facture impossible.' }); }
});

app.get('/api/factures/:id/tracabilite', requireAuth, requireAdmin, async (req, res) => {
  try {
    const facture = await prisma.facture.findUnique({ where: { id: String(req.params.id) }, include: {
      client: { select: { id: true, raisonSociale: true } },
      chantier: { select: { id: true, nom: true, numeroDevis: true, statut: true } },
      intervention: { select: { id: true, reference: true, titre: true, chantierId: true, contratMaintenanceId: true } },
      contratMaintenance: { select: { id: true, titre: true, siteId: true } },
    } });
    if (!facture) return res.status(404).json({ error: 'Facture introuvable.' });
    const chantierId = facture.chantierId || facture.intervention?.chantierId || null;
    const devis = chantierId ? await prisma.devisConversion.findFirst({ where: { cibleType: 'CHANTIER', cibleId: chantierId }, include: { devis: { select: { id: true, numero: true, objet: true } } } }) : null;
    res.json(decimalToNumber({ facture, devis: devis?.devis || null }));
  } catch { res.status(500).json({ error: 'Lecture de la traçabilité impossible.' }); }
});

app.post('/api/factures', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const clientId = String(req.body?.clientId || '');
    const dateEmission = dateIsoStricte(req.body?.dateEmission);
    const dateEcheance = dateIsoStricte(req.body?.dateEcheance);
    if (!dateEmission || !dateEcheance) return res.status(400).json({ error: 'Les dates doivent être valides au format JJ-MM-AAAA.' });
    if (dateEcheance < dateEmission) return res.status(400).json({ error: 'L’échéance ne peut pas précéder la date d’émission.' });
    const societe = await getCompanySettings();
    const fuseauHoraire = societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
    if (dateEmissionEstFuture(dateEmission, fuseauHoraire)) return res.status(400).json({ error: "La date d’émission ne peut pas être future." });
    const client = await prisma.client.findFirst({ where: { id: clientId, actif: true }, select: { id: true, raisonSociale: true } });
    if (!client) return res.status(404).json({ error: 'Client introuvable.' });
    const origine = String(req.body?.origine || '');
    const chantierId = req.body?.chantierId ? String(req.body.chantierId) : null;
    const interventionId = req.body?.interventionId ? String(req.body.interventionId) : null;
    const contratMaintenanceId = req.body?.contratMaintenanceId ? String(req.body.contratMaintenanceId) : null;
    const motifHorsAffaire = String(req.body?.motifHorsAffaire || '').trim() || null;
    const rattachements = [chantierId, interventionId, contratMaintenanceId].filter(Boolean);
    if (!['CHANTIER', 'INTERVENTION', 'CONTRAT', 'HORS_AFFAIRE'].includes(origine) || (origine === 'HORS_AFFAIRE' ? rattachements.length !== 0 || !motifHorsAffaire || motifHorsAffaire.length < 3 : rattachements.length !== 1)) return res.status(400).json({ error: 'L’origine de la facture doit être déclarée et cohérente.' });
    if ((origine === 'CHANTIER' && !chantierId) || (origine === 'INTERVENTION' && !interventionId) || (origine === 'CONTRAT' && !contratMaintenanceId)) return res.status(400).json({ error: 'Le rattachement ne correspond pas à l’origine déclarée.' });
    // Ne jamais déduire l'appartenance par un libellé : les trois origines portent un clientId explicite.
    // Une origine étrangère ou inexistante répond 404 afin de ne pas divulguer son existence.
    if (origine === 'CHANTIER') {
      const chantier = await prisma.chantier.findFirst({ where: { id: chantierId!, clientId }, select: { id: true, statut: true } });
      if (!chantier) return res.status(404).json({ error: 'Affaire facturable introuvable.' });
      if (chantier.statut === 'ANNULE') return res.status(409).json({ error: 'Une affaire annulée ne peut pas être facturée.' });
    }
    if (origine === 'INTERVENTION' && !await prisma.intervention.findFirst({ where: { id: interventionId!, clientId }, select: { id: true } })) return res.status(404).json({ error: 'Intervention facturable introuvable.' });
    if (origine === 'CONTRAT' && !await prisma.contratMaintenance.findFirst({ where: { id: contratMaintenanceId!, clientId }, select: { id: true } })) return res.status(404).json({ error: 'Contrat facturable introuvable.' });
    const lignesBrutes = Array.isArray(req.body?.lignes) ? req.body.lignes : [];
    if (!lignesBrutes.length) return res.status(400).json({ error: 'Une facture doit contenir au moins une ligne.' });
    const lignes = lignesBrutes.map((ligne: any, ordre: number) => {
      const designation = String(ligne?.designation || '').trim();
      const quantite = nombreDecimalNonNegatif(ligne?.quantite, 9, false, 3);
      const prixUnitaireHt = nombreDecimalNonNegatif(ligne?.prixUnitaireHt, 10, true);
      const tauxTva = nombreDecimalNonNegatif(ligne?.tauxTva, 3, true);
      const nature = String(ligne?.nature || 'PRESTATION');
      if (!designation || designation.length > 500 || !['PRESTATION', 'ARTICLE'].includes(nature) || quantite === null || quantite <= 0 || prixUnitaireHt === null || tauxTva === null || tauxTva > 100) throw new FactureInvalideError('Ligne de facture invalide.');
      const totalHt = arrondiCommercialLigneHt(ligne?.quantite, ligne?.prixUnitaireHt);
      const totalTtc = centimesTtcLigne(totalHt, ligne?.tauxTva);
      if (totalTtc > PLAFOND_MONTANT) throw new FactureInvalideError('Montant de ligne hors des limites acceptées.');
      return { ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc };
    });
    const totalHt = centimes(lignes.reduce((s: number, ligne: { totalHt: number }) => s + ligne.totalHt, 0));
    // La TVA légale s'arrondit sur la base HT cumulée de chaque taux, jamais ligne par ligne.
    const ventilationTva = ventilationTvaDerivee(lignes);
    const totalTva = centimes(ventilationTva.reduce((somme, ventilation) => somme + ventilation.totalTva, 0));
    const totalTtc = centimes(totalHt + totalTva);
    if (totalTtc > PLAFOND_MONTANT) throw new FactureInvalideError('Montant de facture hors des limites acceptées.');
    const facture = await prisma.$transaction(async (tx) => {
      const creee = await tx.facture.create({ data: { clientId, clientRaisonSociale: client.raisonSociale, origine, chantierId, interventionId, contratMaintenanceId, motifHorsAffaire, dateEmission, dateEcheance, totalHt, totalTva, totalTtc, createdById: req.user!.id, lignes: { create: lignes }, ventilationTva: { create: ventilationTva } }, include: factureInclude });
      await tx.journalFacture.create({ data: { factureId: creee.id, acteurId: req.user!.id, action: 'CREATION_BROUILLON', detail: `Origine ${origine}` } });
      return creee;
    });
    res.status(201).json(decimalToNumber(facture));
  } catch (error) {
    if (error instanceof FactureInvalideError) return res.status(400).json({ error: error.message });
    res.status(500).json({ error: 'Création de facture impossible.' });
  }
});

// Paramétrage comptable : aucun compte n'est préchargé. L'export devra refuser toute règle absente.
const CLES_COMPTABLES = ['CLIENT', 'VENTE_PRESTATION', 'VENTE_ARTICLE', 'JOURNAL_VENTES'];
const NATURES_ATTENDUES: Record<string, string[]> = { CLIENT: ['ACTIF'], VENTE_PRESTATION: ['PRODUIT'], VENTE_ARTICLE: ['PRODUIT'] };
app.get('/api/facturation/prete-a-facturer', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [settings, comptes, regles, reglesTva, tauxFactures, mentions, clientsSansSite] = await Promise.all([
      getCompanySettings(), prisma.compteComptable.count({ where: { actif: true } }),
      prisma.regleComptable.findMany({ where: { cle: { in: CLES_COMPTABLES } }, include: { compte: true } }),
      prisma.regleTvaComptable.findMany({ where: { compte: { actif: true } }, select: { taux: true } }),
      prisma.factureLigne.findMany({ where: { facture: { statut: { in: ['EMISE', 'REGLEE', 'ANNULEE'] } } }, distinct: ['tauxTva'], select: { tauxTva: true } }),
      prisma.mentionsLegalesVersion.findFirst({ where: { actif: true, publieeLe: { not: null } }, select: { id: true } }),
      prisma.client.count({ where: { actif: true, sites: { none: {} } } }),
    ]);
    const parCle = new Map(regles.map(regle => [regle.cle, regle]));
    const reglesOk = CLES_COMPTABLES.every(cle => cle === 'JOURNAL_VENTES' ? Boolean(parCle.get(cle)?.journal) : Boolean(parCle.get(cle)?.compte?.actif));
    const tauxCouverts = new Set(reglesTva.map(regle => Number(regle.taux)));
    const tauxManquants = [...new Set(tauxFactures.map(ligne => Number(ligne.tauxTva)))].filter(taux => taux !== 0 && !tauxCouverts.has(taux)).sort((a, b) => a - b);
    // L'export ne refuse que les taux non nuls déjà facturés sans compte. Le 0 % d'une
    // autoliquidation BTP est donc exempt : imposer un compte TVA dans ce cas créerait un faux barrage.
    const tvaOk = tauxCouverts.size > 0 && tauxManquants.length === 0;
    const prefixe = (settings.prefixeFacture || '').trim();
    const controles = [
      { cle: 'PLAN_COMPTABLE', bloquant: true, pret: comptes > 0, libelle: 'Plan comptable', detail: comptes > 0 ? `${comptes} compte(s) actif(s).` : 'Importez ou créez au moins un compte.', route: '/comptabilite' },
      { cle: 'REGLES_COMPTABLES', bloquant: true, pret: reglesOk, libelle: 'Règles comptables', detail: reglesOk ? 'Les règles client, ventes et journal sont renseignées.' : 'Renseignez les comptes client, ventes et le journal.', route: '/comptabilite' },
      { cle: 'TVA', bloquant: tauxManquants.length > 0, pret: tvaOk, libelle: 'Règles TVA', detail: tauxManquants.length ? `Aucun compte TVA pour ${tauxManquants.map(taux => `${taux} %`).join(', ')} — ce taux est déjà facturé, l’export comptable sera refusé.` : !tauxCouverts.size ? 'Aucun compte TVA associé. Une entreprise qui ne facture qu’à 0 % (autoliquidation BTP) n’en a pas besoin ; sinon, associez un compte avant la première facture à un taux non nul.' : `${tauxCouverts.size} taux configuré(s) ; tous les taux déjà facturés sont couverts.`, route: '/comptabilite' },
      { cle: 'MENTIONS_LEGALES', bloquant: true, pret: Boolean(mentions), libelle: 'Mentions légales et CGV', detail: mentions ? 'Une version publiée est active.' : 'Publiez une version légale validée.', route: '/mentions-legales' },
      { cle: 'PREFIXE_FACTURE', bloquant: false, pret: Boolean(prefixe), libelle: 'Préfixe de facture', detail: prefixe ? `Préfixe actuel : ${prefixe}.` : 'Aucun préfixe défini : les numéros utiliseront « F » par défaut.', route: null },
      { cle: 'ADRESSES_CLIENTS', bloquant: false, pret: clientsSansSite === 0, libelle: 'Adresses de facturation', detail: clientsSansSite === 0 ? 'Tous les clients actifs portent au moins un site.' : `${clientsSansSite} client(s) actif(s) sans aucun site : l’émission de leurs factures sera refusée.`, route: '/clients' },
    ];
    res.json({ pret: controles.every(controle => !controle.bloquant || controle.pret), controles });
  } catch { res.status(500).json({ error: 'Lecture des prérequis de facturation impossible.' }); }
});
app.get('/api/comptabilite', requireAuth, requireAdmin, async (_req, res) => {
  try { const [comptes, regles, reglesTva] = await Promise.all([prisma.compteComptable.findMany({ orderBy: { code: 'asc' } }), prisma.regleComptable.findMany({ include: { compte: true }, orderBy: { cle: 'asc' } }), prisma.regleTvaComptable.findMany({ include: { compte: true }, orderBy: { taux: 'asc' } })]); res.json(decimalToNumber({ comptes, regles, reglesTva })); }
  catch { res.status(500).json({ error: 'Lecture du paramétrage comptable impossible.' }); }
});
app.post('/api/comptabilite/comptes', requireAuth, requireAdmin, async (req, res) => {
  try { const code = String(req.body?.code || '').trim(), libelle = String(req.body?.libelle || '').trim(), nature = String(req.body?.nature || '');
    if (!/^\d{3,12}$/.test(code) || !libelle || !['ACTIF', 'PASSIF', 'PRODUIT', 'CHARGE', 'TVA'].includes(nature)) return res.status(400).json({ error: 'Compte comptable invalide.' });
    const compte = await prisma.compteComptable.create({ data: { code, libelle, nature } }); res.status(201).json(compte);
  } catch (error) { if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'Ce compte existe déjà.' }); res.status(500).json({ error: 'Création du compte impossible.' }); }
});
app.post('/api/comptabilite/importer', requireAuth, requireAdmin, async (req, res) => {
  const lignes = Array.isArray(req.body?.lignes) ? req.body.lignes : [];
  if (!lignes.length || lignes.length > 5000) return res.status(400).json({ error: 'Le plan doit contenir entre 1 et 5 000 lignes.' });
  const vus = new Set<string>(); const erreurs: { ligne: number; erreur: string }[] = [];
  const comptes = lignes.map((ligne: any, index: number) => {
    const code = String(ligne?.code || '').trim(), libelle = String(ligne?.libelle || '').trim(), nature = String(ligne?.nature || '');
    if (!/^\d{3,12}$/.test(code) || !libelle || !['ACTIF', 'PASSIF', 'PRODUIT', 'CHARGE', 'TVA'].includes(nature)) erreurs.push({ ligne: index + 1, erreur: 'Code, libellé ou nature invalide.' });
    if (vus.has(code)) erreurs.push({ ligne: index + 1, erreur: 'Code dupliqué dans le fichier.' }); vus.add(code); return { code, libelle, nature };
  });
  if (erreurs.length) return res.status(400).json({ error: 'Import refusé : corrigez les lignes signalées.', erreurs });
  try { const resultat = await prisma.compteComptable.createMany({ data: comptes, skipDuplicates: true }); res.status(201).json({ importes: resultat.count, ignores: comptes.length - resultat.count }); }
  catch { res.status(500).json({ error: 'Import du plan comptable impossible.' }); }
});
app.put('/api/comptabilite/regles/:cle', requireAuth, requireAdmin, async (req, res) => {
  try { const cle = String(req.params.cle || ''); if (!CLES_COMPTABLES.includes(cle)) return res.status(400).json({ error: 'Règle comptable inconnue.' });
    const compteId = req.body?.compteId ? String(req.body.compteId) : null; const journal = req.body?.journal == null ? null : String(req.body.journal).trim() || null;
    if (cle === 'JOURNAL_VENTES' ? !journal : !compteId) return res.status(400).json({ error: 'Paramétrage de règle incomplet.' });
    if (journal && !/^[A-Z0-9]{1,8}$/.test(journal)) return res.status(400).json({ error: 'Le code journal doit compter au plus 8 caractères alphanumériques majuscules.' });
    const compte = compteId ? await prisma.compteComptable.findFirst({ where: { id: compteId, actif: true } }) : null;
    if (compteId && !compte) return res.status(404).json({ error: 'Compte comptable actif introuvable.' });
    if (compte && NATURES_ATTENDUES[cle] && !NATURES_ATTENDUES[cle].includes(compte.nature)) return res.status(400).json({ error: `Cette règle attend un compte de nature ${NATURES_ATTENDUES[cle].join(' ou ')}.` });
    const regle = await prisma.regleComptable.upsert({ where: { cle }, create: { cle, compteId, journal }, update: { compteId, journal }, include: { compte: true } }); res.json(regle);
  } catch { res.status(500).json({ error: 'Mise à jour du paramétrage impossible.' }); }
});

app.put('/api/comptabilite/tva/:taux', requireAuth, requireAdmin, async (req, res) => {
  try { const taux = nombreDecimalNonNegatif(req.params.taux, 3, true); const compteId = String(req.body?.compteId || '');
    if (taux === null || taux > 100) return res.status(400).json({ error: 'Taux de TVA invalide.' });
    const compte = await prisma.compteComptable.findFirst({ where: { id: compteId, actif: true } });
    if (!compte) return res.status(404).json({ error: 'Compte TVA actif introuvable.' });
    if (compte.nature !== 'TVA') return res.status(400).json({ error: 'Une règle TVA attend un compte de nature TVA.' });
    res.json(await prisma.regleTvaComptable.upsert({ where: { taux }, create: { taux, compteId }, update: { compteId }, include: { compte: true } }));
  } catch { res.status(500).json({ error: 'Mise à jour de la règle TVA impossible.' }); }
});

const csvComptable = (v: unknown) => {
  const texte = String(v ?? ''); const formule = /^[=+@\t\r]/.test(texte) || (texte.startsWith('-') && !Number.isFinite(Number(texte)));
  return `"${(formule ? `'${texte}` : texte).replace(/"/g, '""')}"`;
};
app.get('/api/factures/export-comptable.csv', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [regles, reglesTva, societe] = await Promise.all([prisma.regleComptable.findMany({ where: { cle: { in: CLES_COMPTABLES } }, include: { compte: true } }), prisma.regleTvaComptable.findMany({ include: { compte: true } }), getCompanySettings()]); const r = new Map(regles.map(x => [x.cle, x])); const tvaParTaux = new Map(reglesTva.filter(x => x.compte.actif).map(x => [Number(x.taux), x.compte]));
    const manquantes = CLES_COMPTABLES.filter(cle => cle === 'JOURNAL_VENTES' ? !r.get(cle)?.journal : !r.get(cle)?.compte?.actif);
    if (manquantes.length) return res.status(409).json({ error: 'Export bloqué : paramétrage comptable incomplet.', manquantes });
    // Une facture numérotée ne quitte jamais le journal des ventes : l'avoir la neutralise
    // par une pièce distincte, sans effacer ses écritures ni son numéro légal déjà exporté.
    // Les annulations historiques sans avoir gardent leur contre-passation legacy ci-dessous.
    const factures = await prisma.facture.findMany({ where: { statut: { in: ['EMISE', 'REGLEE', 'ANNULEE'] } }, include: { client: true, lignes: true, ventilationTva: true, avoirs: { select: { id: true } }, journal: { where: { action: 'ANNULATION' }, orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: [{ dateEmission: 'asc' }, { numero: 'asc' }] });
    const tauxManquants = [...new Set(factures.flatMap(f => f.lignes.map(l => Number(l.tauxTva))).filter(taux => taux !== 0 && !tvaParTaux.has(taux)))];
    if (tauxManquants.length) return res.status(409).json({ error: 'Export bloqué : compte TVA absent pour un taux utilisé.', tauxManquants });
    // Deux classes de dates, deux lectures — les confondre décale l'écriture d'un jour, et
    // d'un exercice au 1er janvier. La date d'émission est une DATE-SEULE déjà stockée à minuit
    // UTC : elle se lit telle quelle. La date d'annulation vient d'un INSTANT : elle se lit
    // dans le fuseau de l'entreprise, sinon une décision prise vers minuit change d'exercice.
    const fuseauHoraire = societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
    const jourDeDateSeule = (date: Date | string) => dateSeuleEnJourCivil(date).replace(/-/g, '');
    const jourDInstant = (instant: Date) => jourCivilEntreprise(instant, fuseauHoraire).replace(/-/g, '');
    const lignes = ['JournalCode;EcritureDate;PieceRef;CompteNum;CompteLib;Libelle;Debit;Credit']; for (const f of factures) { const date = jourDeDateSeule(f.dateEmission); const libelle = `Facture ${f.numero} — ${f.clientRaisonSociale}`;
      const ecrire = (dateEcriture: string, texte: string, contrepasse: boolean) => {
        const ecriture = (compte: { code: string; libelle: string }, debit: number, credit: number) => lignes.push([r.get('JOURNAL_VENTES')!.journal, dateEcriture, f.numero, compte.code, compte.libelle, texte, (contrepasse ? credit : debit).toFixed(2), (contrepasse ? debit : credit).toFixed(2)].map(csvComptable).join(';'));
        ecriture(r.get('CLIENT')!.compte!, Number(f.totalTtc), 0);
        for (const nature of ['PRESTATION', 'ARTICLE']) { const ht = f.lignes.filter(l => l.nature === nature).reduce((s, l) => s + Number(l.totalHt), 0); if (ht) ecriture(r.get(nature === 'PRESTATION' ? 'VENTE_PRESTATION' : 'VENTE_ARTICLE')!.compte!, 0, ht); }
        for (const ventilation of ventilationFacture(f)) if (ventilation.totalTva) ecriture(tvaParTaux.get(ventilation.tauxTva)!, 0, ventilation.totalTva);
      };
      ecrire(date, f.type === 'AVOIR' ? `Avoir ${f.numero} — ${f.clientRaisonSociale}` : libelle, f.type === 'AVOIR');
      if (f.statut === 'ANNULEE' && !f.avoirs.length) ecrire(f.journal[0] ? jourDInstant(f.journal[0].createdAt) : jourDeDateSeule(f.dateEmission), `Annulation facture ${f.numero} — ${f.clientRaisonSociale}`, true);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="export-ventes.csv"'); res.send(`\uFEFF${lignes.join('\n')}\n`);
  } catch { res.status(500).json({ error: 'Export comptable impossible.' }); }
});

const dateFrancaise = (date: Date) => date.toISOString().slice(0, 10).split('-').reverse().join('-');

app.post('/api/mentions-legales/:version/publier', requireAuth, requireAdmin, async (req, res) => {
  try {
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: 'Version légale invalide.' });
    const publiee = await prisma.$transaction(async (tx) => {
      const cible = await tx.mentionsLegalesVersion.findUnique({ where: { version } });
      if (!cible) return null;
      await tx.mentionsLegalesVersion.updateMany({ where: { actif: true }, data: { actif: false } });
      return tx.mentionsLegalesVersion.update({ where: { version }, data: { actif: true, publieeLe: new Date() } });
    });
    if (!publiee) return res.status(404).json({ error: 'Version légale introuvable.' });
    res.json(publiee);
  } catch { res.status(500).json({ error: 'Publication de la version légale impossible.' }); }
});

app.post('/api/mentions-legales', requireAuth, requireAdmin, async (req, res) => {
  try {
    const mentions = String(req.body?.mentions || '').trim(), cgv = String(req.body?.cgv || '').trim(), penalites = String(req.body?.penalites || '').trim();
    const escompte = String(req.body?.escompte || '').trim() || null;
    if (!mentions || !cgv || !penalites) return res.status(400).json({ error: 'Les mentions, CGV et pénalités sont obligatoires.' });
    const derniere = await prisma.mentionsLegalesVersion.aggregate({ _max: { version: true } });
    const version = await prisma.mentionsLegalesVersion.create({ data: { version: (derniere._max.version || 0) + 1, mentions, cgv, penalites, escompte } });
    res.status(201).json(version);
  } catch { res.status(500).json({ error: 'Création de la version légale impossible.' }); }
});

app.get('/api/mentions-legales', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const versions = await prisma.mentionsLegalesVersion.findMany({ orderBy: { version: 'desc' } });
    res.json(versions);
  } catch { res.status(500).json({ error: 'Lecture des mentions légales impossible.' }); }
});

app.post('/api/factures/:id/emettre', requireAuth, requireAdmin, async (req, res) => {
  try {
    const resultat = await prisma.$transaction(async (tx) => {
      const facture = await tx.facture.findUnique({ where: { id: paramId(req) } });
      if (!facture) return { erreur: 'NOT_FOUND' as const };
      if (facture.statut !== 'BROUILLON') return { erreur: 'NOT_DRAFT' as const };
      const annee = facture.dateEmission.getUTCFullYear();
      const derniereEmise = await tx.facture.findFirst({ where: { type: 'FACTURE', numero: { not: null } }, orderBy: { dateEmission: 'desc' }, select: { dateEmission: true } });
      if (derniereEmise && facture.dateEmission < derniereEmise.dateEmission) return { erreur: 'CHRONOLOGY' as const, limite: derniereEmise.dateEmission };
      const mentions = await tx.mentionsLegalesVersion.findFirst({ where: { actif: true, publieeLe: { not: null } }, select: { id: true } });
      if (!mentions) return { erreur: 'LEGAL_MENTIONS_MISSING' as const };
      const siteFacturation = await tx.clientSite.findFirst({ where: { clientId: facture.clientId }, orderBy: SITE_FACTURATION_ORDRE });
      if (!siteFacturation) return { erreur: 'CLIENT_ADRESSE_MISSING' as const };
      const sequence = await tx.sequenceFacture.upsert({ where: { annee }, create: { annee, dernierNumero: 1 }, update: { dernierNumero: { increment: 1 } } });
      const identite = await tx.companySettings.findUnique({ where: { id: 'singleton' }, select: { prefixeFacture: true } });
      const prefixe = (identite?.prefixeFacture || 'F').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'F';
      const numero = `${prefixe}${annee}-${String(sequence.dernierNumero).padStart(4, '0')}`;
      const maj = await tx.facture.update({ where: { id: facture.id }, data: { statut: 'EMISE', annee, numero, emisLe: new Date(), mentionsLegalesVersionId: mentions.id, clientAdresse: formaterAdresseFacturation(siteFacturation) }, include: factureInclude });
      await tx.journalFacture.create({ data: { factureId: facture.id, acteurId: (req as AuthRequest).user!.id, action: 'EMISSION', detail: `Numéro ${numero}, version légale ${mentions.id}` } });
      return { facture: maj };
    });
    if ('erreur' in resultat) {
      if (resultat.erreur === 'NOT_FOUND') return res.status(404).json({ error: 'Facture introuvable.' });
      if (resultat.erreur === 'CHRONOLOGY') return res.status(409).json({ error: `La numérotation est chronologique : la dernière facture émise porte la date du ${dateFrancaise(resultat.limite)}. Ce brouillon ne peut plus être numéroté.` });
      if (resultat.erreur === 'LEGAL_MENTIONS_MISSING') return res.status(409).json({ error: 'Aucune version publiée des mentions légales et CGV n’est active. Publiez-en une avant d’émettre une facture.' });
      if (resultat.erreur === 'CLIENT_ADRESSE_MISSING') return res.status(409).json({ error: 'Ce client n’a aucun site : l’adresse de facturation est une mention obligatoire. Créez-lui un site de facturation avant d’émettre.' });
      return res.status(409).json({ error: 'Seul un brouillon peut être émis.' });
    }
    res.json(decimalToNumber(resultat.facture));
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'Numérotation de facture déjà attribuée, veuillez réessayer.' });
    res.status(500).json({ error: 'Émission de facture impossible.' });
  }
});

// Ces transitions ne modifient jamais les lignes, les montants ni le document légal :
// seule la situation de la facture évolue, avec une trace d'audit dans la même transaction.
function transitionFactureEmise(statut: 'REGLEE', action: 'REGLEMENT') {
  return async (req: AuthRequest, res: express.Response) => {
    try {
      const resultat = await prisma.$transaction(async (tx) => {
        // Le prédicat d'état porte l'invariant directement dans l'écriture et ferme une
        // course entre deux actions administratives concurrentes.
        const maj = await tx.facture.updateMany({ where: { id: paramId(req), statut: 'EMISE', type: 'FACTURE' }, data: { statut } });
        if (!maj.count) {
          const facture = await tx.facture.findUnique({ where: { id: paramId(req) }, select: { id: true } });
          return facture ? { erreur: 'NOT_EMITTED' as const } : { erreur: 'NOT_FOUND' as const };
        }
        await tx.journalFacture.create({ data: { factureId: paramId(req), acteurId: req.user!.id, action, detail: `Transition EMISE → ${statut}` } });
        return { facture: await tx.facture.findUniqueOrThrow({ where: { id: paramId(req) }, include: factureInclude }) };
      });
      if ('erreur' in resultat) return res.status(resultat.erreur === 'NOT_FOUND' ? 404 : 409).json({ error: resultat.erreur === 'NOT_FOUND' ? 'Facture introuvable.' : 'Seule une facture émise peut changer de statut.' });
      return res.json(decimalToNumber(resultat.facture));
    } catch { return res.status(500).json({ error: 'Changement de statut de facture impossible.' }); }
  };
}

app.post('/api/factures/:id/regler', requireAuth, requireAdmin, transitionFactureEmise('REGLEE', 'REGLEMENT'));

// L’annulation d’une facture émise est une transition métier atomique : elle conserve la
// facture historique, crée son unique avoir total et lie les deux documents dans la même TX.
app.post('/api/factures/:id/annuler', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const resultat = await prisma.$transaction(async (tx) => {
      // Toute décision qui crée un avoir ou annule la facture source acquiert ce verrou
      // d'abord. Même ordre que POST /avoirs : facture puis séquence, afin d'éviter à la
      // fois un reliquat lu périmé et les interblocages entre annulation et avoir partiel.
      await tx.$queryRaw`SELECT 1 FROM "Facture" WHERE "id" = ${paramId(req)} FOR UPDATE`;
      const facture = await tx.facture.findUnique({ where: { id: paramId(req) }, include: { lignes: { orderBy: { ordre: 'asc' } }, avoirs: { select: { id: true } } } });
      if (!facture) return { erreur: 'NOT_FOUND' as const };
      if (facture.statut !== 'EMISE' || facture.type !== 'FACTURE') return { erreur: 'NOT_EMITTED' as const };
      if (facture.avoirs.length) return { erreur: 'PARTIAL_CREDITS_EXIST' as const };
      const now = new Date();
      const societe = await tx.companySettings.findUnique({ where: { id: 'singleton' }, select: { prefixeAvoir: true, fuseauHoraire: true } });
      const jour = jourCivilEntreprise(now, societe?.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
      const dateAvoir = new Date(`${jour}T00:00:00.000Z`);
      const annee = dateAvoir.getUTCFullYear();
      const sequence = await tx.sequenceAvoir.upsert({ where: { annee }, create: { annee, dernierNumero: 1 }, update: { dernierNumero: { increment: 1 } } });
      const prefixe = (societe?.prefixeAvoir || 'A').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'A';
      const numero = `${prefixe}${annee}-${String(sequence.dernierNumero).padStart(4, '0')}`;
      const maj = await tx.facture.updateMany({ where: { id: facture.id, statut: 'EMISE', type: 'FACTURE' }, data: { statut: 'ANNULEE' } });
      if (!maj.count) return { erreur: 'NOT_EMITTED' as const };
      const avoir = await tx.facture.create({ data: {
        type: 'AVOIR', estAvoirAnnulation: true, factureOrigineId: facture.id, numero, annee, statut: 'EMISE', dateEmission: dateAvoir, dateEcheance: dateAvoir,
        clientId: facture.clientId, clientRaisonSociale: facture.clientRaisonSociale, clientAdresse: facture.clientAdresse,
        origine: facture.origine, chantierId: facture.chantierId, interventionId: facture.interventionId, contratMaintenanceId: facture.contratMaintenanceId,
        motifHorsAffaire: facture.motifHorsAffaire, mentionsLegalesVersionId: facture.mentionsLegalesVersionId,
        totalHt: facture.totalHt, totalTva: facture.totalTva, totalTtc: facture.totalTtc, createdById: req.user!.id, emisLe: now,
        lignes: { create: facture.lignes.map(({ id: _id, factureId: _factureId, ...ligne }) => ligne) },
        ventilationTva: { create: ventilationTvaDerivee(facture.lignes) },
      }, include: factureInclude });
      await tx.journalFacture.create({ data: { factureId: facture.id, acteurId: req.user!.id, action: 'ANNULATION', detail: `Transition EMISE → ANNULEE ; avoir total ${numero}` } });
      await tx.journalFacture.create({ data: { factureId: avoir.id, acteurId: req.user!.id, action: 'CREATION_AVOIR', detail: `Avoir total de la facture ${facture.numero}` } });
      return { facture: await tx.facture.findUniqueOrThrow({ where: { id: facture.id }, include: factureInclude }), avoir };
    });
    if ('erreur' in resultat) {
      if (resultat.erreur === 'NOT_FOUND') return res.status(404).json({ error: 'Facture introuvable.' });
      if (resultat.erreur === 'PARTIAL_CREDITS_EXIST') return res.status(409).json({ error: 'Cette facture porte déjà un ou plusieurs avoirs partiels : elle ne peut plus être annulée en totalité.' });
      return res.status(409).json({ error: 'Seule une facture émise peut être annulée.' });
    }
    return res.json(decimalToNumber({ ...resultat.facture, avoir: resultat.avoir }));
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'Avoir déjà créé ou numéro déjà attribué, veuillez relire la facture.' });
    return res.status(500).json({ error: 'Annulation de facture impossible.' });
  }
});

// Un avoir partiel est un document émis immédiatement : il n’annule jamais la facture
// source et reprend tous ses snapshots. Le verrou SQL de la source sérialise les créations
// concurrentes avant le contrôle cumulatif des plafonds HT, TVA et TTC.
app.post('/api/factures/:id/avoirs', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const lignes = lignesAvoirPartiel(req.body?.lignes);
    const resultat = await prisma.$transaction(async (tx) => {
      // PostgreSQL verrouille la facture source jusqu’à la fin de la transaction ; sans ce
      // verrou, deux administrateurs pourraient chacun lire le même reliquat puis le dépasser.
      await tx.$queryRaw`SELECT 1 FROM "Facture" WHERE "id" = ${paramId(req)} FOR UPDATE`;
      const facture = await tx.facture.findUnique({ where: { id: paramId(req) }, include: { lignes: true, ventilationTva: true, avoirs: { include: { lignes: true, ventilationTva: true } } } });
      if (!facture) return { erreur: 'NOT_FOUND' as const };
      if (facture.type !== 'FACTURE' || !['EMISE', 'REGLEE'].includes(facture.statut)) return { erreur: 'NOT_CREDITABLE' as const };
      const tauxSource = new Set(tauxUtilises(facture.lignes));
      for (const taux of tauxUtilises(lignes)) if (!tauxSource.has(taux)) throw new FactureInvalideError('Le taux de TVA d’une ligne d’avoir doit être présent sur la facture d’origine.');
      const avoirsPrecedents = facture.avoirs;
      // La TVA de l'avoir est la différence des arrondis des bases HT cumulées avant/après.
      const ventilationSource = new Map(ventilationFacture(facture).map(ventilation => [ventilation.tauxTva, ventilation]));
      const ventilationTva = tauxUtilises(lignes).sort((a, b) => a - b).map(tauxTva => {
        const totalHt = baseHtDuTaux(lignes, tauxTva);
        const totalHtPrecedent = centimes(avoirsPrecedents.reduce((somme, avoir) => somme + (ventilationFacture(avoir).find(ventilation => ventilation.tauxTva === tauxTva)?.totalHt || 0), 0));
        const totalTvaPrecedent = tvaDuTaux([{ tauxTva, totalHt: totalHtPrecedent }], tauxTva);
        const totalTvaApres = tvaDuTaux([{ tauxTva, totalHt: centimes(totalHtPrecedent + totalHt) }], tauxTva);
        const totalTva = centimes(totalTvaApres - totalTvaPrecedent);
        return { tauxTva, totalHt, totalTva, totalTtc: centimes(totalHt + totalTva) };
      });
      const totalHt = centimes(ventilationTva.reduce((somme, ventilation) => somme + ventilation.totalHt, 0));
      const totalTva = centimes(ventilationTva.reduce((somme, ventilation) => somme + ventilation.totalTva, 0));
      const totalTtc = centimes(totalHt + totalTva);
      if (totalTtc > PLAFOND_MONTANT) throw new FactureInvalideError('Montant d’avoir hors des limites acceptées.');
      const sommePrecedente = (champ: 'totalHt' | 'totalTva' | 'totalTtc') => centimes(avoirsPrecedents.reduce((somme, avoir) => somme + Number(avoir[champ]), 0));
      if (centimes(sommePrecedente('totalHt') + totalHt) > Number(facture.totalHt) || centimes(sommePrecedente('totalTva') + totalTva) > Number(facture.totalTva) || centimes(sommePrecedente('totalTtc') + totalTtc) > Number(facture.totalTtc)) throw new AvoirPlafondError('Cet avoir dépasse le montant total restant à créditer sur la facture d’origine.');
      for (const ventilation of ventilationTva) {
        const source = ventilationSource.get(ventilation.tauxTva)!;
        const precedent = avoirsPrecedents.reduce((somme, avoir) => somme + (ventilationFacture(avoir).find(v => v.tauxTva === ventilation.tauxTva)?.totalHt || 0), 0);
        const tvaPrecedente = avoirsPrecedents.reduce((somme, avoir) => somme + (ventilationFacture(avoir).find(v => v.tauxTva === ventilation.tauxTva)?.totalTva || 0), 0);
        if (centimes(precedent + ventilation.totalHt) > source.totalHt || centimes(tvaPrecedente + ventilation.totalTva) > source.totalTva || centimes(precedent + ventilation.totalHt + tvaPrecedente + ventilation.totalTva) > source.totalTtc) throw new AvoirPlafondError(`Cet avoir dépasse le plafond restant pour la TVA à ${ventilation.tauxTva} % de la facture d’origine.`);
      }
      const now = new Date();
      const societe = await tx.companySettings.findUnique({ where: { id: 'singleton' }, select: { prefixeAvoir: true, fuseauHoraire: true } });
      const jour = jourCivilEntreprise(now, societe?.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
      const dateAvoir = new Date(`${jour}T00:00:00.000Z`);
      const annee = dateAvoir.getUTCFullYear();
      const sequence = await tx.sequenceAvoir.upsert({ where: { annee }, create: { annee, dernierNumero: 1 }, update: { dernierNumero: { increment: 1 } } });
      const prefixe = (societe?.prefixeAvoir || 'A').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'A';
      const numero = `${prefixe}${annee}-${String(sequence.dernierNumero).padStart(4, '0')}`;
      const avoir = await tx.facture.create({ data: {
        type: 'AVOIR', estAvoirAnnulation: false, factureOrigineId: facture.id, numero, annee, statut: 'EMISE', dateEmission: dateAvoir, dateEcheance: dateAvoir,
        clientId: facture.clientId, clientRaisonSociale: facture.clientRaisonSociale, clientAdresse: facture.clientAdresse,
        origine: facture.origine, chantierId: facture.chantierId, interventionId: facture.interventionId, contratMaintenanceId: facture.contratMaintenanceId,
        motifHorsAffaire: facture.motifHorsAffaire, mentionsLegalesVersionId: facture.mentionsLegalesVersionId,
        totalHt, totalTva, totalTtc, createdById: req.user!.id, emisLe: now, lignes: { create: lignes }, ventilationTva: { create: ventilationTva },
      }, include: factureInclude });
      await tx.journalFacture.create({ data: { factureId: avoir.id, acteurId: req.user!.id, action: 'CREATION_AVOIR_PARTIEL', detail: `Avoir partiel de la facture ${facture.numero}` } });
      return { avoir };
    });
    if ('erreur' in resultat) return res.status(resultat.erreur === 'NOT_FOUND' ? 404 : 409).json({ error: resultat.erreur === 'NOT_FOUND' ? 'Facture introuvable.' : 'Seule une facture émise ou réglée peut recevoir un avoir partiel.' });
    return res.status(201).json(decimalToNumber(resultat.avoir));
  } catch (error) {
    if (error instanceof FactureInvalideError) return res.status(400).json({ error: error.message });
    if (error instanceof AvoirPlafondError) return res.status(409).json({ error: error.message });
    if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'Avoir total déjà créé ou numéro déjà attribué, veuillez relire la facture.' });
    return res.status(500).json({ error: 'Création de l’avoir partiel impossible.' });
  }
});

// Le planning est une projection ; cette route crée le dossier métier traçable qui lui est
// antérieur. Une affectation planning ou un pointage ne peut pas exister à sa place.
// Contrats de maintenance : le contrat est le document source du cycle. Le planning ne sera
// qu'une projection des interventions qu'il génère ; aucune échéance n'est inférée d'un écran.
app.get('/api/contrats-maintenance', requireAuth, requireAdmin, async (_req, res) => {
  const contrats = await prisma.contratMaintenance.findMany({
    include: { client: { select: { id: true, raisonSociale: true } }, site: { select: { id: true, nom: true, ville: true } } },
    orderBy: [{ prochaineEcheance: 'asc' }, { createdAt: 'desc' }],
  });
  res.json(decimalToNumber(contrats));
});

app.get('/api/contrats-maintenance/:id/journal-saisies', requireAuth, requireAdmin, async (req, res) => {
  try {
    const contrat = await prisma.contratMaintenance.findUnique({ where: { id: paramId(req) }, select: { id: true } });
    if (!contrat) return res.status(404).json({ error: 'Contrat de maintenance introuvable.' });
    const entrees = await prisma.journalSaisieChantier.findMany({ where: { contratMaintenanceId: contrat.id }, orderBy: { createdAt: 'desc' } });
    res.json(decimalToNumber(entrees));
  } catch (error) {
    res.status(500).json({ error: 'Lecture du journal du contrat impossible.' });
  }
});

app.post('/api/contrats-maintenance', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const titre = typeof req.body?.titre === 'string' ? req.body.titre.trim() : '';
    const periodiciteMois = Number(req.body?.periodiciteMois);
    const dureePrevisionnelleMinutes = Number(req.body?.dureePrevisionnelleMinutes);
    const dateDebut = dateIsoStricte(req.body?.dateDebut);
    if (titre.length < 3 || titre.length > 200) return res.status(400).json({ error: 'Le titre du contrat doit contenir entre 3 et 200 caractères.' });
    if (!Number.isInteger(periodiciteMois) || periodiciteMois < 1 || periodiciteMois > 60) return res.status(400).json({ error: 'La périodicité doit être comprise entre 1 et 60 mois.' });
    if (!Number.isInteger(dureePrevisionnelleMinutes) || dureePrevisionnelleMinutes < 15 || dureePrevisionnelleMinutes > 1440) return res.status(400).json({ error: 'La durée prévisionnelle doit être comprise entre 15 et 1 440 minutes.' });
    if (!dateDebut) return res.status(400).json({ error: 'La date de début doit être valide au format JJ-MM-AAAA.' });
    // Même règle que la création directe d’intervention : un client désactivé n'ouvre plus
    // de dossier par le contrat, qui ne doit jamais devenir une porte de contournement.
    const client = await prisma.client.findFirst({ where: { id: String(req.body?.clientId || ''), actif: true }, select: { id: true } });
    if (!client) return res.status(404).json({ error: 'Client introuvable.' });
    const siteId = typeof req.body?.siteId === 'string' && req.body.siteId ? req.body.siteId : null;
    if (siteId) {
      const site = await prisma.clientSite.findFirst({ where: { id: siteId, clientId: client.id }, select: { id: true } });
      if (!site) return res.status(404).json({ error: 'Site introuvable.' });
    }
    const contrat = await prisma.contratMaintenance.create({
      data: { clientId: client.id, siteId, titre, periodiciteMois, dureePrevisionnelleMinutes, dateDebut, prochaineEcheance: dateDebut, createdById: req.user!.id },
      include: { client: { select: { id: true, raisonSociale: true } }, site: { select: { id: true, nom: true, ville: true } } },
    });
    res.status(201).json(decimalToNumber(contrat));
  } catch (error) {
    res.status(500).json({ error: 'Création du contrat de maintenance impossible.' });
  }
});

app.patch('/api/contrats-maintenance/:id/statut', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const statut = String(req.body?.statut || '');
    const motif = typeof req.body?.motif === 'string' ? req.body.motif.trim() : '';
    if (!['ACTIF', 'SUSPENDU', 'TERMINE'].includes(statut)) return res.status(400).json({ error: 'Statut de contrat invalide.' });
    if (['SUSPENDU', 'TERMINE'].includes(statut) && motif.length < 3) return res.status(400).json({ error: 'Un motif d’au moins 3 caractères est obligatoire.' });
    const resultat = await prisma.$transaction(async (tx) => {
      const contrat = await tx.contratMaintenance.findUnique({ where: { id: paramId(req) } });
      if (!contrat) return { erreur: 'NOT_FOUND' as const };
      if (contrat.statut === 'TERMINE') return { erreur: 'TERMINE' as const };
      const autorise = (contrat.statut === 'ACTIF' && ['SUSPENDU', 'TERMINE'].includes(statut)) || (contrat.statut === 'SUSPENDU' && ['ACTIF', 'TERMINE'].includes(statut));
      if (!autorise) return { erreur: 'TRANSITION' as const };
      const maj = await tx.contratMaintenance.update({ where: { id: contrat.id }, data: { statut } });
      const action = statut === 'SUSPENDU' ? 'SUSPENSION' : statut === 'TERMINE' ? 'CLOTURE' : 'REACTIVATION';
      await journaliserContrat(tx, req, action, maj, contrat, motif || undefined);
      return { contrat: maj };
    });
    if ('erreur' in resultat) {
      if (resultat.erreur === 'NOT_FOUND') return res.status(404).json({ error: 'Contrat de maintenance introuvable.' });
      if (resultat.erreur === 'TERMINE') return res.status(409).json({ error: 'Un contrat clos ne se rouvre pas : signez un nouveau contrat.' });
      return res.status(409).json({ error: 'Transition de statut de contrat incohérente.' });
    }
    res.json(decimalToNumber(resultat.contrat));
  } catch (error) {
    res.status(500).json({ error: 'Mise à jour du statut du contrat impossible.' });
  }
});

app.post('/api/contrats-maintenance/:id/avancer-echeance', requireAuth, requireAdmin, async (req, res) => {
  try {
    const resultat = await prisma.$transaction(async (tx) => {
      const contrat = await tx.contratMaintenance.findFirst({ where: { id: paramId(req), statut: 'ACTIF' } });
      if (!contrat) return { erreur: 'NOT_FOUND' as const };
      const intervention = await tx.intervention.findFirst({
        where: { contratMaintenanceId: contrat.id, echeanceContrat: contrat.prochaineEcheance },
        select: { id: true, statut: true },
      });
      if (!intervention || intervention.statut !== 'TERMINEE') return { erreur: 'NOT_READY' as const };
      const prochaineEcheance = echeanceSuivante(contrat.dateDebut, contrat.prochaineEcheance, contrat.periodiciteMois);
      const maj = await tx.contratMaintenance.update({ where: { id: contrat.id }, data: { prochaineEcheance } });
      return { contrat: maj };
    });
    if ('erreur' in resultat) {
      if (resultat.erreur === 'NOT_FOUND') return res.status(404).json({ error: 'Contrat de maintenance actif introuvable.' });
      return res.status(409).json({ error: 'L’échéance ne peut avancer qu’après la fin de son intervention.' });
    }
    res.json(decimalToNumber(resultat.contrat));
  } catch (error) {
    res.status(500).json({ error: 'Mise à jour de l’échéance impossible.' });
  }
});

app.post('/api/contrats-maintenance/:id/generer-intervention', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const resultat = await prisma.$transaction(async (tx) => {
      const contrat = await tx.contratMaintenance.findFirst({
        where: { id: paramId(req), statut: 'ACTIF' },
        include: { client: { select: { id: true, raisonSociale: true } }, site: { select: { id: true, nom: true, ville: true } } },
      });
      if (!contrat) return null;
      const existante = await tx.intervention.findFirst({
        where: { contratMaintenanceId: contrat.id, echeanceContrat: contrat.prochaineEcheance },
        include: { client: { select: { id: true, raisonSociale: true } }, site: true, contact: true, chantier: true },
      });
      if (existante) return { intervention: existante, creee: false };
      const societe = await tx.companySettings.findUnique({ where: { id: 'singleton' }, select: { fuseauHoraire: true } });
      const annee = anneeEntreprise(new Date(), societe?.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
      const sequence = await tx.sequenceIntervention.upsert({
        where: { annee }, create: { annee, dernierNumero: 1 }, update: { dernierNumero: { increment: 1 } },
      });
      const reference = `I${String(annee).slice(-2)}-${String(sequence.dernierNumero).padStart(4, '0')}`;
      const intervention = await tx.intervention.create({
        data: {
          reference, clientId: contrat.clientId, siteId: contrat.siteId, contratMaintenanceId: contrat.id,
          echeanceContrat: contrat.prochaineEcheance, titre: `Maintenance préventive — ${contrat.titre}`,
          description: `Intervention prévisionnelle issue du contrat. Durée prévue : ${contrat.dureePrevisionnelleMinutes} minutes.`,
          dateSouhaitee: contrat.prochaineEcheance, createdById: req.user!.id,
        },
        include: { client: { select: { id: true, raisonSociale: true } }, site: true, contact: true, chantier: true },
      });
      await journaliserIntervention(tx, req, 'CREATION_CONTRAT', intervention);
      return { intervention, creee: true };
    });
    if (!resultat) return res.status(404).json({ error: 'Contrat de maintenance actif introuvable.' });
    res.status(resultat.creee ? 201 : 200).json(decimalToNumber(resultat.intervention));
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'Une intervention existe déjà pour cette échéance.' });
    res.status(500).json({ error: 'Génération de l’intervention prévisionnelle impossible.' });
  }
});

app.post('/api/interventions', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
  try {
    const titre = String(req.body?.titre || '').trim();
    const clientId = String(req.body?.clientId || '');
    const description = req.body?.description == null ? null : String(req.body.description).trim() || null;
    const priorite = String(req.body?.priorite || 'NORMALE');
    if (!titre) return res.status(400).json({ error: 'Le titre de l’intervention est obligatoire.' });
    if (!['BASSE', 'NORMALE', 'HAUTE', 'URGENTE'].includes(priorite)) return res.status(400).json({ error: 'Priorité d’intervention invalide.' });
    const client = await prisma.client.findFirst({ where: { id: clientId, actif: true }, select: { id: true, raisonSociale: true } });
    if (!client) return res.status(404).json({ error: 'Client introuvable.' });
    const siteId = req.body?.siteId ? String(req.body.siteId) : null;
    const contactId = req.body?.contactId ? String(req.body.contactId) : null;
    const chantierId = req.body?.chantierId ? String(req.body.chantierId) : null;
    if (siteId && !await prisma.clientSite.findFirst({ where: { id: siteId, clientId }, select: { id: true } })) {
      return res.status(404).json({ error: 'Site introuvable pour ce client.' });
    }
    if (contactId && !await prisma.clientContact.findFirst({ where: { id: contactId, clientId }, select: { id: true } })) {
      return res.status(404).json({ error: 'Contact introuvable pour ce client.' });
    }
    // Chantier.client est un champ historique libre : le rattachement SAV ne l'infère pas.
    // Il n'est autorisé que lorsque sa raison sociale correspond exactement au client natif.
    const clientNom = client.raisonSociale;
    if (chantierId && !await prisma.chantier.findFirst({ where: { id: chantierId, client: clientNom, annuleLe: null }, select: { id: true } })) {
      return res.status(404).json({ error: 'Chantier introuvable pour ce client.' });
    }
    const dateSouhaitee = req.body?.dateSouhaitee ? dateIsoStricte(req.body.dateSouhaitee) : null;
    if (req.body?.dateSouhaitee && !dateSouhaitee) return res.status(400).json({ error: 'La date souhaitée doit être valide au format JJ-MM-AAAA.' });
    const societe = await getCompanySettings();
    const annee = anneeEntreprise(new Date(), societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
    const intervention = await prisma.$transaction(async (tx) => {
      const sequence = await tx.sequenceIntervention.upsert({
        where: { annee }, create: { annee, dernierNumero: 1 }, update: { dernierNumero: { increment: 1 } },
      });
      const reference = `I${String(annee).slice(-2)}-${String(sequence.dernierNumero).padStart(4, '0')}`;
      const cree = await tx.intervention.create({
        data: { reference, clientId, siteId, contactId, chantierId, titre, description, priorite, dateSouhaitee, createdById: req.user!.id },
        include: { client: { select: { id: true, raisonSociale: true } }, site: true, contact: true, chantier: true },
      });
      await journaliserIntervention(tx, req, 'CREATION', cree);
      return cree;
    });
    res.status(201).json(decimalToNumber(intervention));
  } catch (error) {
    console.error('Erreur création intervention SAV', error);
    res.status(500).json({ error: 'Erreur lors de la création de l’intervention.' });
  }
});

// Les annulations sont historiques : elles n'encombrent pas l'exploitation courante, mais
// restent explicitement consultables avec ?inclureAnnulees=true (administration/contrôle).
app.get('/api/interventions', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
  try {
    const inclureAnnulees = req.query.inclureAnnulees === 'true';
    const filtre = getInterventionFilterForUser(req.user!);
    const interventions = await prisma.intervention.findMany({
      where: {
        AND: [
          filtre,
          inclureAnnulees ? {} : { statut: { not: 'ANNULEE' } },
        ],
      },
      include: { client: { select: { id: true, raisonSociale: true } }, site: true, contact: true, chantier: true, rapports: { select: { id: true, contenu: true, createdAt: true, auteur: { select: { name: true } }, signature: { select: { id: true, signataire: true, empreinte: true, accepteLe: true } } }, orderBy: { createdAt: 'asc' } }, affectations: { include: { intervenant: { select: { id: true, nom: true, userId: true } } } } },
      orderBy: [{ dateSouhaitee: 'asc' }, { createdAt: 'desc' }],
    });
    res.json(decimalToNumber(interventions));
  } catch (error) {
    console.error('Erreur liste interventions SAV', error);
    res.status(500).json({ error: 'Erreur lors de la lecture des interventions.' });
  }
});

// Journal append-only du dossier SAV, soumis au même filtre de non-divulgation que les
// mutations. Les traces sont ordonnées de la plus récente à la plus ancienne.
app.get('/api/interventions/:id/journal-saisies', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
  try {
    const intervention = await prisma.intervention.findFirst({ where: { id: paramId(req), ...getInterventionFilterForUser(req.user!) }, select: { id: true } });
    if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
    const entrees = await prisma.journalSaisieChantier.findMany({ where: { interventionId: intervention.id }, orderBy: { createdAt: 'desc' } });
    res.json(decimalToNumber(entrees));
  } catch (error) {
    console.error('Erreur journal intervention SAV', error);
    res.status(500).json({ error: 'Erreur lors de la lecture du journal de l’intervention.' });
  }
});

// Les comptes rendus terrain sont des écritures append-only : un technicien affecté ne peut
// les ajouter que pendant une intervention en cours, jamais les modifier ou les effacer.
app.post('/api/interventions/:id/rapports', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
  try {
    const contenu = typeof req.body?.contenu === 'string' ? req.body.contenu.trim() : '';
    if (contenu.length < 3 || contenu.length > 5000) return res.status(400).json({ error: 'Le compte rendu doit contenir entre 3 et 5 000 caractères.' });
    const intervention = await prisma.intervention.findFirst({ where: { id: paramId(req), statut: 'EN_COURS', ...getInterventionFilterForUser(req.user!) }, select: { id: true } });
    if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
    const rapport = await prisma.interventionRapport.create({
      data: { interventionId: intervention.id, auteurId: req.user!.id, contenu },
      select: { id: true, contenu: true, createdAt: true, auteur: { select: { name: true } } },
    });
    res.status(201).json(rapport);
  } catch (error) {
    console.error('Erreur compte rendu intervention SAV', error);
    res.status(500).json({ error: 'Erreur lors de l’enregistrement du compte rendu.' });
  }
});

// Attestation électronique : le signataire confirme le texte figé du rapport. L'empreinte SHA-256
// facilite l'identification du contenu signé, mais n'est pas à elle seule une preuve cryptographique
// d'intégrité ni une signature qualifiée.
app.post('/api/interventions/rapports/:rapportId/signature', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
  try {
    const signataire = typeof req.body?.signataire === 'string' ? req.body.signataire.trim() : '';
    if (signataire.length < 2 || signataire.length > 200 || req.body?.confirme !== true) return res.status(400).json({ error: 'Le signataire et sa confirmation explicite sont obligatoires.' });
    const rapport = await prisma.interventionRapport.findFirst({ where: { id: String(req.params.rapportId), intervention: getInterventionFilterForUser(req.user!) }, select: { id: true, contenu: true, intervention: { select: { statut: true } }, signature: { select: { id: true } } } });
    if (!rapport) return res.status(404).json({ error: 'Compte rendu introuvable.' });
    if (rapport.intervention.statut === 'ANNULEE') return res.status(409).json({ error: 'La signature est impossible sur une intervention annulée.' });
    if (rapport.signature) return res.status(409).json({ error: 'Ce compte rendu est déjà signé.' });
    const empreinte = crypto.createHash('sha256').update(`${rapport.id}\n${rapport.contenu}\n${signataire}`, 'utf8').digest('hex');
    const signature = await prisma.interventionSignature.create({ data: { rapportId: rapport.id, signataire, empreinte }, select: { id: true, signataire: true, empreinte: true, accepteLe: true } });
    res.status(201).json(signature);
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'Ce compte rendu est déjà signé.' });
    console.error('Erreur signature intervention SAV', error);
    res.status(500).json({ error: 'Erreur lors de la signature du compte rendu.' });
  }
});

// Cycle de vie volontairement fermé : une intervention annulée ou terminée ne peut pas
// être "réouverte" silencieusement, afin de préserver l'historique SAV. Une reprise doit
// créer un nouveau dossier relié au même client (lot dédié avec motif de reprise).
app.patch('/api/interventions/:id/statut', requireAuth, blockCommercial, async (req: AuthRequest, res) => {
  try {
    const statut = String(req.body?.statut || '');
    const transitions: Record<string, string[]> = {
      A_PLANIFIER: ['PLANIFIEE', 'ANNULEE'],
      PLANIFIEE: ['EN_COURS', 'ANNULEE'],
      EN_COURS: ['TERMINEE', 'ANNULEE'],
      TERMINEE: [],
      ANNULEE: [],
    };
    if (!Object.prototype.hasOwnProperty.call(transitions, statut)) return res.status(400).json({ error: 'Statut d’intervention invalide.' });
    // Le journal compare avant/apres : les deux instantanés doivent avoir la même forme,
    // sinon une simple transition se lit comme si le client venait d'être ajouté au dossier.
    const intervention = await prisma.intervention.findFirst({
      where: { id: paramId(req), ...getInterventionFilterForUser(req.user!) },
      include: { client: { select: { id: true, raisonSociale: true } } },
    });
    if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
    if (req.user?.role === ROLE_TECHNICIEN && !['EN_COURS', 'TERMINEE'].includes(statut)) return res.status(403).json({ error: 'Un technicien peut uniquement démarrer ou terminer son intervention.' });
    if (!transitions[intervention.statut]?.includes(statut)) {
      return res.status(409).json({ error: `Transition impossible : ${intervention.statut} vers ${statut}.` });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const modifiee = await tx.intervention.update({
        where: { id: intervention.id }, data: { statut }, include: { client: { select: { id: true, raisonSociale: true } } },
      });
      await journaliserIntervention(tx, req, 'CHANGEMENT_STATUT', modifiee, intervention);
      return modifiee;
    });
    res.json(decimalToNumber(updated));
  } catch (error) {
    console.error('Erreur transition intervention SAV', error);
    res.status(500).json({ error: 'Erreur lors de la transition de l’intervention.' });
  }
});

// Crée ou met à jour l'unique projection prévisionnelle d'un dossier SAV. La fiche
// Intervention reste la source de vérité et les mêmes techniciens sont synchronisés dans
// InterventionAffectation, afin qu'un planning ne donne jamais accès à un dossier sans affectation.
app.put('/api/interventions/:id/planning', requireAuth, blockCommercial, requirePlanningActif, async (req: AuthRequest, res) => {
  try {
    const id = paramId(req);
    const intervention = await prisma.intervention.findFirst({ where: { id, ...getInterventionFilterForUser(req.user!) }, include: { client: { select: { raisonSociale: true } } } });
    if (!intervention) return res.status(404).json({ error: 'Intervention introuvable.' });
    const { error, data, intervenantIds } = await validatePlanningEvent({ ...req.body, categorie: 'HORS_CHANTIER', titre: intervention.titre, client: intervention.client.raisonSociale });
    if (error) return res.status(400).json({ error });
    const event = await prisma.$transaction(async (tx) => {
      const planning = await tx.planningEvent.upsert({
        where: { interventionId: id },
        create: { ...data, interventionId: id, intervenants: { connect: intervenantIds!.map((intervenantId) => ({ id: intervenantId })) } } as never,
        update: { ...data, intervenants: { set: intervenantIds!.map((intervenantId) => ({ id: intervenantId })) } } as never,
        include: PLANNING_EVENT_INCLUDE,
      });
      await synchroniserAffectationsIntervention(tx, id, intervenantIds!);
      return planning;
    });
    res.json(event);
  } catch (error) {
    console.error('Erreur de planification SAV', error);
    res.status(500).json({ error: 'Erreur lors de la planification de l’intervention.' });
  }
});

// Hors administration, l'accès SAV reste ancré dans une relation persistante : affectation
// explicite pour le technicien, responsable d'affaire pour le conducteur et équipe déclarée
// pour le responsable. Un rôle seul ne donne jamais accès à un dossier sans rattachement.
function getInterventionFilterForUser(authUser: { id: string; role: string; equipeIds?: string[] }) {
  if (authUser.role === 'SUPERADMIN' || authUser.role === 'ADMIN') return {};
  const parAffectation = { affectations: { some: { intervenant: { userId: authUser.id } } } };
  if (authUser.role === 'CONDUCTEUR_TRAVAUX') {
    return { OR: [parAffectation, { chantier: { responsableId: authUser.id, annuleLe: null } }] };
  }
  if (authUser.role === ROLE_RESPONSABLE) {
    return { OR: [
      parAffectation,
      { chantier: { responsableId: { in: [authUser.id, ...(authUser.equipeIds || [])] }, annuleLe: null } },
    ] };
  }
  return parAffectation;
}

// Une affectation SAV gouverne la visibilité du dossier. Elle doit donc toujours évoluer
// atomiquement avec les intervenants de sa projection planning.
async function synchroniserAffectationsIntervention(tx: Prisma.TransactionClient, interventionId: string, intervenantIds: string[]) {
  await tx.interventionAffectation.deleteMany({ where: { interventionId } });
  if (intervenantIds.length) {
    await tx.interventionAffectation.createMany({ data: intervenantIds.map((intervenantId) => ({ interventionId, intervenantId })) });
  }
}

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

// --- Accès de secours (« break-glass ») du super administrateur ---
// Microsoft Entra ID est la porte d'entrée normale, et la seule pour les comptes de la
// société. Mais faire dépendre 100 % des accès d'un service extérieur crée une panne
// unique : tenant Microsoft indisponible, application Azure supprimée ou mal reconfigurée,
// migration de tenant, compte de direction verrouillé — et plus PERSONNE ne peut entrer,
// pas même pour réparer. Cette route est la porte de service : elle n'ouvre qu'à UN compte
// superadmin nommé, avec un secret qui ne vit que dans server/.env sur le VPS.
//
// Elle est volontairement plus stricte qu'une connexion normale :
//   - il faut connaître un secret d'au moins 32 caractères, jamais versionné ;
//   - le compte visé doit exister, être actif ET être SUPERADMIN ;
//   - la session ouverte dure 1 h, pas 7 jours (c'est un accès de dépannage) ;
//   - 5 tentatives par quart d'heure et par IP, puis blocage ;
//   - chaque tentative, réussie ou non, laisse une trace dans les journaux du conteneur.
// Sans BREAK_GLASS_EMAIL + BREAK_GLASS_TOKEN dans l'environnement, la route est inactive
// et répond 503 : une instance qui n'en veut pas n'a rien à désactiver.
const BREAK_GLASS_EMAIL = normalizeEmail(process.env.BREAK_GLASS_EMAIL || '');
const BREAK_GLASS_TOKEN = process.env.BREAK_GLASS_TOKEN || '';
const BREAK_GLASS_MIN_LONGUEUR = 32;
const BREAK_GLASS_ACTIF = !!BREAK_GLASS_EMAIL && BREAK_GLASS_TOKEN.length >= BREAK_GLASS_MIN_LONGUEUR;

if (BREAK_GLASS_TOKEN && !BREAK_GLASS_ACTIF) {
  // Un secret trop court est refusé plutôt qu'accepté en silence : le croire actif alors
  // qu'il ne l'est pas serait le pire des deux mondes le jour où on en a besoin.
  console.warn(
    `[SECOURS] Accès de secours INACTIF : BREAK_GLASS_TOKEN doit faire au moins ${BREAK_GLASS_MIN_LONGUEUR} caractères` +
      (BREAK_GLASS_EMAIL ? '.' : ' et BREAK_GLASS_EMAIL doit être renseigné.')
  );
} else if (BREAK_GLASS_ACTIF) {
  console.log(`[SECOURS] Accès de secours actif pour ${BREAK_GLASS_EMAIL} (session limitée à 1 h).`);
}

// Comparaison à temps constant. On compare les EMPREINTES et non les secrets eux-mêmes :
// timingSafeEqual exige deux tampons de même longueur, et hacher d'abord évite à la fois
// l'exception sur des longueurs différentes et la fuite de la longueur du secret attendu.
function secretIdentique(fourni: string, attendu: string): boolean {
  const a = crypto.createHash('sha256').update(fourni).digest();
  const b = crypto.createHash('sha256').update(attendu).digest();
  return crypto.timingSafeEqual(a, b);
}

// Limitation du nombre d'essais, en mémoire du processus. Suffisant ici : il n'y a qu'un
// backend, et un redémarrage qui remettrait les compteurs à zéro n'aide pas un attaquant
// à deviner 256 bits d'entropie. (Un rate limiting partagé deviendra nécessaire le jour où
// l'API tournera en plusieurs instances.)
const BREAK_GLASS_FENETRE_MS = 15 * 60 * 1000;
const BREAK_GLASS_MAX_ESSAIS = 5;
const essaisSecours = new Map<string, { count: number; depuis: number }>();

function tropDEssaisSecours(ip: string): boolean {
  const maintenant = Date.now();
  const suivi = essaisSecours.get(ip);
  if (!suivi || maintenant - suivi.depuis > BREAK_GLASS_FENETRE_MS) {
    essaisSecours.set(ip, { count: 1, depuis: maintenant });
    return false;
  }
  suivi.count += 1;
  return suivi.count > BREAK_GLASS_MAX_ESSAIS;
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

// Chantiers — un conducteur ne voit que les chantiers dont il est responsable ;
// un admin voit tout. Un chantier sans responsable reste invisible aux conducteurs
// jusqu'à ce qu'un admin lui en affecte un.
// Le périmètre et le masquage financier viennent des deux mêmes fonctions que les
// journaux d'achats et d'heures : un conducteur voit ses chantiers, un commercial ceux
// qu'il a vendus, une clé d'intégration ce que ses scopes autorisent.
const listerChantiers: express.RequestHandler = async (req, res) => {
  try {
    const params = await getParametres();
    const chantiers = await prisma.chantier.findMany({
      where: perimetreChantiers(req),
      include: {
        responsable: RESPONSABLE_SELECT,
        commercial: RESPONSABLE_SELECT,
        achats: { where: { archivedAt: null } },
        pointages: { where: { archivedAt: null } },
      }
    });
    const voitMontants = peutVoirMontantsVendus(req);
    res.json(chantiers.map((c: any) => serializeChantier(c, params, voitMontants)));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching chantiers' });
  }
};

// Ouverte à tous les rôles, comme les journaux : le périmètre fait le tri.
routeMixte('get', '/chantiers', 'chantiers:read', listerChantiers, []);

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
        achats: { where: { archivedAt: null }, include: { categorie: true, fournisseur: true }, orderBy: { date: 'desc' } },
        pointages: { where: { archivedAt: null }, include: { intervenant: true }, orderBy: { date: 'desc' } },
        // Toute facture numérotée reste rattachée à son affaire ; son statut décrit sa
        // situation, sans rompre la traçabilité du cycle commercial.
        factures: { where: { statut: { in: ['EMISE', 'REGLEE', 'ANNULEE'] } }, select: { id: true, numero: true, statut: true, type: true, factureOrigineId: true, avoirs: { select: { id: true } }, dateEmission: true, totalHt: true, totalTtc: true, origine: true } },
      }
    });
    // 404 (et non 403) pour un chantier auquel on n'est pas rattaché : on ne révèle pas son existence.
    const isOwner = !!chantier && (
      chantier.commercialId === authUser.id ||
      chantier.responsableId === authUser.id ||
      (authUser.role === ROLE_RESPONSABLE && !!chantier.responsableId && authUser.equipeIds.includes(chantier.responsableId))
    );
    if (!chantier || (!isAdmin && !isOwner)) {
      return res.status(404).json({ error: 'Chantier introuvable' });
    }
    // Sur SA fiche chantier (pas sur la liste ni le tableau de bord), le conducteur
    // responsable voit désormais la marge commerciale et le budget vendu comme un admin —
    // pas le commercial, qui a sa propre vue "Résultat commercial" à l'échelle du mois.
    const canSeeMarge = isAdmin || (authUser.role === 'CONDUCTEUR_TRAVAUX' && chantier.responsableId === authUser.id);
    // `serializeChantier` étale son entrée : sortir les factures avant sérialisation
    // évite toute fuite de montants vers les rôles qui ne voient pas la marge.
    const { factures, ...chantierSansFactures } = chantier;
    const detail = serializeChantier(chantierSansFactures, params, canSeeMarge) as Record<string, unknown>;
    if (canSeeMarge) {
      // Les montants sont positifs en base : seul le type AVOIR en inverse le sens. Une
      // facture annulée est visible mais ne contribue plus, son avoir la neutralise.
      const totalFactureHt = factures.reduce((somme, facture) => {
        if (facture.type === 'AVOIR') return somme - Number(facture.totalHt);
        if (facture.statut === 'ANNULEE' && !facture.avoirs.length) return somme;
        return somme + Number(facture.totalHt);
      }, 0);
      detail.facturation = decimalToNumber({ factures, totalFactureHt, resteAFacturerHt: Number(chantier.budgetGlobalVendu) - totalFactureHt });
    }
    res.json(detail);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching chantier' });
  }
});

// Journal append-only des saisies Travaux. Il est lisible uniquement dans le même périmètre
// que la fiche chantier : une trace ne doit jamais devenir une porte latérale vers une affaire.
app.get('/api/chantiers/:id/journal-saisies', requireAuth, async (req, res) => {
  try {
    const chantierId = paramId(req);
    const chantier = await prisma.chantier.findFirst({
      where: { id: chantierId, ...perimetreChantiers(req) },
      select: { id: true },
    });
    if (!chantier) return res.status(404).json({ error: 'Chantier introuvable' });
    const entrees = await prisma.journalSaisieChantier.findMany({
      where: { chantierId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(decimalToNumber(entrees));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching journal des saisies' });
  }
});

// L'ouverture d'une affaire est contractualisée par un devis accepté : la conversion en
// est la seule porte (cf. POST /api/devis/:id/convertir). Cette route historique ne créait
// déjà plus rien, sauf si la variable d'environnement ALLOW_LEGACY_DIRECT_CHANTIER était
// posée — une échappatoire qui permettait de fabriquer une affaire sans devis, donc sans
// numéro d'affaire, sans montant vendu contrôlé et sans rien à annuler en cas d'erreur.
// Elle est retirée : il ne reste que le message.
app.post('/api/chantiers', requireAuth, blockCommercial, (_req, res) => {
  res.status(410).json({ error: 'Un chantier est créé uniquement par conversion d’un devis accepté.' });
});

// Update Chantier (pour le statut, le budget, etc.) — champs en liste blanche (anti mass-assignment).
// Ouvert aux conducteurs de travaux sur LEURS chantiers : ils corrigent eux-mêmes un nom, une
// date, un budget ou un devis mal saisi, comme le ferait un administrateur, sans avoir à en
// solliciter un. Sur un chantier dont il n'est pas responsable, un conducteur reçoit 404 (et
// non 403) : même règle qu'à la lecture, on ne révèle pas l'existence du chantier.
app.patch('/api/chantiers/:id', requireAuth, blockCommercial, async (req, res) => {
  try {
    const authUser = (req as AuthRequest).user!;
    const existant = await prisma.chantier.findUnique({
      where: { id: paramId(req) },
      select: { id: true, clientId: true, numeroDevis: true, responsableId: true, statut: true },
    });
    if (!existant || (!isAdminRole(authUser.role) && existant.responsableId !== authUser.id)) {
      return res.status(404).json({ error: 'Chantier introuvable' });
    }
    // Une affaire annulée est close : la corriger reviendrait à la faire revivre sans que
    // le devis annulé, lui, ait bougé.
    if (existant.statut === 'ANNULE') {
      return res.status(409).json({ error: 'Cette affaire est annulée : elle n’est plus modifiable.' });
    }

    // 'statut' n'est modifiable ici que par un admin : la clôture et surtout la RÉOUVERTURE
    // d'un chantier obéissent à des règles propres (cf. PATCH /api/chantiers/:id/statut, où
    // un conducteur peut clôturer mais jamais rouvrir). L'ouvrir ici les contournerait.
    // Les affaires historiques non appariées par la migration doivent pouvoir être réparées
    // sans modifier leur libellé client historique. Après la première facture, ce lien est figé.
    const allowed = isAdminRole(authUser.role)
      ? ['nom', 'numeroDevis', 'statut', 'responsableId', 'clientId']
      : ['nom', 'numeroDevis', 'responsableId'];
    const numericFields = ['budgetGlobalVendu', 'budgetMaterielVendu', 'budgetMainOeuvreVendu', 'heuresVendues'];
    const dateFields = ['dateDebut', 'dateFin'];

    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key !== 'responsableId' && key !== 'numeroDevis' && key !== 'clientId' && key in req.body) data[key] = req.body[key];
    }
    if (isAdminRole(authUser.role) && 'clientId' in req.body) {
      const cibleId = String(req.body.clientId || '');
      const cible = await prisma.client.findFirst({ where: { id: cibleId, actif: true }, select: { id: true } });
      if (!cible) return res.status(404).json({ error: 'Client introuvable.' });
      if (existant.clientId !== cibleId && await prisma.facture.count({ where: { chantierId: existant.id } })) {
        return res.status(409).json({ error: 'Une affaire déjà facturée ne change pas de client.' });
      }
      data.clientId = cibleId;
    }
    // Format et unicité du numéro de devis : mêmes règles qu'à la création, mais appliquées
    // SEULEMENT si le numéro change réellement. Des chantiers antérieurs portent une valeur
    // hors format (deux numéros dans le même champ, pour deux devis d'un même client) : les
    // contrôler à chaque enregistrement interdirait toute autre correction sur ces fiches.
    if ('numeroDevis' in req.body) {
      const numeroDevis = normaliserNumeroDevis(req.body.numeroDevis);
      if (numeroDevis !== normaliserNumeroDevis(existant.numeroDevis)) {
        const erreurDevis = erreurNumeroDevis(numeroDevis);
        if (erreurDevis) {
          return res.status(400).json({ error: erreurDevis });
        }
        if (await numeroDevisDejaPris(numeroDevis, existant.id)) {
          return res.status(409).json({ error: `Le devis ${numeroDevis} est déjà rattaché à un autre chantier.` });
        }
        data.numeroDevis = numeroDevis;
      }
    }
    // Un chantier doit toujours avoir un responsable (les conducteurs ne voient que
    // leurs chantiers) : on interdit de le vider, et on vérifie qu'il existe.
    if ('responsableId' in req.body) {
      const responsableId = String(req.body.responsableId || '');
      if (!responsableId) {
        return res.status(400).json({ error: 'Un chantier doit toujours avoir un conducteur responsable.' });
      }
      const responsable = await prisma.user.findUnique({ where: { id: responsableId }, select: { id: true, actif: true } });
      // Un compte désactivé (départ de l'entreprise) reste responsable des chantiers qu'il a
      // suivis — son historique est conservé — mais ne peut plus recevoir de nouvelle affectation.
      if (!responsable || (!responsable.actif && responsableId !== existant.responsableId)) {
        return res.status(400).json({ error: 'Conducteur responsable introuvable.' });
      }
      data.responsableId = responsableId;
    }
    for (const key of numericFields) {
      if (key in req.body) data[key] = parseFloat(req.body[key]) || 0;
    }
    for (const key of dateFields) {
      if (key in req.body) {
        if (!req.body[key]) {
          // dateFin est facultative ; la vider explicitement conserve ce comportement.
          if (key === 'dateFin') data[key] = null;
          continue;
        }
        const date = dateIsoStricte(req.body[key]);
        if (!date) return res.status(400).json({ error: `La ${key === 'dateDebut' ? 'date de début' : 'date de fin'} doit être valide au format JJ-MM-AAAA.` });
        data[key] = date;
      }
    }
    // Facultative (contrairement au numéro de devis) : peut être vidée.
    if ('adresse' in req.body) data.adresse = String(req.body.adresse || '').trim() || null;
    if ('types' in req.body) data.types = sanitizeTypes(req.body.types);
    if ('baremeReduit' in req.body) data.baremeReduit = !!req.body.baremeReduit;

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
// Un chantier ne se supprime plus, et ne s'archive pas non plus par lui-même.
//
// Il n'existe que par la conversion d'un devis accepté : c'est cette conversion qui vaut
// validation définitive du devis. Revenir dessus n'est donc pas une opération de chantier
// mais une opération de devis — l'annulation (cf. POST /api/devis/:id/annulation), qui
// exige un motif, archive le chantier lié et se refuse dès qu'une heure ou un achat a été
// saisi. Supprimer le chantier ici court-circuiterait ce contrôle et laisserait le devis
// converti pointer vers une affaire disparue.
//
// La route est conservée pour renvoyer cette explication aux clients existants plutôt
// qu'un 404 muet.
app.delete('/api/chantiers/:id', requireAuth, requireAdmin, (_req, res) => {
  res.status(410).json({ error: 'Un chantier ne se supprime pas : annulez le devis dont il est issu (une note explicative est exigée).' });
});

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
    // On ne rouvre pas, ni ne clôture, une affaire annulée : sa fin est déjà écrite, avec
    // son motif. La sortir de cet état supposerait d'annuler l'annulation, ce qui n'existe pas.
    if (chantier.statut === 'ANNULE') {
      return res.status(409).json({ error: 'Cette affaire est annulée : son statut ne change plus.' });
    }

    if (!isAdmin && (nextStatut !== 'TERMINE' || chantier.statut !== 'EN_COURS')) {
      return res.status(403).json({ error: 'Seul un administrateur peut réouvrir un chantier clôturé.' });
    }

    // La date de clôture sert de mois de rattachement à la rémunération commerciale
    // (barème progressif + primes d'objectifs, cf. /api/stats/commerciaux) : on la
    // renseigne automatiquement à la clôture si elle n'a pas déjà été saisie à la main.
    const data: Record<string, unknown> = { statut: nextStatut };
    if (nextStatut === 'TERMINE' && !chantier.dateFin) {
      // `dateFin` est une date-seule : elle doit retenir le jour civil de l'entreprise
      // et rester à minuit UTC, comme toute date métier stockée en base.
      const societe = await getCompanySettings();
      data.dateFin = new Date(`${aujourdHuiEntreprise(societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT)}T00:00:00.000Z`);
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
      // Un commercial désactivé reste rattaché aux chantiers qu'il a vendus (historique
      // conservé), mais ne peut plus être choisi pour une nouvelle affectation.
      const inchange = commercial?.id === chantier.commercialId;
      if (!commercial || !isCommercialLike(commercial) || (!commercial.actif && !inchange)) {
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
// La liste des comptes EST la liste blanche d'autorisation Microsoft Entra ID : seuls les
// emails présents ici peuvent se connecter. L'authentification locale est interdite.
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Le rôle SUPERADMIN n'existe pas du point de vue d'un ADMIN : les comptes qui le
    // portent sont retirés de la liste qui lui est renvoyée. Il ne peut donc ni les voir,
    // ni découvrir l'existence de ce niveau de droits, ni tenter de se l'attribuer (les
    // routes d'écriture le refusent déjà, cf. refuseSuperAdminTarget).
    const isSuper = isSuperAdminRole((req as AuthRequest).user?.role);
    const users = await prisma.user.findMany({
      where: isSuper ? {} : { role: { not: ROLE_SUPERADMIN } },
      select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users.map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, estCommercial: u.estCommercial,
      accesFinance: u.accesFinance, actif: u.actif,
      permissions: permissionsEffectives(u),
      permissionsIndividuelles: u.permissions,
    })));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching users' });
  }
});

// Autorise un nouveau compte à se connecter (liste blanche SSO / création de compte).
// Aucun mot de passe n'est défini : le compte se connecte exclusivement via Microsoft Entra ID.
const ALLOWED_ROLES = [ROLE_SUPERADMIN, 'ADMIN', 'CONDUCTEUR_TRAVAUX', 'COMMERCIAL', ROLE_ASSISTANTE_COMMERCIALE, ROLE_TECHNICIEN, ROLE_COMPTABLE, ROLE_DIRECTEUR_COMMERCIAL, ROLE_RESPONSABLE];

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
    // L'accès au Suivi financier ne s'accorde que par un superadmin (cf. peutVoirFinance) :
    // un administrateur qui pourrait cocher la case se l'attribuerait à lui-même.
    const accesFinance = isSuperAdminRole((req as AuthRequest).user?.role) && !!req.body.accesFinance;

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
      data: { email, name, role, estCommercial, accesFinance }, // pas de mot de passe : accès via SSO Microsoft
      select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true },
    });
    res.status(201).json({ ...user, hasPassword: false });
  } catch (error) {
    res.status(500).json({ error: 'Error creating user' });
  }
});

// Révoque un compte (retire l'autorisation d'accès). Les références nullables
// (chantiers dont il est responsable) sont détachées d'abord.
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
    // La clé étrangère RESTRICT reste le verrou contre une course ; ce contrôle rend le refus
    // lisible à l’administrateur lorsqu’un compte porte déjà une preuve d’archivage.
    const [achatsArchives, pointagesArchives] = await Promise.all([
      prisma.achatReel.count({ where: { archivedById: id } }),
      prisma.pointageHeure.count({ where: { archivedById: id } }),
    ]);
    if (achatsArchives + pointagesArchives > 0) {
      return res.status(409).json({ error: 'Ce compte a archivé des écritures Travaux : le supprimer effacerait la preuve de ces archivages.' });
    }
    await prisma.$transaction([
      prisma.chantier.updateMany({ where: { responsableId: id }, data: { responsableId: null } }),
      prisma.chantier.updateMany({ where: { commercialId: id }, data: { commercialId: null } }),
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
      // accesFinance n'est PAS touché : il ne dépend pas du rôle, un conducteur comme un
      // commercial peut le conserver en changeant de fonction.
      data: isAdminRole(role) ? { role } : { role, estCommercial: false },
      select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true }
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
      select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true },
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Error updating estCommercial' });
  }
});

// Permissions individuelles : complètent le type de compte sans retirer ses droits par
// défaut. Seul un superadministrateur peut les accorder ou les retirer.
app.put('/api/users/:id/permissions', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: paramId(req) } });
    if (!target) return void res.status(404).json({ error: 'Utilisateur introuvable.' });
    const rawPermissions: unknown[] | null = Array.isArray(req.body?.permissions) ? req.body.permissions : null;
    const permissions: string[] | null = rawPermissions ? [...new Set(rawPermissions.map((permission) => String(permission)))] : null;
    if (!permissions || permissions.some((permission) => !(API_SCOPES as readonly string[]).includes(permission))) {
      return void res.status(400).json({ error: 'Liste de permissions invalide.' });
    }
    const user = await prisma.user.update({ where: { id: target.id }, data: { permissions }, select: { id: true, name: true, email: true, role: true, permissions: true } });
    res.json(user);
  } catch { res.status(500).json({ error: 'Impossible de modifier les permissions individuelles.' }); }
});

// Bascule l'accès au Suivi financier d'un compte, quel que soit son rôle. RÉSERVÉ AU
// SUPERADMIN : ces données (encaissements, impayés, montants clients) relèvent de la
// direction, et un administrateur qui pourrait cocher la case se l'attribuerait à
// lui-même. Un superadmin y accède de toute façon sans cette autorisation.
app.patch('/api/users/:id/acces-finance', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: paramId(req) } });
    if (!target) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }
    const user = await prisma.user.update({
      where: { id: target.id },
      data: { accesFinance: !!req.body.accesFinance },
      select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true },
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: "Impossible de modifier l'accès au suivi financier." });
  }
});

// Active ou désactive un compte. Une désactivation vaut départ de l'entreprise : la
// connexion est refusée (locale comme SSO), les jetons en cours cessent d'être acceptés et
// le compte disparaît des listes d'attribution (conducteur responsable, commercial
// rattaché). Elle NE DÉTACHE RIEN : les chantiers qu'il a suivis ou vendus lui restent
// rattachés et son historique d'heures est intact — c'est toute la différence avec la
// suppression du compte. L'opération est réversible d'un clic.
app.patch('/api/users/:id/actif', requireAuth, requireAdmin, async (req, res) => {
  try {
    const authUser = (req as AuthRequest).user!;
    const target = await prisma.user.findUnique({ where: { id: paramId(req) } });
    if (!target) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }
    const refus = refuseSuperAdminTarget(req, target.role);
    if (refus) {
      return res.status(403).json({ error: refus });
    }
    const actif = !!req.body.actif;
    // On ne se désactive pas soi-même (on se verrouillerait dehors), et on ne désactive pas
    // le dernier superadmin : plus personne ne piloterait les modules ni les comptes.
    if (!actif && target.id === authUser.id) {
      return res.status(400).json({ error: 'Vous ne pouvez pas désactiver votre propre compte.' });
    }
    if (!actif && (await isLastSuperAdmin(target.id))) {
      return res.status(400).json({ error: "Ce compte est le dernier super administrateur : il ne peut pas être désactivé." });
    }
    const user = await prisma.user.update({
      where: { id: target.id },
      data: { actif },
      select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true },
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: "Impossible de modifier l'activation du compte." });
  }
});


// Liste minimale des commerciaux (id + nom), pour peupler les sélecteurs d'affectation
// (création de chantier, réattribution). Contrairement à /api/users, accessible à tout
// utilisateur authentifié (pas seulement les admins) : un conducteur doit pouvoir choisir
// le commercial rattaché à un chantier qu'il crée ou dont il est responsable. Inclut les
// admins marqués "estCommercial" (cf. isCommercialLike). Les comptes désactivés en sont
// exclus : ils ne doivent plus recevoir d'affectation, même si leurs chantiers passés leur
// restent rattachés.
app.get('/api/commerciaux', requireAuth, async (req, res) => {
  try {
    const commerciaux = await prisma.user.findMany({
      where: { actif: true, OR: COMMERCIAL_OR_FILTER },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json(commerciaux);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching commerciaux' });
  }
});

// Liste minimale des conducteurs de travaux (id + nom), pendant de /api/commerciaux : elle
// peuple le sélecteur « Conducteur responsable » sans exiger /api/users, réservé aux admins.
// Un conducteur peut désormais modifier ses chantiers : il lui faut cette liste. Comme pour
// les commerciaux, les comptes désactivés n'y figurent plus.
app.get('/api/conducteurs', requireAuth, async (req, res) => {
  try {
    const conducteurs = await prisma.user.findMany({
      where: { actif: true, role: 'CONDUCTEUR_TRAVAUX' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json(conducteurs);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching conducteurs' });
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

// Supprimer un intervenant. Bloqué s'il possède des pointages (historique préservé) ou
// des affectations SAV (elles gouvernent l'accès aux dossiers, ce n'est pas du prévisionnel).
// Ses affectations de planning restent, elles, purement prévisionnelles : il en est simplement
// retiré, et celles dont il était le seul technicien sont supprimées.
app.delete('/api/intervenants/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = paramId(req);
    const used = await prisma.pointageHeure.count({ where: { intervenantId: id } });
    if (used > 0) {
      return res.status(409).json({ error: `Suppression impossible : cet intervenant a ${used} pointage(s) d'heures dans l'historique.` });
    }
    const affecte = await prisma.interventionAffectation.count({ where: { intervenantId: id } });
    if (affecte > 0) {
      return res.status(409).json({ error: `Suppression impossible : cet intervenant est affecté à ${affecte} intervention(s) SAV.` });
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
// une intervention non suivi (ex: SAV — nom et client saisis librement), ou sur
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
    // Adresse du site (facultative), saisie librement : contrairement à categorie
    // CHANTIER, il n'existe pas de fiche chantier à côté de laquelle la stocker — elle
    // vit uniquement sur cette affectation.
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
    const event = await prisma.$transaction(async (tx) => {
      const updated = await tx.planningEvent.update({
        where: { id: existing.id },
        data: { ...data, intervenants: { set: intervenantIds!.map((id) => ({ id })) } } as never,
        include: PLANNING_EVENT_INCLUDE,
      });
      if (existing.interventionId) await synchroniserAffectationsIntervention(tx, existing.interventionId, intervenantIds!);
      return updated;
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
    if (existing.interventionId) {
      return res.status(409).json({ error: 'Suppression impossible : cette projection est liée à une intervention SAV. Modifiez ou annulez le dossier SAV.' });
    }
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
// Sans hiérarchie d'équipe modélisée, le seul périmètre explicite disponible est
// `responsableId`. Un responsable hiérarchique sera autorisé lorsque son rattachement
// persistant existera ; son seul intitulé de rôle ne suffit jamais à élargir l'accès.
async function assertChantierWritable(req: express.Request, res: express.Response, chantierId: string) {
  const user = (req as AuthRequest).user;
  const isAdmin = isAdminRole(user?.role);
  const chantier = await prisma.chantier.findUnique({ where: { id: chantierId } });
  if (!chantier) {
    res.status(404).json({ error: 'Chantier introuvable' });
    return null;
  }
  const estConducteurDeLAffaire = user?.role === 'CONDUCTEUR_TRAVAUX' && chantier.responsableId === user.id;
  const estResponsableDeLEquipe = user?.role === ROLE_RESPONSABLE
    && !!chantier.responsableId
    && (chantier.responsableId === user.id || user.equipeIds.includes(chantier.responsableId));
  if (!isAdmin && !estConducteurDeLAffaire && !estResponsableDeLEquipe) {
    // Même réponse qu'un chantier absent afin de ne pas révéler une affaire hors périmètre.
    res.status(404).json({ error: 'Chantier introuvable' });
    return null;
  }
  // Une affaire annulée n'accepte plus rien de personne : le verrou d'annulation garantit
  // qu'elle était vierge, une écriture postérieure la ferait ressusciter en silence.
  if (chantier.statut === 'ANNULE') {
    res.status(409).json({ error: 'Cette affaire est annulée : plus aucune saisie n’y est possible.' });
    return null;
  }
  if (!isAdmin && chantier.statut !== 'EN_COURS') {
    res.status(403).json({ error: 'Ce chantier est clôturé : impossible d\'y ajouter une dépense ou des heures.' });
    return null;
  }
  return chantier;
}

function dateIsoStricte(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Le format métier français est JJ-MM-AAAA. YYYY-MM-DD reste accepté pour les champs
  // HTML natifs. Une date-heure ISO est également acceptée car l'API la renvoie elle-même.
  const isoComplet = /^(\d{4})-(\d{2})-(\d{2})T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (isoComplet) return dateIsoStricte(`${isoComplet[1]}-${isoComplet[2]}-${isoComplet[3]}`);
  const match = /^(?:(\d{2})-(\d{2})-(\d{4})|(\d{4})-(\d{2})-(\d{2}))$/.exec(value);
  if (!match) return null;
  const [, jourFr, moisFr, anneeFr, anneeIso, moisIso, jourIso] = match;
  const annee = Number(anneeFr || anneeIso);
  const mois = Number(moisFr || moisIso);
  const jour = Number(jourFr || jourIso);
  const date = new Date(Date.UTC(annee, mois - 1, jour));
  if (date.getUTCFullYear() !== annee || date.getUTCMonth() !== mois - 1 || date.getUTCDate() !== jour) return null;
  return date.toISOString();
}

function ajouterMoisUTC(date: Date, nombreDeMois: number): Date {
  // On conserve le jour d'échéance autant que le mois cible le permet (31 janvier → 28 février).
  const jour = date.getUTCDate();
  const cible = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + nombreDeMois, 1));
  const dernierJour = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0)).getUTCDate();
  cible.setUTCDate(Math.min(jour, dernierJour));
  return cible;
}

function echeanceSuivante(dateDebut: Date, echeanceCourante: Date, periodiciteMois: number): Date {
  // Le jour de la visite est contractuel : repartir de l'origine restaure le 31 (ou le 29 février)
  // dès que le mois cible le permet, au lieu de le raboter définitivement après un mois court.
  const moisEcoules = (echeanceCourante.getUTCFullYear() - dateDebut.getUTCFullYear()) * 12
    + (echeanceCourante.getUTCMonth() - dateDebut.getUTCMonth());
  const periodesEcoulees = Math.max(0, Math.round(moisEcoules / periodiciteMois));
  return ajouterMoisUTC(dateDebut, (periodesEcoulees + 1) * periodiciteMois);
}

function valeurJournal(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(decimalToNumber(value))) as Record<string, unknown>;
}

async function journaliserSaisieTravaux(
  tx: any,
  req: AuthRequest,
  cible: 'ACHAT' | 'HEURE',
  action: 'CREATION' | 'CORRECTION' | 'ARCHIVAGE',
  cibleId: string,
  chantierId: string,
  avant: unknown,
  apres: unknown,
  motif?: string,
) {
  const user = req.user!;
  await tx.journalSaisieChantier.create({ data: {
    chantierId, cible, cibleId, action, auteurId: user.id, auteurNom: user.name,
    avant: avant ? valeurJournal(avant) : undefined,
    apres: apres ? valeurJournal(apres) : undefined,
    motif: motif || null,
  } });
}

function nombreDecimalNonNegatif(value: unknown, maxIntegerDigits: number, zeroAutorise = false, maxDecimales = 2): number | null {
  // Ne jamais laisser PostgreSQL arrondir silencieusement une valeur métier ; notation scientifique refusée.
  const texte = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const expression = new RegExp(`^\\d{1,${maxIntegerDigits}}(?:[,.]\\d{1,${maxDecimales}})?$`);
  if (!expression.test(texte)) return null;
  const nombre = Number(texte.replace(',', '.'));
  return Number.isFinite(nombre) && (nombre > 0 || (zeroAutorise && nombre === 0)) ? nombre : null;
}

// Achats
// Journal des achats, restreint au périmètre du demandeur (cf. perimetreChantiers) et
// dépouillé des montants du chantier (cf. CHANTIER_LITE_SELECT).
//
// Cette route renvoyait auparavant TOUS les achats de TOUS les chantiers, chacun avec son
// chantier complet : un conducteur ou un commercial y lisait les budgets vendus d'affaires
// qui ne le concernaient pas, alors que serializeChantier les lui masque partout ailleurs.
// Le contrôle d'accès n'a de valeur que s'il tient sur toutes les portes à la fois.
const listerAchats: express.RequestHandler = async (req, res) => {
  try {
    res.json(decimalToNumber(await prisma.achatReel.findMany({
      where: { archivedAt: null, chantier: perimetreChantiers(req) },
      include: {
        chantier: { select: CHANTIER_LITE_SELECT },
        categorie: true,
        fournisseur: true,
      },
      orderBy: { date: 'desc' },
    })));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching achats' });
  }
};

app.post('/api/achats', requireAuth, requireTravauxWrite, async (req, res) => {
  try {
    const date = dateIsoStricte(req.body.date);
    if (!date) return res.status(400).json({ error: 'La date doit être valide au format JJ-MM-AAAA.' });
    const montantHT = nombreDecimalNonNegatif(req.body.montantHT, 10, true);
    if (montantHT === null) return res.status(400).json({ error: 'Le montant HT doit être un nombre positif ou nul.' });
    if (!(await assertChantierWritable(req, res, req.body.chantierId))) return;
    const cree = await prisma.$transaction(async (tx) => {
      const achat = await tx.achatReel.create({
        data: {
          date, fournisseurId: req.body.fournisseurId, numeroFacture: req.body.numeroFacture || null,
          description: req.body.description, montantHT, chantierId: req.body.chantierId,
          categorieId: req.body.categorieId, createdById: (req as AuthRequest).user!.id,
        }
      });
      await journaliserSaisieTravaux(tx, req as AuthRequest, 'ACHAT', 'CREATION', achat.id, achat.chantierId, null, achat);
      return achat;
    });
    res.json(cree);
  } catch (error) {
    res.status(500).json({ error: 'Error creating achat' });
  }
});

// Correction d'un achat déjà saisi (erreur de montant, de fournisseur, de catégorie...) —
// mêmes droits que la saisie (tout compte non-commercial, sur un chantier EN_COURS ou
// n'importe quel chantier pour un admin, cf. assertChantierWritable). Ne permet pas de
// changer le chantier de l'achat, comme pour PATCH /api/heures/:id.
app.patch('/api/achats/:id', requireAuth, requireTravauxWrite, async (req, res) => {
  try {
    const achatId = paramId(req);
    const achat = await prisma.achatReel.findUnique({ where: { id: achatId } });
    if (!achat) return res.status(404).json({ error: 'Achat introuvable.' });
    if (!(await assertChantierWritable(req, res, achat.chantierId))) return;
    if (achat.archivedAt) return res.status(409).json({ error: 'Un achat archivé ne peut plus être corrigé.' });

    const data: Record<string, unknown> = {};
    if ('date' in req.body) {
      const date = dateIsoStricte(req.body.date);
      if (!date) return res.status(400).json({ error: 'La date doit être valide au format JJ-MM-AAAA.' });
      data.date = date;
    }
    if ('numeroFacture' in req.body) data.numeroFacture = req.body.numeroFacture || null;
    if ('description' in req.body) data.description = req.body.description;
    if ('montantHT' in req.body) {
      const montantHT = nombreDecimalNonNegatif(req.body.montantHT, 10, true);
      if (montantHT === null) return res.status(400).json({ error: 'Le montant HT doit être un nombre positif ou nul.' });
      data.montantHT = montantHT;
    }
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

    data.updatedById = (req as AuthRequest).user!.id;
    const resultat = await prisma.$transaction(async (tx) => {
      // Ce filtre n’est pas redondant avec le garde ci-dessus : un archivage concurrent peut
      // passer entre le findUnique et cet UPDATE. Sans lui, une correction toucherait un archivé.
      const { count } = await tx.achatReel.updateMany({ where: { id: achatId, archivedAt: null }, data });
      if (count === 0) return null;
      const misAJour = await tx.achatReel.findUniqueOrThrow({ where: { id: achatId } });
      await journaliserSaisieTravaux(tx, req as AuthRequest, 'ACHAT', 'CORRECTION', achatId, achat.chantierId, achat, misAJour);
      return misAJour;
    });
    if (!resultat) return res.status(409).json({ error: 'Un achat archivé ne peut plus être corrigé.' });
    res.json(resultat);
  } catch (error) {
    res.status(500).json({ error: 'Error updating achat' });
  }
});

// Suppression d'un achat saisi par erreur (doublon, mauvais chantier...) — mêmes droits
// que la correction ci-dessus (PATCH), cf. assertChantierWritable.
app.delete('/api/achats/:id', requireAuth, requireTravauxWrite, async (req, res) => {
  try {
    const achatId = paramId(req);
    const achat = await prisma.achatReel.findUnique({ where: { id: achatId } });
    if (!achat) return res.status(404).json({ error: 'Achat introuvable.' });
    if (!(await assertChantierWritable(req, res, achat.chantierId))) return;
    if (achat.archivedAt) return res.status(409).json({ error: 'Cet achat est déjà archivé.' });

    const motifArchivage = typeof req.body?.motifArchivage === 'string' ? req.body.motifArchivage.trim() : '';
    // PostgreSQL char_length compte les caractères alors que .length compte les unités UTF-16.
    const longueurMotifArchivage = [...motifArchivage].length;
    if (longueurMotifArchivage < 3 || longueurMotifArchivage > 500) return res.status(400).json({ error: 'Le motif d’archivage doit contenir entre 3 et 500 caractères.' });
    const archiveCree = await prisma.$transaction(async (tx) => {
      const { count } = await tx.achatReel.updateMany({ where: { id: achatId, archivedAt: null }, data: { archivedAt: new Date(), archivedById: (req as AuthRequest).user!.id, motifArchivage } });
      if (count === 0) return false;
      const archive = await tx.achatReel.findUniqueOrThrow({ where: { id: achatId } });
      await journaliserSaisieTravaux(tx, req as AuthRequest, 'ACHAT', 'ARCHIVAGE', achatId, achat.chantierId, achat, archive, motifArchivage);
      return true;
    });
    if (!archiveCree) return res.status(409).json({ error: 'Cet achat est déjà archivé.' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting achat' });
  }
});

// Pointages (Heures)
// Journal des heures : même correction et même raison que le journal des achats.
const listerHeures: express.RequestHandler = async (req, res) => {
  try {
    res.json(decimalToNumber(await prisma.pointageHeure.findMany({
      where: { archivedAt: null, chantier: perimetreChantiers(req) },
      include: {
        chantier: { select: CHANTIER_LITE_SELECT },
        intervenant: true,
      },
      orderBy: { date: 'desc' },
    })));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching heures' });
  }
};

// Ouvertes à tous les rôles : c'est le périmètre renvoyé qui distingue un administrateur
// d'un conducteur, pas le droit d'appeler la route.
routeMixte('get', '/achats', 'chantiers:read', listerAchats, []);
routeMixte('get', '/heures', 'chantiers:read', listerHeures, []);

app.post('/api/heures', requireAuth, requireTravauxWrite, async (req, res) => {
  try {
    const date = dateIsoStricte(req.body.date);
    if (!date) return res.status(400).json({ error: 'La date doit être valide au format JJ-MM-AAAA.' });
    const nbrHeures = nombreDecimalNonNegatif(req.body.nbrHeures, 8);
    if (nbrHeures === null) return res.status(400).json({ error: 'Le nombre d’heures doit être strictement positif.' });
    const intervenant = await prisma.intervenant.findUnique({ where: { id: req.body.intervenantId } });
    if (!intervenant) return res.status(404).json({ error: 'Intervenant not found' });
    if (!(await assertChantierWritable(req, res, req.body.chantierId))) return;

    const cree = await prisma.$transaction(async (tx) => {
      const pointage = await tx.pointageHeure.create({
        data: {
          date, intervenantId: req.body.intervenantId, chantierId: req.body.chantierId,
          nbrHeures, tauxHoraireApplique: intervenant.tauxHoraireCharge,
          commentaire: req.body.commentaire || null, createdById: (req as AuthRequest).user!.id,
        }
      });
      await journaliserSaisieTravaux(tx, req as AuthRequest, 'HEURE', 'CREATION', pointage.id, pointage.chantierId, null, pointage);
      return pointage;
    });
    res.json(cree);
  } catch (error) {
    res.status(500).json({ error: 'Error creating pointage' });
  }
});

// Correction d'un pointage d'heures déjà saisi (erreur de date, d'intervenant, de nombre
// d'heures...) — mêmes droits que la saisie (tout compte non-commercial, sur un chantier
// EN_COURS ou n'importe quel chantier pour un admin, cf. assertChantierWritable). Ne
// permet pas de changer le chantier du pointage : ce n'est pas une réaffectation, juste
// une correction de saisie sur le chantier d'origine.
app.patch('/api/heures/:id', requireAuth, requireTravauxWrite, async (req, res) => {
  try {
    const pointageId = paramId(req);
    const pointage = await prisma.pointageHeure.findUnique({ where: { id: pointageId } });
    if (!pointage) return res.status(404).json({ error: 'Pointage introuvable.' });
    if (!(await assertChantierWritable(req, res, pointage.chantierId))) return;
    if (pointage.archivedAt) return res.status(409).json({ error: 'Un pointage archivé ne peut plus être corrigé.' });

    const data: Record<string, unknown> = {};
    if ('date' in req.body) {
      const date = dateIsoStricte(req.body.date);
      if (!date) return res.status(400).json({ error: 'La date doit être valide au format JJ-MM-AAAA.' });
      data.date = date;
    }
    if ('nbrHeures' in req.body) {
      const nbrHeures = nombreDecimalNonNegatif(req.body.nbrHeures, 8);
      if (nbrHeures === null) return res.status(400).json({ error: 'Le nombre d’heures doit être strictement positif.' });
      data.nbrHeures = nbrHeures;
    }
    if ('commentaire' in req.body) data.commentaire = req.body.commentaire || null;
    // Changer l'intervenant réapplique son taux horaire chargé ACTUEL (même logique qu'à
    // la création) : le taux figé de l'ancien intervenant n'a pas de sens pour le nouveau.
    if ('intervenantId' in req.body && req.body.intervenantId !== pointage.intervenantId) {
      const intervenant = await prisma.intervenant.findUnique({ where: { id: String(req.body.intervenantId) } });
      if (!intervenant) return res.status(404).json({ error: 'Intervenant introuvable.' });
      data.intervenantId = intervenant.id;
      data.tauxHoraireApplique = intervenant.tauxHoraireCharge;
    }

    data.updatedById = (req as AuthRequest).user!.id;
    const resultat = await prisma.$transaction(async (tx) => {
      // Ce filtre n’est pas redondant avec le garde ci-dessus : un archivage concurrent peut
      // passer entre le findUnique et cet UPDATE. Sans lui, une correction toucherait un archivé.
      const { count } = await tx.pointageHeure.updateMany({ where: { id: pointageId, archivedAt: null }, data });
      if (count === 0) return null;
      const misAJour = await tx.pointageHeure.findUniqueOrThrow({ where: { id: pointageId } });
      await journaliserSaisieTravaux(tx, req as AuthRequest, 'HEURE', 'CORRECTION', pointageId, pointage.chantierId, pointage, misAJour);
      return misAJour;
    });
    if (!resultat) return res.status(409).json({ error: 'Un pointage archivé ne peut plus être corrigé.' });
    res.json(resultat);
  } catch (error) {
    res.status(500).json({ error: 'Error updating pointage' });
  }
});

// Suppression d'un pointage saisi par erreur (doublon, mauvais chantier...) — mêmes
// droits que la correction ci-dessus (PATCH), cf. assertChantierWritable.
app.delete('/api/heures/:id', requireAuth, requireTravauxWrite, async (req, res) => {
  try {
    const pointageId = paramId(req);
    const pointage = await prisma.pointageHeure.findUnique({ where: { id: pointageId } });
    if (!pointage) return res.status(404).json({ error: 'Pointage introuvable.' });
    if (!(await assertChantierWritable(req, res, pointage.chantierId))) return;
    if (pointage.archivedAt) return res.status(409).json({ error: 'Ce pointage est déjà archivé.' });

    const motifArchivage = typeof req.body?.motifArchivage === 'string' ? req.body.motifArchivage.trim() : '';
    // PostgreSQL char_length compte les caractères alors que .length compte les unités UTF-16.
    const longueurMotifArchivage = [...motifArchivage].length;
    if (longueurMotifArchivage < 3 || longueurMotifArchivage > 500) return res.status(400).json({ error: 'Le motif d’archivage doit contenir entre 3 et 500 caractères.' });
    const archiveCree = await prisma.$transaction(async (tx) => {
      const { count } = await tx.pointageHeure.updateMany({ where: { id: pointageId, archivedAt: null }, data: { archivedAt: new Date(), archivedById: (req as AuthRequest).user!.id, motifArchivage } });
      if (count === 0) return false;
      const archive = await tx.pointageHeure.findUniqueOrThrow({ where: { id: pointageId } });
      await journaliserSaisieTravaux(tx, req as AuthRequest, 'HEURE', 'ARCHIVAGE', pointageId, pointage.chantierId, pointage, archive, motifArchivage);
      return true;
    });
    if (!archiveCree) return res.status(409).json({ error: 'Ce pointage est déjà archivé.' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting pointage' });
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

// --- Registre national des entreprises (lecture publique, via le backend) ---
// Utilisé pour préremplir l'identité de l'instance et, plus tard, les fiches clients.
// Aucun appel direct navigateur : limite de recherche, délai et sélection explicite restent
// sous contrôle Iris. Les résultats ne sont jamais persistés sans validation utilisateur.
app.get('/api/registry/companies', requireAuth, requireAdmin, async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 3 || q.length > 100) {
    res.status(400).json({ error: 'La recherche doit contenir entre 3 et 100 caractères.' });
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const upstream = await fetch(`https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(q)}&page=1&per_page=8`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!upstream.ok) throw new Error(`Registre entreprises HTTP ${upstream.status}`);
    const payload = await upstream.json() as { results?: Array<any> };
    const companies = (payload.results ?? []).map((company) => {
      const siege = company.siege ?? {};
      return {
        siren: company.siren ?? null,
        siret: siege.siret ?? null,
        raisonSociale: company.nom_raison_sociale || company.nom_complet || null,
        nomCommercial: siege.nom_commercial || null,
        adresse: siege.adresse || null,
        codePostal: siege.code_postal || null,
        ville: siege.libelle_commune || null,
        activitePrincipale: company.activite_principale || siege.activite_principale || null,
        etatAdministratif: siege.etat_administratif || null,
      };
    });
    res.json({ companies });
  } catch (error) {
    res.status(502).json({ error: 'Le registre des entreprises est temporairement indisponible.' });
  } finally {
    clearTimeout(timeout);
  }
});

function publicApiKey(key: { id: string; nom: string; prefixe: string; scopes: string[]; actif: boolean; expireLe: Date | null; dernierUsageLe: Date | null; creeLe: Date; revoqueLe: Date | null }) {
  return { id: key.id, nom: key.nom, prefixe: key.prefixe, scopes: key.scopes, actif: key.actif, expireLe: key.expireLe, dernierUsageLe: key.dernierUsageLe, creeLe: key.creeLe, revoqueLe: key.revoqueLe };
}

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
    const key = await prisma.apiAccessKey.create({
      data: { nom, prefixe: secret.slice(0, 14), secretHash: apiKeyHash(secret), scopes, expireLe, creeParId: (req as AuthRequest).user!.id },
    });
    console.warn(`[API] Clé d'intégration créée : « ${nom} » (${scopes.join(', ')}) par ${(req as AuthRequest).user!.id}`);
    res.status(201).json({ apiKey: secret, key: publicApiKey(key), warning: 'Copiez cette clé maintenant : elle ne sera plus jamais affichée.' });
  } catch {
    res.status(500).json({ error: 'Création de la clé impossible.' });
  }
});

app.post('/api/admin/api-keys/:id/revoke', requireAuth, requireSuperAdmin, async (req, res) => {
  const key = await prisma.apiAccessKey
    .update({ where: { id: paramId(req) }, data: { actif: false, revoqueLe: new Date() } })
    .catch(() => null);
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

// --- Référentiel Clients natif Iris ---
// Les handlers sont écrits UNE fois puis montés sur deux portes d'entrée (cf. routeMixte
// plus bas) : l'interface, pour un administrateur connecté, et /api/v1, pour une clé
// d'intégration porteuse du bon scope. Un agent et un humain appliquent ainsi exactement
// les mêmes règles de validation — il n'existe pas de « chemin agent » plus permissif.
const clientDetailInclude = {
  contacts: { orderBy: [{ principal: 'desc' as const }, { nom: 'asc' as const }] },
  sites: { orderBy: [{ principal: 'desc' as const }, { nom: 'asc' as const }] },
};

function clientApiError(res: express.Response, error: unknown) {
  if ((error as { code?: string })?.code === 'P2002') {
    return res.status(409).json({ error: 'Ce SIREN, ce siège social ou cette adresse de facturation est déjà pris pour ce client.' });
  }
  if ((error as { code?: string })?.code === 'P2025') {
    return res.status(404).json({ error: 'Enregistrement introuvable.' });
  }
  const message = error instanceof Error ? error.message : 'Erreur client.';
  const saisie = message.startsWith('Champ client invalide') || message.includes('obligatoire') || message.includes('SIREN');
  return res.status(saisie ? 400 : 500).json({ error: saisie ? message : 'Erreur client.' });
}

// Recherche plein texte simple sur la raison sociale, le nom commercial et le SIREN.
function clientRecherche(q: string) {
  if (!q) return {};
  return {
    OR: [
      { raisonSociale: { contains: q, mode: 'insensitive' as const } },
      { nomCommercial: { contains: q, mode: 'insensitive' as const } },
      { siren: { contains: q } },
    ],
  };
}

const listerClients: express.RequestHandler = async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const actif = req.query.actif === 'false' ? false : true;
  try {
    const clients = await prisma.client.findMany({
      where: { actif, ...clientRecherche(q) },
      orderBy: { raisonSociale: 'asc' },
      take: 200,
      include: clientDetailInclude,
    });
    res.json({ clients });
  } catch (error) {
    clientApiError(res, error);
  }
};

const lireClient: express.RequestHandler = async (req, res) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: paramId(req) }, include: clientDetailInclude });
    if (!client) return res.status(404).json({ error: 'Client introuvable.' });
    res.json(client);
  } catch (error) {
    clientApiError(res, error);
  }
};

const creerClient: express.RequestHandler = async (req, res) => {
  try {
    const data = clientPayload((req.body ?? {}) as Record<string, unknown>, true);
    res.status(201).json(await prisma.client.create({ data: data as never, include: clientDetailInclude }));
  } catch (error) {
    clientApiError(res, error);
  }
};

const modifierClient: express.RequestHandler = async (req, res) => {
  try {
    const data = clientPayload((req.body ?? {}) as Record<string, unknown>);
    res.json(await prisma.client.update({ where: { id: paramId(req) }, data: data as never, include: clientDetailInclude }));
  } catch (error) {
    clientApiError(res, error);
  }
};

// Désactivation, jamais suppression : un client porte un historique (chantiers, parc
// installé) qu'une suppression rendrait orphelin.
const desactiverClient: express.RequestHandler = async (req, res) => {
  try {
    res.json(await prisma.client.update({ where: { id: paramId(req) }, data: { actif: false } }));
  } catch (error) {
    clientApiError(res, error);
  }
};

const creerContact: express.RequestHandler = async (req, res) => {
  const clientId = String(req.params.clientId);
  try {
    const data = contactPayload((req.body ?? {}) as Record<string, unknown>, true);
    // Un seul contact principal par client : poser le drapeau retire l'ancien.
    if (data.principal) await prisma.clientContact.updateMany({ where: { clientId }, data: { principal: false } });
    res.status(201).json(await prisma.clientContact.create({ data: { ...data, clientId } as never }));
  } catch (error) {
    clientApiError(res, error);
  }
};

const modifierContact: express.RequestHandler = async (req, res) => {
  const clientId = String(req.params.clientId);
  const id = paramId(req);
  try {
    const data = contactPayload((req.body ?? {}) as Record<string, unknown>);
    if (data.principal) await prisma.clientContact.updateMany({ where: { clientId, id: { not: id } }, data: { principal: false } });
    // updateMany (et non update) : le clientId de l'URL fait partie du filtre, on ne peut
    // donc pas modifier le contact d'un autre client en devinant son identifiant.
    const maj = await prisma.clientContact.updateMany({ where: { id, clientId }, data: data as never });
    if (!maj.count) return res.status(404).json({ error: 'Contact introuvable.' });
    res.json(await prisma.clientContact.findUnique({ where: { id } }));
  } catch (error) {
    clientApiError(res, error);
  }
};

// Siège social et adresse de facturation sont uniques par client (index partiels
// PostgreSQL). Comme pour le contact principal, poser le drapeau retire l'ancien plutôt
// que de renvoyer un conflit que l'utilisateur devrait résoudre à la main.
async function libererDrapeauxSite(clientId: string, data: Record<string, unknown>, sauf?: string) {
  const exclure = sauf ? { id: { not: sauf } } : {};
  if (data.estSiegeSocial) await prisma.clientSite.updateMany({ where: { clientId, ...exclure }, data: { estSiegeSocial: false } });
  if (data.estSiteFacturation) await prisma.clientSite.updateMany({ where: { clientId, ...exclure }, data: { estSiteFacturation: false } });
  if (data.principal) await prisma.clientSite.updateMany({ where: { clientId, ...exclure }, data: { principal: false } });
}

const creerSite: express.RequestHandler = async (req, res) => {
  const clientId = String(req.params.clientId);
  try {
    const data = sitePayload((req.body ?? {}) as Record<string, unknown>, true);
    await libererDrapeauxSite(clientId, data);
    res.status(201).json(await prisma.clientSite.create({ data: { ...data, clientId } as never }));
  } catch (error) {
    clientApiError(res, error);
  }
};

const modifierSite: express.RequestHandler = async (req, res) => {
  const clientId = String(req.params.clientId);
  const id = paramId(req);
  try {
    const data = sitePayload((req.body ?? {}) as Record<string, unknown>);
    await libererDrapeauxSite(clientId, data, id);
    const maj = await prisma.clientSite.updateMany({ where: { id, clientId }, data: data as never });
    if (!maj.count) return res.status(404).json({ error: 'Site introuvable.' });
    res.json(await prisma.clientSite.findUnique({ where: { id } }));
  } catch (error) {
    clientApiError(res, error);
  }
};

// --- Parc d'équipements installés ---
// Le matériel est toujours rattaché à un client ET à l'un de ses sites. Cette double
// vérification interdit de déplacer un équipement vers le site d'un autre client en
// devinant un identifiant. L'archivage préserve la série, la garantie et l'historique.
const equipementInclude = { catalogueEquipement: true, clientSite: true };

function equipementTexte(value: unknown, champ: string, requis = false) {
  const texte = value == null ? '' : String(value).trim();
  if (requis && !texte) throw new Error(`${champ} obligatoire.`);
  if (texte.length > 500) throw new Error(`${champ} invalide.`);
  return texte || null;
}

function equipementDate(value: unknown, champ: string) {
  if (value == null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`${champ} invalide.`);
  return date;
}

async function equipementPayload(clientId: string, body: Record<string, unknown>) {
  const catalogueEquipementId = equipementTexte(body.catalogueEquipementId, 'Modèle équipement', true)!;
  const clientSiteId = equipementTexte(body.clientSiteId, 'Site', true)!;
  const [modele, site] = await Promise.all([
    prisma.catalogueEquipement.findUnique({ where: { id: catalogueEquipementId } }),
    prisma.clientSite.findFirst({ where: { id: clientSiteId, clientId } }),
  ]);
  if (!modele) throw new Error('Modèle équipement introuvable.');
  if (!site) throw new Error('Le site doit appartenir au client.');
  return {
    catalogueEquipementId,
    clientSiteId,
    numeroSerie: equipementTexte(body.numeroSerie, 'Numéro de série'),
    imei: equipementTexte(body.imei, 'IMEI'),
    adresseMac: equipementTexte(body.adresseMac, 'Adresse MAC'),
    installeLe: equipementDate(body.installeLe, 'Date d’installation'),
    garantieJusquAu: equipementDate(body.garantieJusquAu, 'Date de garantie'),
    notes: equipementTexte(body.notes, 'Notes'),
  };
}

function equipementApiError(res: express.Response, error: unknown) {
  if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Ce numéro de série est déjà enregistré pour ce modèle.' });
  const message = error instanceof Error ? error.message : 'Opération sur le parc impossible.';
  if (message.includes('obligatoire') || message.includes('invalide') || message.includes('introuvable') || message.includes('appartenir')) {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: 'Opération sur le parc impossible.' });
}

const listerEquipementsClient: express.RequestHandler = async (req, res) => {
  const clientId = String(req.params.clientId);
  try {
    const equipements = await prisma.equipementInstalle.findMany({
      where: { clientId, ...(req.query.inclureArchives === 'true' ? {} : { statut: { not: 'ARCHIVE' } }) },
      include: equipementInclude,
      // 'desc' plutôt que 'asc' : alphabétiquement ARCHIVE < INSTALLE, un tri croissant
      // ferait donc remonter le matériel archivé avant le matériel actif dès que
      // inclureArchives=true est demandé — l'inverse de ce qu'on veut consulter en premier.
      orderBy: [{ statut: 'desc' }, { createdAt: 'desc' }],
    });
    res.json(equipements);
  } catch (error) {
    equipementApiError(res, error);
  }
};

const creerEquipementClient: express.RequestHandler = async (req, res) => {
  const clientId = String(req.params.clientId);
  try {
    const data = await equipementPayload(clientId, (req.body ?? {}) as Record<string, unknown>);
    res.status(201).json(await prisma.equipementInstalle.create({ data: { ...data, clientId }, include: equipementInclude }));
  } catch (error) {
    equipementApiError(res, error);
  }
};

const archiverEquipementClient: express.RequestHandler = async (req, res) => {
  const clientId = String(req.params.clientId);
  const id = paramId(req);
  try {
    const maj = await prisma.equipementInstalle.updateMany({ where: { id, clientId }, data: { statut: 'ARCHIVE' } });
    if (!maj.count) return res.status(404).json({ error: 'Équipement introuvable.' });
    res.json(await prisma.equipementInstalle.findUnique({ where: { id }, include: equipementInclude }));
  } catch (error) {
    equipementApiError(res, error);
  }
};

routeMixte('get', '/clients', 'clients:read', listerClients, [requirePermission('clients:read')]);
routeMixte('post', '/clients', 'clients:write', creerClient);
routeMixte('get', '/clients/:id', 'clients:read', lireClient, [requirePermission('clients:read')]);
routeMixte('put', '/clients/:id', 'clients:write', modifierClient);
routeMixte('delete', '/clients/:id', 'clients:write', desactiverClient);
routeMixte('post', '/clients/:clientId/contacts', 'clients:write', creerContact);
routeMixte('put', '/clients/:clientId/contacts/:id', 'clients:write', modifierContact);
routeMixte('post', '/clients/:clientId/sites', 'clients:write', creerSite);
routeMixte('put', '/clients/:clientId/sites/:id', 'clients:write', modifierSite);
routeMixte('get', '/clients/:clientId/equipements', 'equipements:read', listerEquipementsClient);
routeMixte('post', '/clients/:clientId/equipements', 'equipements:write', creerEquipementClient);
routeMixte('post', '/clients/:clientId/equipements/:id/archiver', 'equipements:write', archiverEquipementClient);

// --- Catalogue natif Iris ---
// Trois familles partagent la même forme (référence, nom, prix, TVA, catégorie) et sont
// donc servies par les mêmes routes, la famille étant un paramètre d'URL.
//
// Le typage passe par `Prisma.CataloguePrestationDelegate` volontairement élargi : les
// trois délégués Prisma ont des signatures génériques DIFFÉRENTES, si bien qu'une union
// des trois n'est plus appelable (TS2349 — « none of those signatures are compatible with
// each other »). On fixe donc UN type de délégué de référence pour la table de routage ;
// les champs propres à chaque famille (durée, stock, fabricant) sont ajoutés ensuite par
// `catalogueExtraPayload` et validés à l'exécution.
type CatalogueFamily = 'prestations' | 'articles' | 'equipements';
type CatalogueDelegate = typeof prisma.cataloguePrestation;
const catalogueModels: Record<CatalogueFamily, CatalogueDelegate> = {
  prestations: prisma.cataloguePrestation,
  articles: prisma.catalogueArticle as unknown as CatalogueDelegate,
  equipements: prisma.catalogueEquipement as unknown as CatalogueDelegate,
};

function catalogueFamily(value: string): CatalogueFamily | null {
  return value === 'prestations' || value === 'articles' || value === 'equipements' ? value : null;
}

// Nombre positif obligatoire : `Number('')` vaut 0 et `Number('abc')` vaut NaN, on refuse
// donc explicitement tout ce qui n'est pas un nombre fini positif (prix, TVA, stock).
function catalogueNombre(value: unknown, champ: string, defaut = 0): number {
  const n = Number(value ?? defaut);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${champ} invalide.`);
  return n;
}

// Champs communs aux trois familles.
function cataloguePayload(body: Record<string, unknown>) {
  const reference = String(body.reference || '').trim();
  const nom = String(body.nom || '').trim();
  if (!reference || !nom || reference.length > 80 || nom.length > 200) {
    throw new Error('Référence et nom sont obligatoires.');
  }
  return {
    reference,
    nom,
    description: body.description ? String(body.description).trim() : null,
    categorieId: body.categorieId ? String(body.categorieId) : null,
    tauxTva: catalogueNombre(body.tauxTva, 'TVA', 20),
    prixVenteHt: catalogueNombre(body.prixVenteHt, 'Prix de vente'),
  };
}

// Champs propres à une famille : une prestation a une durée, un article un stock, un
// équipement un fabricant (il devient un EquipementInstalle une fois posé chez un client).
function catalogueExtraPayload(family: CatalogueFamily, body: Record<string, unknown>) {
  if (family === 'prestations') {
    return {
      unite: String(body.unite || 'unité'),
      dureeIndicativeMin: body.dureeIndicativeMin == null ? null : catalogueNombre(body.dureeIndicativeMin, 'Durée indicative'),
    };
  }
  if (family === 'articles') {
    return {
      unite: String(body.unite || 'unité'),
      prixAchatHt: body.prixAchatHt == null ? null : catalogueNombre(body.prixAchatHt, "Prix d'achat"),
      stockSuivi: !!body.stockSuivi,
      stockActuel: catalogueNombre(body.stockActuel, 'Stock'),
    };
  }
  return { fabricant: body.fabricant ? String(body.fabricant).trim() : null };
}

// Erreur catalogue : 409 sur une référence déjà prise (contrainte unique Prisma P2002),
// 400 sur une saisie refusée par la validation, 500 sinon.
function catalogueApiError(res: express.Response, error: unknown) {
  if ((error as { code?: string })?.code === 'P2002') {
    return res.status(409).json({ error: 'Cette référence catalogue est déjà utilisée.' });
  }
  if (error instanceof Error && !(error as { code?: string }).code) {
    return res.status(400).json({ error: error.message });
  }
  return res.status(500).json({ error: 'Opération catalogue impossible.' });
}

const listerCategoriesCatalogue: express.RequestHandler = async (_req, res) => {
  try {
    res.json(await prisma.catalogueCategorie.findMany({ orderBy: { nom: 'asc' } }));
  } catch {
    res.status(500).json({ error: 'Error fetching catalogue categories' });
  }
};

const creerCategorieCatalogue: express.RequestHandler = async (req, res) => {
  const nom = String(req.body?.nom || '').trim();
  if (!nom || nom.length > 100) return res.status(400).json({ error: 'Nom de catégorie requis.' });
  try {
    res.status(201).json(await prisma.catalogueCategorie.create({
      data: {
        nom,
        description: req.body?.description ? String(req.body.description).trim() : null,
        parentId: req.body?.parentId ? String(req.body.parentId) : null,
      },
    }));
  } catch {
    res.status(409).json({ error: 'Cette catégorie existe déjà ou sa catégorie parente est invalide.' });
  }
};

const listerCatalogue: express.RequestHandler = async (req, res) => {
  const family = catalogueFamily(String(req.params.family));
  if (!family) return res.status(404).json({ error: 'Famille catalogue inconnue.' });
  try {
    res.json(decimalToNumber(await catalogueModels[family].findMany({
      include: { categorie: true },
      orderBy: { nom: 'asc' },
    })));
  } catch {
    res.status(500).json({ error: 'Error fetching catalogue' });
  }
};

const creerFicheCatalogue: express.RequestHandler = async (req, res) => {
  const family = catalogueFamily(String(req.params.family));
  if (!family) return res.status(404).json({ error: 'Famille catalogue inconnue.' });
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data = { ...cataloguePayload(body), ...catalogueExtraPayload(family, body) };
    res.status(201).json(decimalToNumber(await catalogueModels[family].create({
      data: data as never,
      include: { categorie: true },
    })));
  } catch (error) {
    catalogueApiError(res, error);
  }
};

// Modification d'une fiche catalogue. Une référence déjà utilisée ailleurs renvoie 409 ;
// une fiche inexistante renvoie 404 (Prisma P2025).
const modifierFicheCatalogue: express.RequestHandler = async (req, res) => {
  const family = catalogueFamily(String(req.params.family));
  if (!family) return res.status(404).json({ error: 'Famille catalogue inconnue.' });
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = { ...cataloguePayload(body), ...catalogueExtraPayload(family, body) };
    if (body.actif !== undefined) data.actif = !!body.actif;
    res.json(decimalToNumber(await catalogueModels[family].update({
      where: { id: paramId(req) },
      data: data as never,
      include: { categorie: true },
    })));
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2025') {
      return res.status(404).json({ error: 'Fiche catalogue introuvable.' });
    }
    catalogueApiError(res, error);
  }
};

// Désactivation (jamais de suppression) : une fiche catalogue peut déjà être référencée
// par un équipement installé ou, demain, par un devis — la retirer casserait l'historique.
const desactiverFicheCatalogue: express.RequestHandler = async (req, res) => {
  const family = catalogueFamily(String(req.params.family));
  if (!family) return res.status(404).json({ error: 'Famille catalogue inconnue.' });
  try {
    res.json(decimalToNumber(await catalogueModels[family].update({
      where: { id: paramId(req) },
      data: { actif: false } as never,
    })));
  } catch {
    res.status(404).json({ error: 'Fiche catalogue introuvable.' });
  }
};

// Le catalogue est monté sur les deux portes d'entrée, comme le référentiel clients :
// un agent doit pouvoir lire les références et les tarifs pour rédiger un devis, et les
// enrichir sous contrôle d'un scope d'écriture distinct de la lecture.
routeMixte('get', '/catalogue/categories', 'catalogue:read', listerCategoriesCatalogue);
routeMixte('post', '/catalogue/categories', 'catalogue:write', creerCategorieCatalogue);
routeMixte('get', '/catalogue/:family', 'catalogue:read', listerCatalogue);
routeMixte('post', '/catalogue/:family', 'catalogue:write', creerFicheCatalogue);
routeMixte('put', '/catalogue/:family/:id', 'catalogue:write', modifierFicheCatalogue);
routeMixte('delete', '/catalogue/:family/:id', 'catalogue:write', desactiverFicheCatalogue);

// --- Devis natifs versionnés ---
class DevisSaisieError extends Error {}
// Refus qui ne vient pas de la saisie mais de l'état de l'affaire : la requête est bien
// formée, c'est le monde qui s'y oppose. 409, pas 400.
class DevisConflitError extends Error {}
// Arrondi commercial exact au centime d’une ligne : quantité (au millième) × PU HT
// (au centime). Les montants de facture et d’avoir sont toujours positifs ; leur sens est
// porté par le type du document. Aucun flottant ne participe à ce calcul.
function entierDecimal(value: unknown, decimales: number): bigint {
  const texte = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const expression = new RegExp(`^(\\d+)(?:[,.](\\d{1,${decimales}}))?$`);
  const resultat = expression.exec(texte);
  if (!resultat) throw new FactureInvalideError('Montant de ligne invalide.');
  return BigInt(resultat[1]) * 10n ** BigInt(decimales) + BigInt((resultat[2] || '').padEnd(decimales, '0') || '0');
}

function arrondiCommercialLigneHt(quantite: unknown, prixUnitaireHt: unknown): number {
  const milliemes = entierDecimal(quantite, 3);
  const centimesPu = entierDecimal(prixUnitaireHt, 2);
  // Le produit est exprimé en millièmes de centime. Ajouter 500 puis diviser par 1 000
  // applique exactement « moitié vers le haut » pour les valeurs positives.
  return Number((milliemes * centimesPu + 500n) / 1000n) / 100;
}

function centimesTtcLigne(totalHt: number, tauxTva: unknown): number {
  const centimesHt = entierDecimal(totalHt, 2);
  const millièmesTaux = entierDecimal(tauxTva, 3);
  // (100 % + taux) est exprimé en millièmes de pourcentage. L'arrondi final est
  // commercial, identique à la ligne HT, y compris aux taux 10 % et 5,5 %.
  return Number((centimesHt * (100000n + millièmesTaux) + 50000n) / 100000n) / 100;
}

const centimes = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
function devisPayload(body: Record<string, unknown>) {
  const clientId = String(body.clientId || '').trim(), objet = String(body.objet || '').trim();
  const lignes = Array.isArray(body.lignes) ? body.lignes : [];
  if (!clientId || !objet || objet.length > 300 || !lignes.length) throw new DevisSaisieError('Client, objet et au moins une ligne sont requis.');
  const lignesCalculees = lignes.map((ligne, ordre) => {
    const item = ligne as Record<string, unknown>, designation = String(item.designation || '').trim(), nature = String(item.nature || 'MAIN_OEUVRE');
    // Mêmes échelles que les factures : le calcul entier ne doit jamais recevoir une précision
    // que ses unités (millièmes / centimes) ne représentent pas.
    const quantite = nombreDecimalNonNegatif(item.quantite, 9, false, 3);
    const prixUnitaireHt = nombreDecimalNonNegatif(item.prixUnitaireHt, 10, true);
    const tauxTva = item.tauxTva === undefined || item.tauxTva === null ? 20 : nombreDecimalNonNegatif(item.tauxTva, 3, true);
    if (!['MAIN_OEUVRE', 'FOURNITURE'].includes(nature) || !designation || quantite === null || quantite <= 0 || prixUnitaireHt === null || tauxTva === null || tauxTva > 100) throw new DevisSaisieError('Ligne de devis invalide.');
    const totalHt = arrondiCommercialLigneHt(quantite, prixUnitaireHt);
    const totalTtc = centimesTtcLigne(totalHt, tauxTva);
    return { ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc };
  });
  const totalHt = centimes(lignesCalculees.reduce((t, l) => t + l.totalHt, 0));
  // Comme les factures et avoirs, la TVA est arrondie sur la base HT cumulée de chaque taux.
  const totalTva = centimes(tauxUtilises(lignesCalculees).reduce((total, taux) => total + tvaDuTaux(lignesCalculees, taux), 0));
  const totalTtc = centimes(totalHt + totalTva);
  return { clientId, objet, lignesCalculees, totalHt, totalTva, totalTtc };
}
function devisErreur(res: express.Response, error: unknown) {
  if (error instanceof DevisSaisieError) return res.status(400).json({ error: error.message });
  if (error instanceof DevisConflitError) return res.status(409).json({ error: error.message });
  if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Une révision concurrente vient d’être créée, réessayez.' });
  console.error('Devis:', error); return res.status(500).json({ error: 'Opération devis impossible.' });
}
const devisInclude = { lignes: { orderBy: { ordre: 'asc' as const } }, client: true, conversion: true };
async function nouveauNumeroDevis() {
  const societe = await getCompanySettings();
  const annee = anneeEntreprise(new Date(), societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
  const [sequence] = await prisma.$queryRaw<{ dernierNumero: number }[]>(Prisma.sql`INSERT INTO "SequenceAffaire" ("annee", "dernierNumero") VALUES (${annee}, 1) ON CONFLICT ("annee") DO UPDATE SET "dernierNumero" = "SequenceAffaire"."dernierNumero" + 1 RETURNING "dernierNumero"`);
  return `A${String(annee).slice(-2)}-${String(sequence.dernierNumero).padStart(4, '0')}`;
}
const creerDevis: express.RequestHandler = async (req, res) => { try {
  const payload = devisPayload((req.body ?? {}) as Record<string, unknown>);
  if (!await prisma.client.findUnique({ where: { id: payload.clientId } })) throw new DevisSaisieError('Client introuvable.');
  // L'acompte se décide sur le devis INITIAL. Son taux est figé ici, à partir du paramètre
  // du jour : un devis émis en janvier garde son taux de janvier, quoi qu'il advienne du
  // réglage global — c'est la non-rétroactivité posée pour toutes les règles chiffrées.
  const acompteExige = !!(req.body ?? {}).acompteExige;
  const { tauxAcompteDefaut } = await getParametres();
  const tauxAcompte = acompteExige
    ? (nombreDecimalNonNegatif((req.body ?? {}).tauxAcompte, 3) ?? Number(tauxAcompteDefaut))
    : null;
  if (tauxAcompte !== null && tauxAcompte > 100) throw new DevisSaisieError('Le taux d’acompte ne peut pas dépasser 100 %.');
  const devis = await prisma.devis.create({ data: { dossierId: crypto.randomUUID(), numero: await nouveauNumeroDevis(), version: 1, clientId: payload.clientId, objet: payload.objet, totalHt: payload.totalHt, totalTva: payload.totalTva, totalTtc: payload.totalTtc, acompteExige, tauxAcompte, lignes: { create: payload.lignesCalculees } }, include: devisInclude });
  res.status(201).json(decimalToNumber(devis));
} catch (error) { devisErreur(res, error); } };
const listerDevis: express.RequestHandler = async (_req, res) => { try { res.json(decimalToNumber(await prisma.devis.findMany({ include: devisInclude, orderBy: { createdAt: 'desc' } }))); } catch (error) { devisErreur(res, error); } };
const creerRevision: express.RequestHandler = async (req, res) => { try {
  const precedent = await prisma.devis.findUnique({ where: { id: paramId(req) }, include: devisInclude });
  if (!precedent) throw new DevisSaisieError('Devis introuvable.');
  for (let tentative = 0; tentative < 3; tentative++) {
    const version = ((await prisma.devis.aggregate({ where: { dossierId: precedent.dossierId }, _max: { version: true } }))._max.version ?? 0) + 1;
    try { const devis = await prisma.devis.create({ data: { dossierId: precedent.dossierId, numero: precedent.numero, version, clientId: precedent.clientId, objet: precedent.objet, totalHt: precedent.totalHt, totalTva: precedent.totalTva, totalTtc: precedent.totalTtc, acompteExige: precedent.acompteExige, tauxAcompte: precedent.tauxAcompte, lignes: { create: precedent.lignes.map(({ ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc }) => ({ ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc })) } }, include: devisInclude }); return void res.status(201).json(decimalToNumber(devis)); } catch (error) { if ((error as { code?: string })?.code !== 'P2002' || tentative === 2) throw error; }
  }
} catch (error) { devisErreur(res, error); } };
routeMixte('get', '/devis', 'devis:read', listerDevis, [requirePermission('devis:read')]);
routeMixte('post', '/devis', 'devis:write', creerDevis, [requirePermission('devis:write')]);
routeMixte('post', '/devis/:id/revisions', 'devis:write', creerRevision, [requirePermission('devis:write')]);
// Cycle de vie d'un devis. `ANNULE` ne figure dans aucune liste de destinations : on n'y
// entre que par la route d'annulation, qui exige un motif et vérifie le chantier lié — et
// on n'en sort jamais. `EN_ATTENTE_ACOMPTE` est le choix explicite fait après acceptation :
// ouvrir le chantier tout de suite, ou attendre l'acompte. Un devis peut y revenir tant
// que l'acompte n'est pas constaté, mais pas une fois le chantier ouvert.
const TRANSITIONS_DEVIS: Record<string, string[]> = {
  BROUILLON: ['ENVOYE'],
  ENVOYE: ['ACCEPTE', 'REFUSE', 'BROUILLON'],
  ACCEPTE: ['EN_ATTENTE_ACOMPTE'],
  EN_ATTENTE_ACOMPTE: ['ACCEPTE'],
  REFUSE: [],
  ANNULE: [],
};

// Un devis dont le chantier existe déjà est figé : sa seule évolution possible est
// l'annulation, qui passe par sa propre route.
function refusStatutFige(devis: { statut: string; conversion?: unknown }): string | null {
  if (devis.statut === 'ANNULE') return 'Ce devis est annulé : son statut ne peut plus changer.';
  if (devis.conversion) return 'Le chantier de ce devis est déjà ouvert : seule une annulation peut revenir dessus.';
  return null;
}
const changerStatutDevis: express.RequestHandler = async (req, res) => { try {
  const statut = String((req.body ?? {}).statut || '');
  const devis = await prisma.devis.findUnique({ where: { id: paramId(req) }, include: { conversion: true } });
  if (!devis) return void res.status(404).json({ error: 'Devis introuvable.' });
  const fige = refusStatutFige(devis);
  if (fige) throw new DevisSaisieError(fige);
  if (!TRANSITIONS_DEVIS[devis.statut]?.includes(statut)) throw new DevisSaisieError(`Transition ${devis.statut} → ${statut} interdite.`);
  // Passer en attente d'acompte n'a de sens que si le devis en exige un.
  if (statut === 'EN_ATTENTE_ACOMPTE' && !devis.acompteExige) throw new DevisSaisieError('Ce devis n’exige pas d’acompte.');
  if (statut === 'ACCEPTE' && devis.statut === 'EN_ATTENTE_ACOMPTE' && !devis.acompteRecuLe) throw new DevisSaisieError('L’acompte de ce devis n’a pas encore été constaté.');
  const maj = await prisma.devis.update({ where: { id: devis.id }, data: { statut }, include: devisInclude });
  res.json(decimalToNumber(maj));
} catch (error) { devisErreur(res, error); } };
routeMixte('put', '/devis/:id/statut', 'devis:write', changerStatutDevis, [requirePermission('devis:write')]);

// Une conversion ne démarre qu'après acceptation. Phase 5 cible le chantier, déjà natif ;
// les cibles intervention, contrat et facture seront activées par leurs modules respectifs.
const convertirDevis: express.RequestHandler = async (req, res) => { try {
  const cible = String((req.body ?? {}).cible || '');
  if (cible !== 'CHANTIER') throw new DevisSaisieError('Cible de conversion non disponible.');
  const resultat = await prisma.$transaction(async tx => {
    const devis = await tx.devis.findUnique({ where: { id: paramId(req) }, include: { client: true, conversion: true, lignes: true } });
    if (!devis) throw new DevisSaisieError('Devis introuvable.');
    if (devis.statut === 'ANNULE') throw new DevisSaisieError('Ce devis est annulé : il ne peut plus ouvrir de chantier.');
    if (devis.statut === 'EN_ATTENTE_ACOMPTE') throw new DevisSaisieError('Ce devis attend son acompte : le chantier ne peut pas encore être ouvert.');
    if (devis.statut !== 'ACCEPTE') throw new DevisSaisieError('Seul un devis accepté peut être converti.');
    if (devis.conversion) throw new DevisSaisieError('Ce devis a déjà été converti.');
    // Verrou de fond, indépendant du statut : un devis qui exige un acompte n'ouvre pas de
    // chantier tant que sa réception n'a pas été constatée. Le statut peut être manipulé,
    // pas ce fait.
    if (devis.acompteExige && !devis.acompteRecuLe) throw new DevisSaisieError('L’acompte exigé par ce devis n’a pas été constaté : le chantier ne peut pas être ouvert.');
    const budgetMaterielVendu = centimes(devis.lignes.filter(l => l.nature === 'FOURNITURE').reduce((total, l) => total + Number(l.totalHt), 0));
    const budgetMainOeuvreVendu = centimes(devis.totalHt.toNumber() - budgetMaterielVendu);
    const heuresVendues = devis.lignes.filter(l => l.nature === 'MAIN_OEUVRE').reduce((total, l) => total + Number(l.quantite), 0);
    const chantier = await tx.chantier.create({ data: { nom: devis.objet, client: devis.client.raisonSociale, clientId: devis.clientId, numeroDevis: devis.numero, dateDebut: new Date(), budgetGlobalVendu: devis.totalHt, budgetMaterielVendu, budgetMainOeuvreVendu, heuresVendues } });
    await tx.devisConversion.create({ data: { devisId: devis.id, dossierId: devis.dossierId, cibleType: 'CHANTIER', cibleId: chantier.id } });
    return chantier;
  });
  res.status(201).json(decimalToNumber(resultat));
} catch (error) { devisErreur(res, error); } };
routeMixte('post', '/devis/:id/convertir', 'devis:write', convertirDevis, [requirePermission('devis:write')]);

// --- Constatation de l'acompte ---
// Tant que le module paiements (phase 9) n'existe pas, la réception d'un acompte se
// constate à la main : date, montant et référence du règlement, par un administrateur.
// Le rapprochement bancaire alimentera ces mêmes champs plus tard sans changer la règle.
// Réservée aux administrateurs : constater un encaissement débloque l'ouverture d'un
// chantier, ce n'est pas un geste que celui qui a vendu l'affaire se rend à lui-même.
app.post('/api/devis/:id/acompte', requireAuth, requireAdmin, async (req, res) => { try {
  const devis = await prisma.devis.findUnique({ where: { id: paramId(req) } });
  if (!devis) return void res.status(404).json({ error: 'Devis introuvable.' });
  if (devis.statut === 'ANNULE') throw new DevisSaisieError('Ce devis est annulé.');
  if (!devis.acompteExige) throw new DevisSaisieError('Ce devis n’exige pas d’acompte.');
  if (devis.acompteRecuLe) throw new DevisSaisieError('L’acompte de ce devis a déjà été constaté.');

  const recuLe = dateIsoStricte((req.body ?? {}).recuLe);
  if (!recuLe) throw new DevisSaisieError('La date de réception doit être valide au format JJ-MM-AAAA.');
  const montant = nombreDecimalNonNegatif((req.body ?? {}).montant, 10);
  if (montant === null) throw new DevisSaisieError('Le montant de l’acompte doit être un nombre strictement positif.');
  const reference = String((req.body ?? {}).reference ?? '').trim();
  if (!reference) throw new DevisSaisieError('La référence du règlement est requise.');

  const maj = await prisma.devis.update({
    where: { id: devis.id },
    data: {
      acompteRecuLe: recuLe, acompteMontant: montant, acompteReference: reference,
      acompteConstateParId: (req as AuthRequest).user!.id,
      // Constater l'acompte remet le devis en état d'être converti.
      statut: devis.statut === 'EN_ATTENTE_ACOMPTE' ? 'ACCEPTE' : devis.statut,
    },
    include: devisInclude,
  });
  res.json(decimalToNumber(maj));
} catch (error) { devisErreur(res, error); } });

// --- Annulation d'un devis, et archivage du chantier qui en est issu ---
// C'est le SEUL chemin qui revient sur une affaire ouverte par erreur : un chantier ne se
// supprime plus (cf. DELETE /api/chantiers/:id). Réservée aux administrateurs, elle exige
// un motif, et elle est refusée dès qu'une heure ou un achat a été saisi sur le chantier —
// à ce stade l'affaire a commencé à vivre, on ne l'efface pas, on la mène à son terme.
//
// Le chantier n'est pas détruit mais archivé : il sort des listes, des coûts, des marges et
// des commissions, et conserve la raison de son annulation. Une annulation ne s'annule pas ;
// la reprise passe par la duplication du devis (cf. POST /devis/:id/duplication).
app.post('/api/devis/:id/annulation', requireAuth, requireAdmin, async (req, res) => { try {
  const motif = String((req.body ?? {}).motif ?? '').trim();
  if (!motif) throw new DevisSaisieError('Un motif d’annulation est obligatoire.');

  const resultat = await prisma.$transaction(async tx => {
    const devis = await tx.devis.findUnique({ where: { id: paramId(req) }, include: { conversion: true } });
    if (!devis) throw new DevisSaisieError('Devis introuvable.');
    if (devis.statut === 'ANNULE') throw new DevisSaisieError('Ce devis est déjà annulé.');

    let chantierArchive: string | null = null;
    if (devis.conversion?.cibleType === 'CHANTIER') {
      const chantierId = devis.conversion.cibleId;
      // Le verrou porte sur les écritures VIVANTES : une ligne déjà archivée n'engage rien.
      const [heures, achats] = await Promise.all([
        tx.pointageHeure.count({ where: { chantierId, archivedAt: null } }),
        tx.achatReel.count({ where: { chantierId, archivedAt: null } }),
      ]);
      if (heures > 0 || achats > 0) {
        throw new DevisConflitError(
          `Annulation impossible : ce chantier porte déjà ${heures} pointage(s) d’heures et ${achats} achat(s). Une affaire commencée ne s’annule pas.`,
        );
      }
      await tx.chantier.update({
        where: { id: chantierId },
        data: { statut: 'ANNULE', annuleLe: new Date(), annuleParId: (req as AuthRequest).user!.id, motifAnnulation: motif },
      });
      chantierArchive = chantierId;
    }

    const maj = await tx.devis.update({
      where: { id: devis.id },
      data: { statut: 'ANNULE', annuleLe: new Date(), annuleParId: (req as AuthRequest).user!.id, motifAnnulation: motif },
      include: devisInclude,
    });
    return { devis: maj, chantierArchive };
  });
  res.json({ devis: decimalToNumber(resultat.devis), chantierArchive: resultat.chantierArchive });
} catch (error) { devisErreur(res, error); } });

// --- Duplication ---
// Reprend un devis à l'identique — client, objet, lignes, option d'acompte — avec son
// PROPRE numéro d'affaire et un dossier neuf. C'est la voie de reprise après une annulation :
// on ne ressuscite pas un devis annulé, on en refait un. Le duplicata repart en BROUILLON,
// donc à renvoyer et à faire réaccepter : dupliquer ne contourne pas l'accord du client.
// Le lien vers l'origine évite de retrouver deux devis jumeaux sans savoir lequel remplace
// l'autre. Le taux d'acompte est relu depuis les paramètres du jour : un duplicata est un
// devis neuf, il suit la politique en vigueur au moment où il est émis.
app.post('/api/devis/:id/duplication', requireAuth, requirePermission('devis:write'), async (req, res) => { try {
  const source = await prisma.devis.findUnique({ where: { id: paramId(req) }, include: devisInclude });
  if (!source) return void res.status(404).json({ error: 'Devis introuvable.' });
  const { tauxAcompteDefaut } = await getParametres();
  const duplicata = await prisma.devis.create({
    data: {
      dossierId: crypto.randomUUID(), numero: await nouveauNumeroDevis(), version: 1,
      clientId: source.clientId, objet: source.objet,
      totalHt: source.totalHt, totalTva: source.totalTva, totalTtc: source.totalTtc,
      acompteExige: source.acompteExige,
      tauxAcompte: source.acompteExige ? tauxAcompteDefaut : null,
      origineDevisId: source.id,
      lignes: { create: source.lignes.map(({ ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc }) => ({ ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc })) },
    },
    include: devisInclude,
  });
  res.status(201).json(decimalToNumber(duplicata));
} catch (error) { devisErreur(res, error); } });

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
    const company = await prisma.companySettings.upsert({
      where: { id: 'singleton' },
      update: data,
      create: { id: 'singleton', ...data },
    });
    res.json(company);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error updating company settings';
    res.status(message.startsWith('Champ société invalide') || message.startsWith('Couleur invalide') || message.startsWith('Fuseau horaire invalide') ? 400 : 500)
      .json({ error: message });
  }
});

// --- Règles de rémunération commerciale (singleton) ---
// Lecture ouverte aux administrateurs (l'écran « Mes commerciaux » affiche le barème
// appliqué), écriture réservée au superadmin : ce sont les règles de paie des commerciaux.
app.get('/api/parametres/remuneration', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const regles = await getReglesRemuneration();
    res.json({ ...regles, baremeStandard: serialiseBareme(regles.baremeStandard), baremeReduit: serialiseBareme(regles.baremeReduit) });
  } catch {
    res.status(500).json({ error: 'Error fetching remuneration settings' });
  }
});

// Valide un barème envoyé par le client. Un barème vide est accepté (aucune commission) ;
// ce qui est refusé, c'est un barème incohérent, qui produirait des montants faux en
// silence : taux hors de [0, 100], plafonds non croissants, ou plusieurs tranches non
// plafonnées — seule la dernière peut l'être, sinon les suivantes ne servent à rien.
function validerBareme(valeur: unknown, champ: string): TrancheBareme[] {
  if (!Array.isArray(valeur)) throw new Error(`${champ} : un tableau de tranches est attendu.`);
  if (valeur.length > 20) throw new Error(`${champ} : 20 tranches au maximum.`);
  const tranches: TrancheBareme[] = valeur.map((t: any, i: number) => {
    const taux = Number(t?.taux);
    if (!Number.isFinite(taux) || taux < 0 || taux > 100) {
      throw new Error(`${champ}, tranche ${i + 1} : le taux doit être compris entre 0 et 100.`);
    }
    const brut = t?.plafond;
    const plafond = brut === null || brut === undefined || brut === '' ? Infinity : Number(brut);
    if (plafond !== Infinity && (!Number.isFinite(plafond) || plafond <= 0)) {
      throw new Error(`${champ}, tranche ${i + 1} : le plafond doit être un montant positif, ou vide pour la dernière tranche.`);
    }
    return { plafond, taux };
  });
  // Ce contrôle passe AVANT celui de la croissance : deux tranches sans plafond valent
  // toutes deux Infinity, donc « non croissantes » — un message exact mais incompréhensible
  // pour qui vient simplement de laisser deux plafonds vides.
  if (tranches.filter((t) => t.plafond === Infinity).length > 1) {
    throw new Error(`${champ} : une seule tranche peut être sans plafond, et ce doit être la dernière.`);
  }
  for (let i = 1; i < tranches.length; i++) {
    if (tranches[i].plafond <= tranches[i - 1].plafond) {
      throw new Error(`${champ} : les plafonds doivent être strictement croissants.`);
    }
  }
  return tranches;
}

function montantPositif(valeur: unknown, champ: string): number {
  const n = Number(valeur ?? 0);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${champ} : montant invalide.`);
  return n;
}

app.put('/api/parametres/remuneration', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const libelle = String(body.libelleBaremeReduit ?? '').trim();
    if (!libelle || libelle.length > 80) {
      return res.status(400).json({ error: 'Le libellé du barème réduit est obligatoire (80 caractères au plus).' });
    }
    const data = {
      baremeStandard: serialiseBareme(validerBareme(body.baremeStandard, 'Barème standard')),
      baremeReduit: serialiseBareme(validerBareme(body.baremeReduit, 'Barème réduit')),
      libelleBaremeReduit: libelle,
      objectifCaMensuel: montantPositif(body.objectifCaMensuel, 'Objectif de CA mensuel'),
      primeObjectifCa: montantPositif(body.primeObjectifCa, "Prime d'objectif de CA"),
      objectifMargeMensuel: montantPositif(body.objectifMargeMensuel, 'Objectif de marge mensuel'),
      primeObjectifMarge: montantPositif(body.primeObjectifMarge, "Prime d'objectif de marge"),
      primeSuiviAdministratif: montantPositif(body.primeSuiviAdministratif, 'Prime de suivi administratif'),
    };
    await prisma.parametresRemuneration.upsert({
      where: { id: 'singleton' },
      update: data,
      create: { id: 'singleton', ...data },
    });
    console.warn(`[REMUNERATION] Règles modifiées par ${(req as AuthRequest).user!.id}`);
    const regles = await getReglesRemuneration();
    res.json({ ...regles, baremeStandard: serialiseBareme(regles.baremeStandard), baremeReduit: serialiseBareme(regles.baremeReduit) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Enregistrement impossible.';
    res.status(message.includes('Barème') || message.includes('montant') || message.includes('libellé') ? 400 : 500).json({ error: message });
  }
});

// N'écrit QUE margeCommercialeActive : l'activation des modules (planningActif) est
// réservée au superadmin et passe par PUT /api/modules — un ADMIN ne doit pas pouvoir la
// modifier, même en glissant le champ dans le corps de cette requête.
app.put('/api/parametres', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data: Record<string, unknown> = {
      margeCommercialeActive: !!req.body.margeCommercialeActive,
    };
    // Politique d'acompte de la société : jamais en dur dans le code, éditable ici.
    // Ne s'applique qu'aux devis émis ensuite (cf. Devis.tauxAcompte, figé à l'émission).
    if ('tauxAcompteDefaut' in req.body) {
      const taux = nombreDecimalNonNegatif(req.body.tauxAcompteDefaut, 3, true);
      if (taux === null || taux > 100) {
        return res.status(400).json({ error: 'Le taux d’acompte par défaut doit être un pourcentage compris entre 0 et 100.' });
      }
      data.tauxAcompteDefaut = taux;
    }
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
    // Le libellé du barème réduit voyage avec les modules : c'est le seul réglage lu par
    // TOUS les comptes (la route /parametres/remuneration, elle, est réservée aux admins),
    // et il s'affiche sur la fiche chantier comme sur les écrans commerciaux.
    const { libelleBaremeReduit } = await getReglesRemuneration();
    res.json({ planningActif: isSuper || planningActif, planningActifGlobal: planningActif, libelleBaremeReduit });
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
        const { byCommercial } = await computeCommissionsParCommercial(commerciaux.map((c) => c.id), start, endExclusive, params, await getReglesRemuneration());
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
        const { byCommercial } = await computeCommissionsParCommercial([user.id], start, endExclusive, params, await getReglesRemuneration());
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
app.get('/api/stats/conducteurs', requireAuth, requireTravauxRead, async (req, res) => {
  try {
    const authUser = (req as AuthRequest).user!;
    if (!isAdminRole(authUser.role) && authUser.role !== ROLE_RESPONSABLE) return res.status(403).json({ error: 'Accès réservé à l’administration et aux responsables.' });
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

// Les dates-seules restent des jours métier et ne doivent donc jamais être relues dans
// un fuseau. En revanche, une référence qui est un instant (ou l'instant courant) doit
// d'abord devenir le jour civil de l'entreprise.
function jourCivilDeReference(refParam: unknown, fuseauHoraire: string, instant = new Date()): string {
  if (typeof refParam === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(refParam)) return refParam;
  const parsed = refParam instanceof Date ? refParam : (typeof refParam === 'string' && refParam ? new Date(refParam) : instant);
  return jourCivilEntreprise(isNaN(parsed.getTime()) ? instant : parsed, fuseauHoraire);
}

function ajouterJoursCivils(jour: string, nombre: number): string {
  return new Date(new Date(`${jour}T00:00:00.000Z`).getTime() + nombre * 86400000).toISOString().slice(0, 10);
}

// Convertit minuit du jour civil entreprise en instant pour les champs DateTime tels
// que createdAt. L'itération couvre les fuseaux à changement d'offset sans dépendre du
// fuseau de la machine qui exécute le serveur.
function debutJourCivilEntreprise(jour: string, fuseauHoraire: string): Date {
  const [annee, mois, numeroJour] = jour.split('-').map(Number);
  const cible = Date.UTC(annee, mois - 1, numeroJour);
  let instant = new Date(cible);
  for (let i = 0; i < 2; i++) {
    const parties = new Intl.DateTimeFormat('en-CA', {
      timeZone: fuseauHoraire, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant);
    const valeur = (type: Intl.DateTimeFormatPartTypes) => Number(parties.find((partie) => partie.type === type)?.value);
    const lu = Date.UTC(valeur('year'), valeur('month') - 1, valeur('day'), valeur('hour'), valeur('minute'), valeur('second'));
    instant = new Date(instant.getTime() + cible - lu);
  }
  return instant;
}

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

// Assiduité : administration globale, responsable limité à ses conducteurs directs.
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
    const { start, endExclusive } = periodBounds(period, req.query.ref, societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);

    const chantiers = await prisma.chantier.findMany({
      where: {
        dateDebut: { gte: start, lt: endExclusive },
        ...perimetreChantiers(req),
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
// Chaque tranche de marge du MOIS est commissionnée à son propre taux, comme un barème
// d'impôt progressif : atteindre la tranche haute ne fait pas basculer toute la marge à
// son taux, seule la fraction qui la dépasse l'est.
//
// Les taux, seuils et primes NE SONT PLUS ÉCRITS ICI : ils vivent en base
// (ParametresRemuneration) et s'éditent depuis Administration > Rémunération commerciale.
// Les inscrire dans le code revenait à livrer à chaque client les règles de rémunération
// d'une autre société, et à exiger un redéploiement pour changer un taux.
interface TrancheBareme { plafond: number; taux: number }
interface ReglesRemuneration {
  baremeStandard: TrancheBareme[];
  baremeReduit: TrancheBareme[];
  libelleBaremeReduit: string;
  objectifCaMensuel: number;
  primeObjectifCa: number;
  objectifMargeMensuel: number;
  primeObjectifMarge: number;
  primeSuiviAdministratif: number;
}

// Valeurs de repli, utilisées uniquement si la ligne de paramètres n'existe pas encore
// (base créée avant la migration, ou vidée à la main). Volontairement NEUTRES : aucune
// commission, aucune prime. Mieux vaut un montant nul, visible et corrigible en deux
// clics, qu'un barème arbitraire qui ferait calculer de fausses rémunérations sans que
// personne ne s'en aperçoive.
const REMUNERATION_NEUTRE: ReglesRemuneration = {
  baremeStandard: [],
  baremeReduit: [],
  libelleBaremeReduit: 'Barème réduit',
  objectifCaMensuel: 0,
  primeObjectifCa: 0,
  objectifMargeMensuel: 0,
  primeObjectifMarge: 0,
  primeSuiviAdministratif: 0,
};

// Une tranche stockée avec `plafond: null` est la tranche non plafonnée : JSON ne sait pas
// représenter Infinity, on le rétablit à la lecture. Les tranches sont triées par plafond
// croissant, le calcul progressif en dépendant.
function parseBareme(valeur: unknown): TrancheBareme[] {
  if (!Array.isArray(valeur)) return [];
  return valeur
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      plafond: t.plafond === null || t.plafond === undefined ? Infinity : Number(t.plafond),
      taux: Number(t.taux),
    }))
    .filter((t) => Number.isFinite(t.taux) && t.taux >= 0 && (t.plafond === Infinity || Number.isFinite(t.plafond)))
    .sort((a, b) => a.plafond - b.plafond);
}

async function getReglesRemuneration(): Promise<ReglesRemuneration> {
  const p = await prisma.parametresRemuneration.findUnique({ where: { id: 'singleton' } });
  if (!p) return REMUNERATION_NEUTRE;
  const n = decimalToNumber(p);
  return {
    baremeStandard: parseBareme(p.baremeStandard),
    baremeReduit: parseBareme(p.baremeReduit),
    libelleBaremeReduit: p.libelleBaremeReduit,
    objectifCaMensuel: n.objectifCaMensuel,
    primeObjectifCa: n.primeObjectifCa,
    objectifMargeMensuel: n.objectifMargeMensuel,
    primeObjectifMarge: n.primeObjectifMarge,
    primeSuiviAdministratif: n.primeSuiviAdministratif,
  };
}

// Sérialisation inverse, pour l'écriture : Infinity redevient null.
function serialiseBareme(bareme: TrancheBareme[]) {
  return bareme.map((t) => ({ plafond: t.plafond === Infinity ? null : t.plafond, taux: t.taux }));
}

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
async function computeCommissionsParCommercial(commercialIds: string[], start: Date, endExclusive: Date, params: Parametres, regles: ReglesRemuneration) {
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
    const societe = await getCompanySettings();
    const { start, endExclusive } = periodBounds(period, req.query.ref, societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
    const params = await getParametres();
    const regles = await getReglesRemuneration();

    const users = await prisma.user.findMany({
      where: isAdmin ? { OR: COMMERCIAL_OR_FILTER } : { id: authUser.id, role: 'COMMERCIAL' },
      select: { id: true, name: true, email: true },
    });

    const commercialIds = users.map((u) => u.id);
    const { byCommercial, chantiers, buckets, commissionsParMoisGroupe, moisPeriode, suiviAdminSet } =
      await computeCommissionsParCommercial(commercialIds, start, endExclusive, params, regles);

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
      bareme: { standard: serialiseBareme(regles.baremeStandard), reduit: serialiseBareme(regles.baremeReduit) },
      libelleBaremeReduit: regles.libelleBaremeReduit,
      objectifs: { ca: regles.objectifCaMensuel, marge: regles.objectifMargeMensuel, primeCA: regles.primeObjectifCa, primeMarge: regles.primeObjectifMarge, primeAdmin: regles.primeSuiviAdministratif },
      commerciaux: list,
    });
  } catch (error) {
    res.status(500).json({ error: 'Error computing commerciaux stats' });
  }
});

// Analyse IA désactivée jusqu'à la phase qui définira périmètre, minimisation des données,
// consentement et journal d'audit. Il est dangereux de transmettre coûts/marges à un tiers
// sans ces garanties. La route est conservée seulement pour renvoyer un statut explicite.
app.post('/api/chantiers/:id/analyze', requireAuth, (_req, res) => {
  res.status(410).json({ error: "L'analyse IA de chantier n'est pas encore disponible." });
});

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
    if (existing) {
      if (existing.role !== ROLE_SUPERADMIN) {
        await prisma.user.update({ where: { id: existing.id }, data: { role: ROLE_SUPERADMIN } });
        console.log(`Compte promu super administrateur : ${email}`);
      }
      continue;
    }
    await prisma.user.create({
      data: {
        email,
        name: nameFromEmail(email),
        role: ROLE_SUPERADMIN,
      },
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
  // Garantit l'existence de la ligne de paramètres (singleton) dès le démarrage.
  await prisma.parametres.upsert({ where: { id: 'singleton' }, update: {}, create: { id: 'singleton' } });

};

// Le serveur n'écoute que lorsque ce fichier est LANCÉ (node dist/index.js). Quand il est
// simplement importé — c'est le cas des tests d'intégration, qui montent l'application
// dans le processus de test — on expose `app` sans ouvrir de port : deux suites de tests
// peuvent alors tourner en parallèle sans se disputer le 3001, et aucun test n'oublie de
// fermer un serveur derrière lui.
if (require.main === module) {
  app.listen(port, async () => {
    await initDb();
    await ensureSuperAdmins();
    console.log(`Server running on port ${port}`);
  });
}

// Surface exportée pour les tests. `app` sert aux tests d'intégration HTTP ; les fonctions
// pures (validation des saisies, barème de commission, empreinte de clé API) sont testées
// directement, sans base de données ni requête.
export {
  app,
  initDb,
  ensureSuperAdmins,
  clientPayload,
  contactPayload,
  sitePayload,
  companySettingsPayload,
  fuseauHoraireEntrepriseValide,
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
  decimalToNumber,
  parseBareme,
  serialiseBareme,
  validerBareme,
  arrondiCommercialLigneHt,
  centimesTtcLigne,
  devisPayload,
  getReglesRemuneration,
};
