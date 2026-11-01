// Comptes des matrices de droits (lot D1a, cadrage version 3, §2.2).
//
// Les dix types de compte sont dans une TABLE : ajouter un onzième type (l'assistante technique, décision de Nelson
// du 24-10-2026) se fait par une seule ligne de TYPES_DE_COMPTE (N13). Les variantes qui changent un droit (CIBLE
// §7.1 et §4.2) sont dans VARIANTES. Création comme dans production-pdf.test.mjs : en base, puis jeton signé ; le
// super administrateur est ouvert par l'accès de secours (route POST /api/auth/secours).
//
// Rattachements hiérarchiques (cadrage §2.2 et jeu de données §7.1, « une branche de techniciens et une branche de
// conducteurs ») :
//   RESP ─┬─ TECH (technicien, fiche intervenant reliée)
//         └─ CT-BRANCHE (conducteur, donnée seulement, titulaire de chantier-ct-branche-resp)
//   CT-N1 ── CT (le conducteur N+1 n'est pas un responsable : sa « branche » ne lui ouvre rien, à prouver)
//   RESP-SANS-BRANCHE : aucun collaborateur.
import assert from 'node:assert/strict';

// Types de compte : clé de la référence, rôle en base, libellé.
export const TYPES_DE_COMPTE = [
  { cle: 'SA', role: 'SUPERADMIN', libelle: 'super administrateur (accès de secours)' },
  { cle: 'AD', role: 'ADMIN', libelle: 'administrateur' },
  { cle: 'DIR', role: 'DIRECTEUR', libelle: 'directeur' },
  { cle: 'RESP', role: 'RESPONSABLE', libelle: 'responsable, avec une branche (un technicien et un conducteur)' },
  { cle: 'CT', role: 'CONDUCTEUR_TRAVAUX', libelle: 'conducteur de travaux, rattaché à CT-N1' },
  { cle: 'COM', role: 'COMMERCIAL', libelle: 'commercial' },
  { cle: 'DC', role: 'DIRECTEUR_COMMERCIAL', libelle: 'directeur commercial' },
  { cle: 'AC', role: 'ASSISTANTE_COMMERCIALE', libelle: 'assistante commerciale' },
  { cle: 'CPT', role: 'COMPTABLE', libelle: 'comptable' },
  { cle: 'TECH', role: 'TECHNICIEN', libelle: 'technicien, fiche intervenant reliée, dans la branche de RESP' },
];

// Variantes d'un type qui changent un droit (cadrage §2.2) : `type` renvoie à la clé du type dont elle dérive.
export const VARIANTES = [
  { cle: 'AD-COM', type: 'AD', extra: { estCommercial: true }, libelle: 'administrateur « aussi commercial »' },
  { cle: 'RESP-SANS-BRANCHE', type: 'RESP', extra: {}, libelle: 'responsable sans branche' },
  { cle: 'CT-N1', type: 'CT', extra: {}, libelle: 'conducteur N+1 d’une branche de conducteurs (CT lui est rattaché)' },
  { cle: 'TECH-SANS-FICHE', type: 'TECH', extra: {}, libelle: 'technicien sans fiche intervenant reliée' },
  // Accès financier : « sans effet en session, à prouver » (cadrage §2.2, CIBLE §4.2 note 17). Porté par un
  // comptable, type le plus proche de la finance ; ses lignes doivent être celles de CPT.
  { cle: 'CPT-FINANCE', type: 'CPT', extra: { accesFinance: true }, libelle: 'comptable avec l’accès financier' },
];

// Comptes joués dans les matrices, dans l'ordre de la référence : chaque type, puis chaque variante.
export const COMPTES_JOUES = [...TYPES_DE_COMPTE.map((t) => t.cle), ...VARIANTES.map((v) => v.cle)];

