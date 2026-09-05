import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { odooConfigured, odooSearchClients, odooSearchDevis, odooDevisMateriel, odooDevisAdresse, odooSuiviDevis, odooCommandesVendues, type OdooSuiviDevis } from './odoo';

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
// Un compte désactivé (départ de l'entreprise) n'est plus « autorisé » : il est traité
// exactement comme un email absent de la liste blanche. Ses données, elles, restent en base.
async function resolveAuthorizedSsoUser(email: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return prisma.user.findFirst({
    where: { email: normalized, actif: true },
    select: { id: true, name: true, email: true, role: true, theme: true, accesFinance: true },
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
  user?: { id: string; role: string; accesFinance: boolean };
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
    const user = await prisma.user.findUnique({ where: { id: payload.id }, select: { id: true, role: true, accesFinance: true, actif: true } });
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
    (req as AuthRequest).user = { id: user.id, role: user.role, accesFinance: user.accesFinance };
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
function perimetreChantiers(req: express.Request): Prisma.ChantierWhereInput {
  if ((req as ApiRequest).apiKey) return {};
  const user = (req as AuthRequest).user;
  if (!user || isAdminRole(user.role)) return {};
  if (user.role === 'COMMERCIAL') return { commercialId: user.id };
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

// Suivi financier : accordé au cas par cas, indépendamment du rôle (User.accesFinance,
// case « Finance » dans Administration > Utilisateurs). Un superadmin y accède toujours,
// sans avoir besoin de la case. Couvre la consultation comme la pose et le retrait des
// marques « Vu ».
function peutVoirFinance(user: { role: string; accesFinance?: boolean | null } | undefined): boolean {
  return !!user && (isSuperAdminRole(user.role) || !!user.accesFinance);
}

const requireFinance: express.RequestHandler = (req, res, next) => {
  if (!peutVoirFinance((req as AuthRequest).user)) {
    res.status(403).json({ error: 'Accès au suivi financier non autorisé' });
    return;
  }
  next();
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

// Numéro de devis : un S majuscule suivi d'exactement 5 chiffres (S00700), et un seul par
// chantier. C'est le format des devis de vente Odoo, et la clé de rapprochement du Suivi
// financier — un numéro mal formé ou partagé par deux chantiers rend le rapprochement
// impossible ou ambigu. La saisie est normalisée (espaces retirés, minuscule acceptée)
// avant contrôle, pour ne pas rejeter un « s00700 » collé depuis Odoo.
const FORMAT_NUMERO_DEVIS = /^S\d{5}$/;

function normaliserNumeroDevis(valeur: unknown): string {
  return String(valeur ?? '').trim().toUpperCase();
}

// Retourne un message d'erreur si le numéro est absent ou mal formé, sinon null.
function erreurNumeroDevis(numeroDevis: string): string | null {
  if (!numeroDevis) return 'Veuillez saisir le numéro de devis.';
  if (!FORMAT_NUMERO_DEVIS.test(numeroDevis)) {
    return 'Le numéro de devis doit être au format SXXXXX : un S suivi de 5 chiffres (exemple : S00700).';
  }
  return null;
}

// Vérifie qu'aucun AUTRE chantier ne porte déjà ce numéro. Le contrôle est volontairement
// applicatif et non porté par un index unique en base : des chantiers antérieurs portent
// une valeur libre (deux numéros dans le même champ, quand un chantier couvre deux devis
// du même client) et un index les rendrait immodifiables. La règle ne s'applique donc
// qu'aux numéros nouvellement saisis.
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

const COMPANY_TEXT_FIELDS = [
  'raisonSociale', 'nomCommercial', 'siret', 'tvaIntra', 'adresse', 'codePostal',
  'ville', 'pays', 'telephone', 'email', 'siteWeb', 'logoUrl', 'prefixeFacture', 'piedFacture',
] as const;
const COULEUR_HEX = /^#[0-9a-fA-F]{6}$/;

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
      select: { id: true, name: true, email: true, role: true, theme: true, accesFinance: true },
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
    res.json({ token: jeton, user, expiresIn: 3600 });
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
      select: { id: true, name: true, email: true, role: true, theme: true, accesFinance: true },
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
        achats: true,
        pointages: true,
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
        achats: { include: { categorie: true, fournisseur: true }, orderBy: { date: 'desc' } },
        pointages: { include: { intervenant: true }, orderBy: { date: 'desc' } },
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
  // Depuis Iris, l'ouverture d'une affaire est contractualisée par un devis accepté.
  // Cette route historique est conservée pour donner une erreur explicite aux anciens clients,
  // mais ne crée plus de chantier directement.
  if (process.env.ALLOW_LEGACY_DIRECT_CHANTIER !== 'true') {
    return res.status(410).json({ error: 'Un chantier est créé uniquement par conversion d’un devis accepté.' });
  }
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
      // Un compte désactivé n'apparaît plus dans les listes d'attribution : il ne peut pas
      // davantage être désigné responsable d'un nouveau chantier (son historique, lui, reste).
      const responsable = await prisma.user.findUnique({ where: { id: responsableId }, select: { id: true, actif: true } });
      if (!responsable || !responsable.actif) {
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
      if (!commercial || !isCommercialLike(commercial) || !commercial.actif) {
        return res.status(400).json({ error: 'Commercial introuvable.' });
      }
      commercialId = commercial.id;
    } else if ((await prisma.user.count({ where: { OR: COMMERCIAL_OR_FILTER } })) > 0) {
      return res.status(400).json({ error: 'Veuillez sélectionner le commercial rattaché à ce chantier.' });
    }

    const numeroDevis = normaliserNumeroDevis(req.body.numeroDevis);
    const erreurDevis = erreurNumeroDevis(numeroDevis);
    if (erreurDevis) {
      return res.status(400).json({ error: erreurDevis });
    }
    if (await numeroDevisDejaPris(numeroDevis)) {
      return res.status(409).json({ error: `Le devis ${numeroDevis} est déjà rattaché à un autre chantier.` });
    }

    // Le type de chantier n'est pas un champ texte : au moins une case doit être cochée
    // (baremeReduit est une case à part, non concernée par cette règle).
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
        baremeReduit: !!req.body.baremeReduit,
      },
    });
    res.json(chantier);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error creating chantier' });
  }
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
      select: { id: true, numeroDevis: true, responsableId: true },
    });
    if (!existant || (!isAdminRole(authUser.role) && existant.responsableId !== authUser.id)) {
      return res.status(404).json({ error: 'Chantier introuvable' });
    }

    // 'statut' n'est modifiable ici que par un admin : la clôture et surtout la RÉOUVERTURE
    // d'un chantier obéissent à des règles propres (cf. PATCH /api/chantiers/:id/statut, où
    // un conducteur peut clôturer mais jamais rouvrir). L'ouvrir ici les contournerait.
    const allowed = isAdminRole(authUser.role)
      ? ['nom', 'client', 'numeroDevis', 'statut', 'responsableId']
      : ['nom', 'client', 'numeroDevis', 'responsableId'];
    const numericFields = ['budgetGlobalVendu', 'budgetMaterielVendu', 'budgetMainOeuvreVendu', 'heuresVendues'];
    const dateFields = ['dateDebut', 'dateFin'];

    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key !== 'responsableId' && key !== 'numeroDevis' && key in req.body) data[key] = req.body[key];
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
      if (key in req.body && req.body[key]) data[key] = new Date(req.body[key]).toISOString();
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
// Supprime définitivement un chantier — réservé aux administrateurs et superadmins.
//
// Un chantier ne vit pas seul : achats, pointages d'heures, lignes de budget et
// affectations du planning y sont rattachés. Les supprimer en silence ferait disparaître
// des données de gestion sans que personne ne l'ait vu venir. La route procède donc en
// deux temps : sans `force`, elle REFUSE et renvoie le décompte de ce qui serait détruit,
// que l'écran affiche pour faire confirmer ; avec `force=1`, elle supprime tout dans une
// transaction.
//
// Un chantier vierge — créé par erreur, doublon de devis — n'a rien rattaché : il se
// supprime alors du premier coup, sans seconde confirmation.
app.delete('/api/chantiers/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = paramId(req);
    const chantier = await prisma.chantier.findUnique({ where: { id }, select: { id: true, nom: true } });
    if (!chantier) {
      return res.status(404).json({ error: 'Chantier introuvable.' });
    }

    const [achats, pointages, lignesBudget, affectations] = await Promise.all([
      prisma.achatReel.count({ where: { chantierId: id } }),
      prisma.pointageHeure.count({ where: { chantierId: id } }),
      prisma.ligneBudgetPrevisionnel.count({ where: { chantierId: id } }),
      prisma.planningEvent.count({ where: { chantierId: id } }),
    ]);
    const dependances = { achats, pointages, lignesBudget, affectations };
    const total = achats + pointages + lignesBudget + affectations;

    if (total > 0 && String(req.query.force || '') !== '1') {
      return res.status(409).json({
        code: 'CHANTIER_NON_VIDE',
        error: 'Ce chantier porte encore des données rattachées.',
        dependances,
      });
    }

    // Ordre imposé par les clés étrangères : tout ce qui pointe vers le chantier d'abord.
    // Les affectations du planning ne sont pas supprimées mais DÉTACHÉES : une intervention
    // planifiée reste un fait du planning (des techniciens y étaient affectés), elle devient
    // simplement une intervention hors chantier suivi, qui garde le nom du chantier.
    await prisma.$transaction([
      prisma.planningEvent.updateMany({
        where: { chantierId: id },
        data: { chantierId: null, categorie: 'HORS_CHANTIER', titre: chantier.nom },
      }),
      prisma.achatReel.deleteMany({ where: { chantierId: id } }),
      prisma.pointageHeure.deleteMany({ where: { chantierId: id } }),
      prisma.ligneBudgetPrevisionnel.deleteMany({ where: { chantierId: id } }),
      prisma.chantier.delete({ where: { id } }),
    ]);

    res.json({ success: true, nom: chantier.nom, dependances });
  } catch (error) {
    console.error('Suppression chantier:', error);
    res.status(500).json({ error: 'Impossible de supprimer ce chantier.' });
  }
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
      select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, actif: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users.map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, estCommercial: u.estCommercial,
      accesFinance: u.accesFinance, actif: u.actif,
    })));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching users' });
  }
});