// Refus à l'authentification (cadrage §2.2) : chacun joué sur chaque route de session, avec une seule cible (la
// garde requireAuth précède tout ; voir le fichier de tests).
export const REFUS_AUTHENTIFICATION = [
  { cle: 'ANONYME', libelle: 'sans session' },
  { cle: 'JETON-INVALIDE', libelle: 'jeton signé d’un autre secret' },
  { cle: 'DESACTIVE', libelle: 'compte désactivé (administrateur)' },
  { cle: 'SYSTEME', libelle: 'compte système (jeton signé à son identifiant)' },
  { cle: 'SUPPRIME', libelle: 'jeton d’un compte supprimé' },
];

// Compte système créé par la migration (server/src/droits/roles.ts, COMPTE_SYSTEME_ID).
export const COMPTE_SYSTEME_ID = '00000000-0000-4000-8000-000000000001';

const adresse = (cle) => `matrice.${cle.toLowerCase()}@iris.test`;
const nom = (cle) => `TEST Matrice ${cle}`;

// Crée les comptes en base (comme production-pdf.test.mjs : la création par l'API, POST /api/users, ne pose ni
// l'accès financier ni « aussi commercial » en une fois). `secours` : le compte super administrateur ouvert par
// l'accès de secours (déjà créé par ensureSuperAdmins) et son jeton de session ; `supprimerCompte` et
// `rattacherCompte` passent par l'API. Rend { comptes: { cle → { id, role, jeton } }, donnees, refus }.
export async function creerComptes({ prisma, signer, signerAutreSecret, secours, supprimerCompte, rattacherCompte }) {
  const comptes = {};
  const parType = Object.fromEntries(TYPES_DE_COMPTE.map((t) => [t.cle, t]));
  comptes.SA = { id: secours.id, role: 'SUPERADMIN', jeton: secours.jeton };
  const creer = async (cle, role, extra = {}) => {
    const compte = await prisma.user.create({ data: { email: adresse(cle), name: nom(cle), role, ...extra } });
    return { id: compte.id, role, jeton: signer(compte.id) };
  };
  for (const type of TYPES_DE_COMPTE) {
    if (type.cle === 'SA') continue;
    comptes[type.cle] = await creer(type.cle, type.role);
  }
  for (const variante of VARIANTES) comptes[variante.cle] = await creer(variante.cle, parType[variante.type].role, variante.extra);

  // Comptes de données, jamais joués : titulaire d'un chantier hors de tout périmètre, conducteur de la branche.
  const donnees = {
    CT_BRANCHE: await creer('CT-BRANCHE', 'CONDUCTEUR_TRAVAUX'),
    CT_TIERS: await creer('CT-TIERS', 'CONDUCTEUR_TRAVAUX'),
  };

  // Rattachements hiérarchiques, par l'API (PATCH /api/users/:id/responsable-hierarchique, session du super
  // administrateur) : cadrage §2.3, « construit par l'API quand une route existe ».
  await rattacherCompte(comptes.TECH.id, comptes.RESP.id);
  await rattacherCompte(donnees.CT_BRANCHE.id, comptes.RESP.id);
  await rattacherCompte(comptes.CT.id, comptes['CT-N1'].id);

  // Refus à l'authentification.
  const desactive = await creer('DESACTIVE', 'ADMIN', { actif: false });
  const supprime = await creer('SUPPRIME', 'ADMIN');
  await supprimerCompte(supprime.id);
  assert.equal(await prisma.user.count({ where: { id: supprime.id } }), 0, 'le compte supprimé n’existe plus');
  const systeme = await prisma.user.findUniqueOrThrow({ where: { id: COMPTE_SYSTEME_ID }, select: { id: true, role: true, actif: true } });
  assert.deepEqual({ role: systeme.role, actif: systeme.actif }, { role: 'SYSTEME', actif: false }, 'compte système créé par la migration');
  const refus = {
    ANONYME: { jeton: null },
    'JETON-INVALIDE': { jeton: signerAutreSecret(comptes.AD.id) },
    DESACTIVE: { jeton: desactive.jeton },
    SYSTEME: { jeton: signer(systeme.id) },
    SUPPRIME: { jeton: supprime.jeton },
  };
  assert.deepEqual(Object.keys(refus).sort(), REFUS_AUTHENTIFICATION.map((r) => r.cle).sort());
  return { comptes, donnees, refus };
}