// Autorise un nouveau compte à se connecter (liste blanche SSO / création de compte).
// Aucun mot de passe n'est défini : le compte se connecte exclusivement via Microsoft Entra ID.
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
      select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, actif: true },
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
      select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, actif: true }
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
      select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, actif: true },
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Error updating estCommercial' });
  }
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
      select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, actif: true },
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
      select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, actif: true },
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
      where: { chantier: perimetreChantiers(req) },
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
// Journal des heures : même correction et même raison que le journal des achats.
const listerHeures: express.RequestHandler = async (req, res) => {
  try {
    res.json(decimalToNumber(await prisma.pointageHeure.findMany({
      where: { chantier: perimetreChantiers(req) },
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

// --- Suivi financier (réservé au superadmin) ---
// Rapproche les chantiers de l'application avec leur devis de vente Odoo (numeroDevis,
// ex. S00700) pour répondre à une question que l'application ne sait pas trancher seule :
// ce chantier a-t-il été payé, et où en est-on ? Les montants viennent d'Odoo (factures et
// paiements) ; l'état d'avancement (En cours / Terminé) vient de l'application. Un
// chantier terminé dont il reste à encaisser mérite une relance, un chantier en cours avec
// un solde ouvert est normal : c'est ce croisement qui donne sa valeur à l'écran.
//
// Lecture seule de bout en bout : rien n'est jamais écrit dans Odoo.

const STATUTS_SUIVI = ['EN_COURS', 'TERMINE', 'TOUS'];

// Le bouton « Actualiser » de l'écran passe refresh=1 : c'est le seul moyen de contourner
// le cache Odoo (cf. odoo.ts), qui évite de réinterroger à chaque affichage des centaines
// de dossiers clos qui ne bougent plus.
function rafraichir(req: express.Request): boolean {
  return String(req.query.refresh || '') === '1';
}

// Plafond de commandes Odoo remontées par l'écran « Anciens chantiers ». Le parc compte
// environ 800 affaires ; la marge laissée absorbe la croissance sans jamais laisser une
// base inattendue produire une réponse démesurée.
const LIMITE_COMMANDES_ODOO = Number(process.env.ODOO_LIMITE_COMMANDES || 1500);

// Un chantier est « soldé » dès que le restant dû tombe sous le centime : comparer des
// montants à l'égalité stricte laisserait des chantiers payés affichés comme partiels à
// cause d'un arrondi de TVA.
const EPSILON_EUROS = 0.01;

type EtatReglement = 'TROP_PERCU' | 'SOLDE' | 'PARTIEL' | 'AUCUN';

function etatReglement(montantTTC: number, montantPaye: number): EtatReglement {
  // Encaissé au-delà du montant vendu : ce n'est pas un dossier réglé de plus, c'est une
  // anomalie à regarder (versement lettré sur la mauvaise commande, avoir jamais émis,
  // acompte encaissé puis facture annulée). Elle mérite son propre état, pas d'être
  // confondue avec un « soldé » tranquille.
  if (montantPaye > montantTTC + EPSILON_EUROS) return 'TROP_PERCU';
  if (montantTTC > 0 && montantPaye >= montantTTC - EPSILON_EUROS) return 'SOLDE';
  return montantPaye > EPSILON_EUROS ? 'PARTIEL' : 'AUCUN';
}

// Indicateurs financiers d'un devis, communs aux chantiers suivis et aux dossiers anciens.
//
// L'encaissé retenu est le PLUS ÉLEVÉ de deux lectures de la même réalité :
//   - l'encaissé comptable, déduit des factures (facturé - restant dû) ;
//   - la somme des versements rapprochés de la commande.
// En temps normal les deux coïncident. Ils divergent quand les factures d'une affaire ont
// été annulées sans être réémises : le compte client retombe à zéro alors que la banque,
// elle, a bien reçu l'argent — la progression tombait alors à 0 % sur des dossiers
// intégralement payés. Retenir le maximum fait primer l'argent réellement entré, ce qui
// est la question posée par cet écran ; `baseProgression` dit laquelle des deux lectures
// a servi, pour que l'écart soit expliqué et non subi.
function indicateursSuivi(suivi: OdooSuiviDevis) {
  // « Dernier versement » = dernier encaissement REÇU : un remboursement au client
  // (montant négatif) figure bien dans le détail, mais l'annoncer ici comme le dernier
  // versement donnerait une lecture fausse de l'avancement du règlement.
  const dernier = suivi.paiements.find((p) => p.montant > 0) || null;
  const encaisseComptable = suivi.montantPaye;
  const montantVersements = suivi.paiements.reduce((total, p) => total + p.montant, 0);
  const montantPaye = Math.max(encaisseComptable, montantVersements);
  const baseProgression = montantPaye > encaisseComptable + EPSILON_EUROS ? 'VERSEMENTS' : 'FACTURES';

  return {
    clientOdoo: suivi.clientNom,
    dateCommande: suivi.dateCommande,
    etatOdoo: suivi.etatOdoo,
    montantTTC: suivi.montantTTC,
    montantHT: suivi.montantHT,
    montantFacture: suivi.montantFacture,
    montantPaye,
    // Les deux lectures sont exposées telles quelles : la fiche les affiche côte à côte
    // dès qu'elles divergent, plutôt que de laisser croire à une erreur de calcul.
    encaisseComptable,
    montantVersements,
    baseProgression,
    montantEnAttenteRapprochement: suivi.montantEnAttenteRapprochement,
    // Négatif = trop-perçu : l'encaissé dépasse le montant vendu.
    montantRestant: suivi.montantTTC - montantPaye,
    pourcentagePaye: suivi.montantTTC > 0 ? (montantPaye / suivi.montantTTC) * 100 : 0,
    etatReglement: etatReglement(suivi.montantTTC, montantPaye),
    dernierPaiement: dernier ? { date: dernier.date, montant: dernier.montant, reference: dernier.reference } : null,
    nbPaiements: suivi.paiements.length,
  };
}

// Marques « Vu » posées sur des devis, indexées par numéro (cf. modèle AcquittementDevis).
async function acquittementsParNumero(numeros: string[]) {
  const lignes = await prisma.acquittementDevis.findMany({
    where: { numeroDevis: { in: numeros } },
    include: { acquittePar: { select: { name: true } } },
  });
  return new Map(lignes.map((a) => [a.numeroDevis, {
    le: a.updatedAt,
    par: a.acquittePar?.name || null,
    motif: a.motif,
  }]));
}

// Vue « ligne » d'un chantier : ce qu'il faut pour la liste, sans le détail des factures
// et des paiements (réservé à la fiche, cf. GET /api/suivi-financier/:id).
function serializeSuiviChantier(
  chantier: { id: string; nom: string; client: string; numeroDevis: string | null; statut: string; dateFin: Date | null },
  suivi: OdooSuiviDevis | undefined,
) {
  const termine = chantier.statut === 'TERMINE';
  const base = {
    id: chantier.id,
    nom: chantier.nom,
    client: chantier.client,
    numeroDevis: chantier.numeroDevis,
    statut: chantier.statut,
    termine,
    dateFin: chantier.dateFin,
  };
  if (!suivi) {
    // Devis introuvable côté Odoo (numéro erroné, commande supprimée...) : on l'affiche
    // quand même, signalé comme non rapproché, plutôt que de le faire disparaître de la liste.
    return {
      ...base, odooTrouve: false, clientOdoo: null, dateCommande: null, etatOdoo: '',
      montantTTC: 0, montantHT: 0, montantFacture: 0, montantPaye: 0, encaisseComptable: 0,
      montantEnAttenteRapprochement: 0, montantVersements: 0, baseProgression: 'FACTURES' as const,
      montantRestant: 0, pourcentagePaye: 0, etatReglement: 'AUCUN' as const,
      dernierPaiement: null, nbPaiements: 0,
    };
  }
  return { ...base, odooTrouve: true, ...indicateursSuivi(suivi) };
}

// Chantiers rapprochables : ceux qui portent un numéro de devis. Sans ce numéro, aucun
// rapprochement n'est possible — ils sont exclus, et leur nombre est renvoyé à part pour
// que l'écran puisse le signaler plutôt que de les passer sous silence.
const SUIVI_CHANTIER_SELECT = {
  id: true, nom: true, client: true, numeroDevis: true, statut: true, dateFin: true,
} as const;

app.get('/api/suivi-financier', requireAuth, requireFinance, async (req, res) => {
  try {
    const statut = STATUTS_SUIVI.includes(String(req.query.statut)) ? String(req.query.statut) : 'EN_COURS';
    const where = {
      ...(statut === 'TOUS' ? {} : { statut }),
      numeroDevis: { not: null },
      NOT: { numeroDevis: '' },
    };
    const [chantiers, sansDevis] = await Promise.all([
      prisma.chantier.findMany({ where, select: SUIVI_CHANTIER_SELECT, orderBy: { nom: 'asc' } }),
      prisma.chantier.count({
        where: {
          ...(statut === 'TOUS' ? {} : { statut }),
          OR: [{ numeroDevis: null }, { numeroDevis: '' }],
        },
      }),
    ]);

    if (!odooConfigured()) {
      return res.json({ odooAvailable: false, chantiers: [], sansDevis });
    }

    const numeros = chantiers.map((c) => (c.numeroDevis || '').trim()).filter(Boolean);
    const [suivi, acquittements] = await Promise.all([
      odooSuiviDevis(numeros, { force: rafraichir(req) }),
      acquittementsParNumero(numeros),
    ]);
    res.json({
      odooAvailable: true,
      sansDevis,
      chantiers: chantiers.map((c) => {
        const numero = (c.numeroDevis || '').trim();
        return { ...serializeSuiviChantier(c, suivi.get(numero)), acquitte: acquittements.get(numero) || null };
      }),
    });
  } catch (error) {
    console.error('Suivi financier error:', error);
    res.status(502).json({ error: "Impossible de récupérer les données financières depuis Odoo pour le moment." });
  }
});

// --- Anciens chantiers / dossiers non suivis ---
// Toutes les affaires VENDUES côté Odoo (state sale ou done) qui n'ont jamais eu de fiche
// chantier dans l'application : dossiers antérieurs à sa mise en service, petites
// interventions facturées directement, affaires suivies ailleurs. La comptabilité en garde
// la trace, l'application non — cet écran est là pour vérifier qu'aucune de ces affaires
// ne traîne un impayé oublié.
//
// Un solde ouvert n'est pas toujours une anomalie (retenue de garantie, geste commercial,
// écriture ancienne jamais lettrée). D'où la marque « Vu » : elle ne corrige rien, ne
// touche pas à Odoo, elle range simplement le dossier avec les affaires closes pour que la
// liste « à traiter » ne montre que ce qui mérite encore une action.

const FILTRES_ANCIENS = ['A_TRAITER', 'VUS', 'TOUS'];

app.get('/api/suivi-financier/anciens', requireAuth, requireFinance, async (req, res) => {
  try {
    const filtre = FILTRES_ANCIENS.includes(String(req.query.filtre)) ? String(req.query.filtre) : 'A_TRAITER';
    if (!odooConfigured()) {
      return res.json({ odooAvailable: false, commandes: [], total: 0, tronque: false });
    }

    const [commandes, chantiers] = await Promise.all([
      odooCommandesVendues(LIMITE_COMMANDES_ODOO, { force: rafraichir(req) }),
      prisma.chantier.findMany({ where: { NOT: { numeroDevis: null } }, select: { numeroDevis: true } }),
    ]);
    // Un devis déjà rattaché à une fiche chantier est traité par l'autre onglet : le faire
    // apparaître ici aussi ferait douter de quelle liste fait foi.
    const suivisDansApp = new Set(chantiers.map((c) => (c.numeroDevis || '').trim()).filter(Boolean));
    const nonSuivis = commandes.filter((c) => !suivisDansApp.has(c.numero));

    const acquittements = await acquittementsParNumero(nonSuivis.map((c) => c.numero));
    const lignes = nonSuivis.map((c) => {
      const indicateurs = indicateursSuivi(c);
      return {
        numeroDevis: c.numero,
        ...indicateurs,
        acquitte: acquittements.get(c.numero) || null,
        // « À traiter » = pas entièrement réglé ET pas encore marqué vu.
        aTraiter: indicateurs.etatReglement !== 'SOLDE' && !acquittements.has(c.numero),
      };
    });

    const filtrees = lignes.filter((l) => (filtre === 'A_TRAITER' ? l.aTraiter : filtre === 'VUS' ? !!l.acquitte : true));
    // Ce qui reste à encaisser passe devant, du plus gros solde au plus petit ; les
    // dossiers réglés ou acquittés suivent, du plus récent au plus ancien.
    filtrees.sort((a, b) => {
      if (a.aTraiter !== b.aTraiter) return a.aTraiter ? -1 : 1;
      if (a.aTraiter) return b.montantRestant - a.montantRestant;
      return (b.dateCommande || '').localeCompare(a.dateCommande || '');
    });

    res.json({
      odooAvailable: true,
      commandes: filtrees,
      total: lignes.length,
      aTraiter: lignes.filter((l) => l.aTraiter).length,
      vus: lignes.filter((l) => !!l.acquitte).length,
      // Signale une base plus grande que le plafond de lecture, plutôt que de laisser
      // croire à une liste exhaustive.
      tronque: commandes.length >= LIMITE_COMMANDES_ODOO,
    });
  } catch (error) {
    console.error('Suivi financier anciens error:', error);
    res.status(502).json({ error: "Impossible de récupérer les données financières depuis Odoo pour le moment." });
  }
});

// Fiche d'un chantier : les mêmes indicateurs, augmentés du détail des factures émises et
// de tous les versements qui s'y rattachent.
app.get('/api/suivi-financier/:id', requireAuth, requireFinance, async (req, res) => {
  try {
    const chantier = await prisma.chantier.findUnique({ where: { id: paramId(req) }, select: SUIVI_CHANTIER_SELECT });
    if (!chantier) {
      return res.status(404).json({ error: 'Chantier introuvable.' });
    }
    if (!chantier.numeroDevis) {
      return res.status(400).json({ error: "Ce chantier n'a pas de numéro de devis : aucun rapprochement Odoo n'est possible." });
    }
    if (!odooConfigured()) {
      return res.json({ odooAvailable: false });
    }
    const numero = chantier.numeroDevis.trim();
    const [suivi, acquittements] = await Promise.all([
      odooSuiviDevis([numero], { force: rafraichir(req) }),
      acquittementsParNumero([numero]),
    ]);
    const devis = suivi.get(numero);
    res.json({
      odooAvailable: true,
      ...serializeSuiviChantier(chantier, devis),
      acquitte: acquittements.get(numero) || null,
      factures: devis?.factures || [],
      paiements: devis?.paiements || [],
    });
  } catch (error) {
    console.error('Suivi financier detail error:', error);
    res.status(502).json({ error: "Impossible de récupérer les données financières depuis Odoo pour le moment." });
  }
});

// Fiche d'un devis non suivi : mêmes indicateurs, plus le détail des factures et des versements.
app.get('/api/suivi-financier/devis/:numero', requireAuth, requireFinance, async (req, res) => {
  try {
    const numero = String(Array.isArray(req.params.numero) ? req.params.numero[0] : req.params.numero).trim();
    if (!numero) return res.status(400).json({ error: 'Numéro de devis manquant.' });
    if (!odooConfigured()) return res.json({ odooAvailable: false });

    const [suivi, acquittements] = await Promise.all([
      odooSuiviDevis([numero], { force: rafraichir(req) }),
      acquittementsParNumero([numero]),
    ]);
    const devis = suivi.get(numero);
    if (!devis) return res.status(404).json({ error: "Ce devis est introuvable dans Odoo." });
    res.json({
      odooAvailable: true,
      numeroDevis: devis.numero,
      ...indicateursSuivi(devis),
      acquitte: acquittements.get(numero) || null,
      factures: devis.factures,
      paiements: devis.paiements,
    });
  } catch (error) {
    console.error('Suivi financier devis error:', error);
    res.status(502).json({ error: "Impossible de récupérer les données financières depuis Odoo pour le moment." });
  }
});

// --- Marque « Vu » sur un devis ---
// Purement applicative : elle n'écrit RIEN dans Odoo et ne modifie aucun montant. Elle dit
// seulement « ce solde ouvert est connu et assumé », ce qui sort le dossier de la liste à
// traiter. Réversible d'un clic, pour qu'une marque posée par erreur ne fige rien.
app.put('/api/suivi-financier/acquittements/:numero', requireAuth, requireFinance, async (req, res) => {
  try {
    const numero = String(Array.isArray(req.params.numero) ? req.params.numero[0] : req.params.numero).trim();
    if (!numero) return res.status(400).json({ error: 'Numéro de devis manquant.' });
    const motif = String(req.body?.motif ?? '').trim().slice(0, 500) || null;
    const acquitteParId = (req as AuthRequest).user!.id;
    const acquittement = await prisma.acquittementDevis.upsert({
      where: { numeroDevis: numero },
      update: { motif, acquitteParId },
      create: { numeroDevis: numero, motif, acquitteParId },
      include: { acquittePar: { select: { name: true } } },
    });
    res.json({ numeroDevis: numero, acquitte: { le: acquittement.updatedAt, par: acquittement.acquittePar?.name || null, motif: acquittement.motif } });
  } catch (error) {
    console.error('Acquittement error:', error);
    res.status(500).json({ error: "Impossible d'enregistrer la marque « Vu »." });
  }
});

app.delete('/api/suivi-financier/acquittements/:numero', requireAuth, requireFinance, async (req, res) => {
  try {
    const numero = String(Array.isArray(req.params.numero) ? req.params.numero[0] : req.params.numero).trim();
    await prisma.acquittementDevis.deleteMany({ where: { numeroDevis: numero } });
    res.json({ numeroDevis: numero, acquitte: null });
  } catch (error) {
    res.status(500).json({ error: "Impossible de retirer la marque « Vu »." });
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

routeMixte('get', '/clients', 'clients:read', listerClients);
routeMixte('post', '/clients', 'clients:write', creerClient);
routeMixte('get', '/clients/:id', 'clients:read', lireClient);
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
const centimes = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
function devisPayload(body: Record<string, unknown>) {
  const clientId = String(body.clientId || '').trim(), objet = String(body.objet || '').trim();
  const lignes = Array.isArray(body.lignes) ? body.lignes : [];
  if (!clientId || !objet || objet.length > 300 || !lignes.length) throw new DevisSaisieError('Client, objet et au moins une ligne sont requis.');
  const lignesCalculees = lignes.map((ligne, ordre) => {
    const item = ligne as Record<string, unknown>, designation = String(item.designation || '').trim(), nature = String(item.nature || 'MAIN_OEUVRE'), quantite = Number(item.quantite), prixUnitaireHt = Number(item.prixUnitaireHt), tauxTva = Number(item.tauxTva ?? 20);
    if (!['MAIN_OEUVRE', 'FOURNITURE'].includes(nature) || !designation || !Number.isFinite(quantite) || quantite <= 0 || !Number.isFinite(prixUnitaireHt) || prixUnitaireHt < 0 || !Number.isFinite(tauxTva) || tauxTva < 0) throw new DevisSaisieError('Ligne de devis invalide.');
    const totalHt = centimes(quantite * prixUnitaireHt), totalTtc = centimes(totalHt * (1 + tauxTva / 100));
    return { ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc };
  });
  const totalHt = centimes(lignesCalculees.reduce((t, l) => t + l.totalHt, 0)), totalTtc = centimes(lignesCalculees.reduce((t, l) => t + l.totalTtc, 0));
  return { clientId, objet, lignesCalculees, totalHt, totalTva: centimes(totalTtc - totalHt), totalTtc };
}
function devisErreur(res: express.Response, error: unknown) {
  if (error instanceof DevisSaisieError) return res.status(400).json({ error: error.message });
  if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Une révision concurrente vient d’être créée, réessayez.' });
  console.error('Devis:', error); return res.status(500).json({ error: 'Opération devis impossible.' });
}
const devisInclude = { lignes: { orderBy: { ordre: 'asc' as const } }, client: true, conversion: true };
async function nouveauNumeroDevis() {
  const annee = new Date().getFullYear();
  const [sequence] = await prisma.$queryRaw<{ dernierNumero: number }[]>(Prisma.sql`INSERT INTO "SequenceAffaire" ("annee", "dernierNumero") VALUES (${annee}, 1) ON CONFLICT ("annee") DO UPDATE SET "dernierNumero" = "SequenceAffaire"."dernierNumero" + 1 RETURNING "dernierNumero"`);
  return `A${String(annee).slice(-2)}-${String(sequence.dernierNumero).padStart(4, '0')}`;
}
const creerDevis: express.RequestHandler = async (req, res) => { try {
  const payload = devisPayload((req.body ?? {}) as Record<string, unknown>);
  if (!await prisma.client.findUnique({ where: { id: payload.clientId } })) throw new DevisSaisieError('Client introuvable.');
  const devis = await prisma.devis.create({ data: { dossierId: crypto.randomUUID(), numero: await nouveauNumeroDevis(), version: 1, clientId: payload.clientId, objet: payload.objet, totalHt: payload.totalHt, totalTva: payload.totalTva, totalTtc: payload.totalTtc, lignes: { create: payload.lignesCalculees } }, include: devisInclude });
  res.status(201).json(decimalToNumber(devis));
} catch (error) { devisErreur(res, error); } };
const listerDevis: express.RequestHandler = async (_req, res) => { try { res.json(decimalToNumber(await prisma.devis.findMany({ include: devisInclude, orderBy: { createdAt: 'desc' } }))); } catch (error) { devisErreur(res, error); } };
const creerRevision: express.RequestHandler = async (req, res) => { try {
  const precedent = await prisma.devis.findUnique({ where: { id: paramId(req) }, include: devisInclude });
  if (!precedent) throw new DevisSaisieError('Devis introuvable.');
  for (let tentative = 0; tentative < 3; tentative++) {
    const version = ((await prisma.devis.aggregate({ where: { dossierId: precedent.dossierId }, _max: { version: true } }))._max.version ?? 0) + 1;
    try { const devis = await prisma.devis.create({ data: { dossierId: precedent.dossierId, numero: precedent.numero, version, clientId: precedent.clientId, objet: precedent.objet, totalHt: precedent.totalHt, totalTva: precedent.totalTva, totalTtc: precedent.totalTtc, lignes: { create: precedent.lignes.map(({ ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc }) => ({ ordre, designation, nature, quantite, prixUnitaireHt, tauxTva, totalHt, totalTtc })) } }, include: devisInclude }); return void res.status(201).json(decimalToNumber(devis)); } catch (error) { if ((error as { code?: string })?.code !== 'P2002' || tentative === 2) throw error; }
  }
} catch (error) { devisErreur(res, error); } };
routeMixte('get', '/devis', 'devis:read', listerDevis);
routeMixte('post', '/devis', 'devis:write', creerDevis);
routeMixte('post', '/devis/:id/revisions', 'devis:write', creerRevision);
const TRANSITIONS_DEVIS: Record<string, string[]> = { BROUILLON: ['ENVOYE'], ENVOYE: ['ACCEPTE', 'REFUSE', 'BROUILLON'], ACCEPTE: [], REFUSE: [] };
const changerStatutDevis: express.RequestHandler = async (req, res) => { try {
  const statut = String((req.body ?? {}).statut || '');
  const devis = await prisma.devis.findUnique({ where: { id: paramId(req) } });
  if (!devis) return void res.status(404).json({ error: 'Devis introuvable.' });
  if (!TRANSITIONS_DEVIS[devis.statut]?.includes(statut)) throw new DevisSaisieError(`Transition ${devis.statut} → ${statut} interdite.`);
  const maj = await prisma.devis.update({ where: { id: devis.id }, data: { statut }, include: devisInclude });
  res.json(decimalToNumber(maj));
} catch (error) { devisErreur(res, error); } };
routeMixte('put', '/devis/:id/statut', 'devis:write', changerStatutDevis);

// Une conversion ne démarre qu'après acceptation. Phase 5 cible le chantier, déjà natif ;
// les cibles intervention, contrat et facture seront activées par leurs modules respectifs.
const convertirDevis: express.RequestHandler = async (req, res) => { try {
  const cible = String((req.body ?? {}).cible || '');
  if (cible !== 'CHANTIER') throw new DevisSaisieError('Cible de conversion non disponible.');
  const resultat = await prisma.$transaction(async tx => {
    const devis = await tx.devis.findUnique({ where: { id: paramId(req) }, include: { client: true, conversion: true, lignes: true } });
    if (!devis) throw new DevisSaisieError('Devis introuvable.');
    if (devis.statut !== 'ACCEPTE') throw new DevisSaisieError('Seul un devis accepté peut être converti.');
    if (devis.conversion) throw new DevisSaisieError('Ce devis a déjà été converti.');
    const budgetMaterielVendu = centimes(devis.lignes.filter(l => l.nature === 'FOURNITURE').reduce((total, l) => total + Number(l.totalHt), 0));
    const budgetMainOeuvreVendu = centimes(devis.totalHt.toNumber() - budgetMaterielVendu);
    const heuresVendues = devis.lignes.filter(l => l.nature === 'MAIN_OEUVRE').reduce((total, l) => total + Number(l.quantite), 0);
    const chantier = await tx.chantier.create({ data: { nom: devis.objet, client: devis.client.raisonSociale, numeroDevis: devis.numero, dateDebut: new Date(), budgetGlobalVendu: devis.totalHt, budgetMaterielVendu, budgetMainOeuvreVendu, heuresVendues } });
    await tx.devisConversion.create({ data: { devisId: devis.id, dossierId: devis.dossierId, cibleType: 'CHANTIER', cibleId: chantier.id } });
    return chantier;
  });
  res.status(201).json(decimalToNumber(resultat));
} catch (error) { devisErreur(res, error); } };
routeMixte('post', '/devis/:id/convertir', 'devis:write', convertirDevis);

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
    res.status(message.startsWith('Champ société invalide') || message.startsWith('Couleur invalide') ? 400 : 500)
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

// Total des achats par fournisseur (mois civil / année civile, navigable) — visible par
// les conducteurs ET les admins.
//
// Agrégat volontairement calculé sur TOUS les chantiers, contrairement au Journal des
// Achats désormais restreint au périmètre du demandeur : ce que la route renvoie est un
// cumul par fournisseur, sans montant vendu, sans marge et sans rattachement à un
// chantier — de l'information d'approvisionnement, utile à un conducteur pour situer ses
// volumes. Restreindre ce cumul changerait le sens de l'écran sans rien protéger de plus ;
// c'est un choix produit, pas un oubli du filtrage appliqué ailleurs.
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
    where: { commercialId: { in: commercialIds } },
    include: { achats: true, pointages: true },
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
    const { start, endExclusive } = periodBounds(period, req.query.ref);
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
  getReglesRemuneration,
};
