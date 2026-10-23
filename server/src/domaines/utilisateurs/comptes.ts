import express from 'express';
import type { Express } from 'express';
import { Prisma } from '@prisma/client';
import { prisma, transactionVerifiee } from '../../db';
import {
  ROLE_SUPERADMIN, ROLE_ASSISTANTE_COMMERCIALE, ROLE_TECHNICIEN, ROLE_COMPTABLE, ROLE_DIRECTEUR_COMMERCIAL,
  ROLE_RESPONSABLE, ROLE_DIRECTEUR, ROLE_SYSTEME, isAdminRole, isSuperAdminRole,
} from '../../droits/roles';
import { DROITS_INTERDITS_TECHNICIEN, permissionsEffectives } from '../../droits/permissions';
import { type AuthRequest, brancheHierarchique, requireAuth } from '../../http/auth';
import { requireAdmin, requireSuperAdmin } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { API_SCOPES } from '../../http/cles-api';
import { journaliserAdministration, changementsJournal } from '../../commun/journal-administration';
import { normalizeEmail } from '../authentification/sso';

// Autorise un nouveau compte à se connecter (liste blanche SSO / création de compte).
// Aucun mot de passe n'est défini : le compte se connecte exclusivement via Microsoft Entra ID.
const ALLOWED_ROLES = [ROLE_SUPERADMIN, 'ADMIN', 'CONDUCTEUR_TRAVAUX', 'COMMERCIAL', ROLE_ASSISTANTE_COMMERCIALE, ROLE_TECHNICIEN, ROLE_COMPTABLE, ROLE_DIRECTEUR_COMMERCIAL, ROLE_RESPONSABLE, ROLE_DIRECTEUR];

// Un compte SUPERADMIN n'est administrable QUE par un superadmin : le créer, lui changer
// de rôle, lui réattribuer un mot de passe ou le révoquer sont autant de moyens, pour un
// simple ADMIN, de s'emparer des droits de la direction. Renvoie un message d'erreur si
// l'opération doit être refusée, sinon null.
export function refuseSuperAdminTarget(req: express.Request, targetRole: string | null | undefined): string | null {
  if (!isSuperAdminRole(targetRole)) return null;
  if (isSuperAdminRole((req as AuthRequest).user?.role)) return null;
  return 'Seul un super administrateur peut gérer un compte super administrateur.';
}

// Le garde ci-dessus porte d'abord sur le compte lu avant la transaction, pour une réponse rapide.
// Chaque route d'écriture le refait sur le compte relu sous son verrou (#215) : une promotion
// validée entre-temps ne laisse pas un simple administrateur écrire sur un super administrateur.
function refuserCibleSuperAdminSousVerrou(req: express.Request, roleVerrouille: string | null | undefined): void {
  const refus = refuseSuperAdminTarget(req, roleVerrouille);
  if (refus) throw Object.assign(new Error(refus), { code: 'CIBLE_SUPERADMIN' });
}
const estRefusCibleSuperAdmin = (error: unknown): error is Error => (error as { code?: string })?.code === 'CIBLE_SUPERADMIN';

// Libellé figé d'un compte dans le journal des paramètres et des droits : il reste lisible après
// la suppression ou le renommage du compte.
export function libelleCompteJournal(compte: { name: string; email: string }): string {
  return `${compte.name} (${compte.email})`;
}

// Relit un compte en verrouillant sa ligne le temps de la transaction : l'« avant » journalisé est
// celui que la modification remplace, même face à une modification simultanée.
// Un compte qui quitte le type technicien perd sa fiche intervenant (lot pilote 3a, choix par
// défaut) : par ses affectations, elle lui ouvrirait les interventions de la fiche avec les
// écritures de son nouveau type (replanifier, annuler). La fiche, déjà verrouillée par l'appelant,
// est déliée et le changement journalisé dans la même transaction.
export async function delierFicheSiPlusTechnicien(tx: any, req: AuthRequest | null, avant: { id: string; name: string; email: string; role: string }, nouveauRole: string, fiches: Array<{ id: string; nom: string }>) {
  if (avant.role !== ROLE_TECHNICIEN || nouveauRole === ROLE_TECHNICIEN) return;
  // Une fiche encore libre au premier verrouillage a pu être reliée à ce compte avant qu'il ne soit
  // verrouillé à son tour : relue maintenant, elle n'est pas dans la liste verrouillée. Le changement
  // est alors refusé (409), plutôt que de laisser la fiche reliée à un compte non technicien. La
  // liaison de l'API prend le verrou des retraits, comme le changement de type : ce cas ne vient
  // donc que d'une promotion super administrateur (qui ne le prend pas), du démarrage, ou d'un
  // écrivain qui relierait une fiche sans ce verrou.
  const actuelles: Array<{ id: string }> = await tx.intervenant.findMany({ where: { userId: avant.id }, select: { id: true } });
  if (actuelles.some((f) => !fiches.some((v) => v.id === f.id))) throw Object.assign(new Error('Fiche intervenant reliée entre-temps.'), { code: 'FICHE_RELIEE' });
  for (const fiche of fiches) {
    await tx.intervenant.update({ where: { id: fiche.id }, data: { userId: null } });
    await journaliserAdministration(tx, req, {
      domaine: 'DROITS', type: 'COMPTE', action: 'FICHE_INTERVENANT', cibleId: avant.id, cibleLibelle: libelleCompteJournal(avant),
      concerneSuperAdmin: isSuperAdminRole(nouveauRole), avant: { ficheIntervenant: fiche.nom }, apres: { ficheIntervenant: null },
      detail: `Type de compte modifié ; fiche intervenant ${fiche.id}.`,
    });
  }
}

export async function lireCompteVerrouille(tx: any, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${id} FOR UPDATE`;
  return tx.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true } });
}

// Journalise un changement de droits d'un compte, s'il change quelque chose.
export async function journaliserDroitsCompte(tx: any, req: express.Request, action: string, avant: any, apres: any, champs: readonly string[]) {
  const changements = changementsJournal(avant, apres, champs);
  if (!changements) return;
  await journaliserAdministration(tx, req as AuthRequest, {
    domaine: 'DROITS', type: 'COMPTE', action, cibleId: apres.id, cibleLibelle: libelleCompteJournal(apres),
    concerneSuperAdmin: isSuperAdminRole(avant?.role) || isSuperAdminRole(apres.role), ...changements,
  });
}

// Garde-fou : les routes de comptes refusent de retirer le dernier super administrateur ACTIF
// (suppression, autre type, désactivation), sans quoi plus personne ne piloterait les modules ni ne
// rendrait la main à un autre : l'accès de secours en exige un actif, et le démarrage promeut sans
// réactiver. Ces retraits se sérialisent par un verrou consultatif, pris en tête de leur transaction
// avant tout verrou de ligne : qui l'attend ne tient rien, si bien que ce verrou ne peut entrer dans
// aucun interblocage, et l'ordre des verrous de ligne qui suivent reste celui d'avant. Le compte visé
// est ensuite relu sous son propre verrou, et les autres super administrateurs actifs sont comptés
// par une simple lecture. Leur transaction est explicitement en READ COMMITTED (ISOLATION_RETRAIT,
// comme toutes les transactions de comptes et de fiches qui relisent un compte sous verrou, pour un
// garde ou pour l'état journalisé), quel que soit le réglage de la base : chaque lecture y voit tout
// retrait validé avant elle, et aucun autre ne peut aboutir avant la fin de la transaction. En
// REPEATABLE READ, l'instantané pris avant l'attente du verrou ignorerait le retrait qui vient
// d'aboutir, et une écriture concurrente sur le compte ferait échouer la transaction (500). Une
// promotion validée pendant ce temps peut ne pas être vue : le refus n'en est que plus prudent.
export const ISOLATION_RETRAIT = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };
export const verrouillerRetraitsComptes = (tx: Prisma.TransactionClient) => tx.$queryRaw`SELECT pg_advisory_xact_lock(814091)::text AS verrou`;
async function estDernierSuperAdminActif(tx: Prisma.TransactionClient, compte: { id: string; role: string; actif: boolean }): Promise<boolean> {
  if (!isSuperAdminRole(compte.role) || !compte.actif) return false;
  return (await tx.user.count({ where: { role: ROLE_SUPERADMIN, actif: true, id: { not: compte.id } } })) === 0;
}

// Verrou refusé sans attente (FOR UPDATE NOWAIT) : code PostgreSQL 55P03, remonté par Prisma dans
// l'erreur d'une requête brute (P2010). Un lock_timeout donnerait le même code : il n'est donc
// reconnu qu'autour de la seule requête NOWAIT.
const estVerrouIndisponible = (error: unknown) => {
  const erreur = error as { code?: string; meta?: { code?: string } };
  return erreur?.code === 'P2010' && erreur.meta?.code === '55P03';
};

const erreurDernierSuperAdmin = () => Object.assign(new Error('Dernier super administrateur actif.'), { code: 'DERNIER_SUPERADMIN' });

// Le compte système (écritures automatiques) n'existe pas pour la gestion des comptes : chaque route
// d'un compte le lit comme un compte inexistant, après ses propres gardes et au même endroit, donc
// avec la même réponse (audit de #302). La base refuse aussi de le modifier ou de le supprimer.
const compteGere = (id: string) => ({ id, role: { not: ROLE_SYSTEME } });

export function enregistrerRoutesComptes(app: Express): void {
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
        where: { role: { notIn: isSuper ? [ROLE_SYSTEME] : [ROLE_SUPERADMIN, ROLE_SYSTEME] } },
        select: {
          id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true,
          responsableHierarchique: { select: { id: true, name: true, role: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
      res.json(users.map((u) => ({
        id: u.id, name: u.name, email: u.email, role: u.role, estCommercial: u.estCommercial,
        accesFinance: u.accesFinance, actif: u.actif,
        permissions: permissionsEffectives(u),
        permissionsIndividuelles: u.permissions,
        // Sans son rôle ; et un super administrateur, qui n'existe pas pour un simple
        // administrateur, n'apparaît pas non plus comme responsable. Il ne tire de toute façon
        // aucun périmètre d'un rattachement : le masquer ne retire d'accès à personne.
        responsableHierarchique: u.responsableHierarchique && (isSuper || !isSuperAdminRole(u.responsableHierarchique.role))
          ? { id: u.responsableHierarchique.id, name: u.responsableHierarchique.name }
          : null,
      })));
    } catch (error) {
      res.status(500).json({ error: 'Error fetching users' });
    }
  });

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
      if (accesFinance && role === ROLE_TECHNICIEN) {
        return res.status(400).json({ error: 'L’accès financier ne s’accorde pas à un compte technicien.' });
      }

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
      const user = await transactionVerifiee(async (tx) => {
        const cree = await tx.user.create({
          data: { email, name, role, estCommercial, accesFinance }, // pas de mot de passe : accès via SSO Microsoft
          select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true },
        });
        await journaliserAdministration(tx, req as AuthRequest, {
          domaine: 'DROITS', type: 'COMPTE', action: 'CREATION', cibleId: cree.id, cibleLibelle: libelleCompteJournal(cree),
          concerneSuperAdmin: isSuperAdminRole(cree.role),
          apres: { role: cree.role, estCommercial: cree.estCommercial, accesFinance: cree.accesFinance, permissions: cree.permissions, actif: cree.actif },
        });
        return cree;
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
      const target = await prisma.user.findFirst({ where: compteGere(id) });
      if (!target) {
        return res.status(404).json({ error: 'Utilisateur introuvable.' });
      }
      const refus = refuseSuperAdminTarget(req, target.role);
      if (refus) {
        return res.status(403).json({ error: refus });
      }
      // Les clés étrangères RESTRICT restent le verrou contre une course ; ce contrôle rend le refus
      // lisible à l’administrateur lorsqu’un compte porte une preuve de traçabilité métier.
      const [achatsCrees, achatsMisAJour, achatsArchives, pointagesCrees, pointagesMisAJour, pointagesArchives, journauxSaisie, journauxComptables, journauxRegles, coutsHeuresCrees, coutsAchatsCrees, coutsHeuresArchives, coutsAchatsArchives, reglements] = await Promise.all([
        prisma.achatReel.count({ where: { createdById: id } }),
        prisma.achatReel.count({ where: { updatedById: id } }),
        prisma.achatReel.count({ where: { archivedById: id } }),
        prisma.pointageHeure.count({ where: { createdById: id } }),
        prisma.pointageHeure.count({ where: { updatedById: id } }),
        prisma.pointageHeure.count({ where: { archivedById: id } }),
        prisma.journalSaisieChantier.count({ where: { auteurId: id } }),
        prisma.journalCompteComptable.count({ where: { auteurId: id } }),
        prisma.journalRegleComptable.count({ where: { auteurId: id } }),
        prisma.coutInterventionHeure.count({ where: { createdById: id } }),
        prisma.coutInterventionAchat.count({ where: { createdById: id } }),
        prisma.coutInterventionHeure.count({ where: { archivedById: id } }),
        prisma.coutInterventionAchat.count({ where: { archivedById: id } }),
        prisma.reglement.count({ where: { OR: [{ createdById: id }, { contrepasseParId: id }] } }),
      ]);
      if (achatsCrees + achatsMisAJour + achatsArchives + pointagesCrees + pointagesMisAJour + pointagesArchives + journauxSaisie + journauxComptables + journauxRegles + coutsHeuresCrees + coutsAchatsCrees + coutsHeuresArchives + coutsAchatsArchives + reglements > 0) {
        return res.status(409).json({ error: 'Ce compte est l’auteur de données tracées : le supprimer effacerait une preuve de traçabilité. Désactivez-le plutôt pour lui retirer l’accès.' });
      }
      await transactionVerifiee(async (tx) => {
        // État supprimé relu sous verrou, avec son responsable et ses collaborateurs : le journal
        // donne des noms (comme le rattachement), jamais l'identifiant d'un compte qu'un simple
        // administrateur ne doit pas voir, et chaque entrée qui touche un super administrateur
        // lui est fermée.
        // Fiches intervenant d'abord, dans le même ordre que la liaison : la suppression les délie
        // (ON DELETE SET NULL), et le journal le dit. Avant elles, le verrou des retraits.
        await verrouillerRetraitsComptes(tx);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Intervenant" WHERE "userId" = ${id} FOR UPDATE`);
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${id} FOR UPDATE`;
        // Relues une fois le compte verrouillé. La liaison de l'API attend le verrou des retraits, que
        // la suppression tient : elle ne relie aucune fiche pendant ce temps. Cette relecture reste la
        // garde contre tout écrivain qui relierait une fiche sans ce verrou : une fiche reliée
        // entre-temps est déliée par la suppression, et doit donc figurer au journal. Elles sont
        // verrouillées sans attendre (NOWAIT), car la cascade ON DELETE SET NULL les modifiera : une
        // fiche reliée entre-temps et tenue par une autre transaction (sa suppression, qui attend ce
        // compte, voire une simple écriture en cours) formerait un interblocage ou une attente
        // inutile (#219). La suppression est alors refusée, à réessayer, comme le changement de type
        // (FICHE_RELIEE). Les fiches verrouillées plus haut ne sont pas concernées : ce verrou est
        // déjà le nôtre.
        const fichesDeliees = await tx.$queryRaw<Array<{ id: string; nom: string }>>(Prisma.sql`SELECT "id", "nom" FROM "Intervenant" WHERE "userId" = ${id} FOR UPDATE NOWAIT`)
          .catch((error: unknown) => { throw estVerrouIndisponible(error) ? Object.assign(new Error('Fiche intervenant reliée entre-temps.'), { code: 'FICHE_RELIEE' }) : error; });
        const supprime = await tx.user.findUnique({
          where: { id },
          select: {
            id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true,
            responsableHierarchique: { select: { name: true, role: true } },
            collaborateurs: { select: { id: true, name: true, email: true, role: true } },
          },
        });
        if (!supprime) throw Object.assign(new Error('Utilisateur introuvable.'), { code: 'P2025' });
        refuserCibleSuperAdminSousVerrou(req, supprime.role);
        if (await estDernierSuperAdminActif(tx, supprime)) throw erreurDernierSuperAdmin();
        const chantiersResponsable = await tx.chantier.updateMany({ where: { responsableId: id }, data: { responsableId: null } });
        const chantiersCommercial = await tx.chantier.updateMany({ where: { commercialId: id }, data: { commercialId: null } });
        await tx.user.delete({ where: { id } });
        const effets = [
          chantiersResponsable.count ? `retiré de ${chantiersResponsable.count} chantier(s) comme responsable` : '',
          chantiersCommercial.count ? `retiré de ${chantiersCommercial.count} chantier(s) comme commercial` : '',
          ...fichesDeliees.map((fiche) => `fiche intervenant « ${fiche.nom} » (${fiche.id}) déliée`),
        ].filter(Boolean);
        const responsable = supprime.responsableHierarchique;
        await journaliserAdministration(tx, req as AuthRequest, {
          domaine: 'DROITS', type: 'COMPTE', action: 'SUPPRESSION', cibleId: supprime.id, cibleLibelle: libelleCompteJournal(supprime),
          concerneSuperAdmin: isSuperAdminRole(supprime.role) || isSuperAdminRole(responsable?.role),
          avant: { role: supprime.role, estCommercial: supprime.estCommercial, accesFinance: supprime.accesFinance, permissions: supprime.permissions, actif: supprime.actif, responsableHierarchique: responsable?.name ?? null },
          detail: effets.length ? effets.join(' ; ') : null,
        });
        // Les collaborateurs du compte supprimé perdent leur responsable (ON DELETE SET NULL) :
        // chacun le voit dans son propre historique.
        for (const collaborateur of supprime.collaborateurs) {
          await journaliserAdministration(tx, req as AuthRequest, {
            domaine: 'DROITS', type: 'COMPTE', action: 'RATTACHEMENT', cibleId: collaborateur.id, cibleLibelle: libelleCompteJournal(collaborateur),
            concerneSuperAdmin: isSuperAdminRole(collaborateur.role) || isSuperAdminRole(supprime.role),
            avant: { responsableHierarchique: supprime.name }, apres: { responsableHierarchique: null },
            detail: 'Responsable hiérarchique supprimé.',
          });
        }
      }, ISOLATION_RETRAIT);
      res.json({ success: true });
    } catch (error) {
      if (estRefusCibleSuperAdmin(error)) return res.status(403).json({ error: error.message });
      if ((error as { code?: string })?.code === 'DERNIER_SUPERADMIN') return res.status(409).json({ error: 'Impossible de révoquer le dernier compte super administrateur.' });
      if ((error as { code?: string })?.code === 'FICHE_RELIEE') return res.status(409).json({ error: 'Ce compte vient d’être relié à une fiche intervenant : réessayez.' });
      if ((error as { code?: string })?.code === 'P2003') return res.status(409).json({ error: 'Suppression impossible : ce compte vient d’être rattaché à des données métier.' });
      if ((error as { code?: string })?.code === 'P2025') return res.status(404).json({ error: 'Utilisateur introuvable.' });
      res.status(500).json({ error: 'Error deleting user' });
    }
  });

  app.patch('/api/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { role } = req.body;
      if (!ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({ error: 'Rôle invalide' });
      }
      const target = await prisma.user.findFirst({ where: compteGere(paramId(req)) });
      if (!target) {
        return res.status(404).json({ error: 'Utilisateur introuvable.' });
      }
      // Refus dans les DEUX sens : un ADMIN ne peut ni rétrograder un superadmin, ni
      // promouvoir qui que ce soit (lui compris) au rang de superadmin.
      const refus = refuseSuperAdminTarget(req, target.role) || refuseSuperAdminTarget(req, role);
      if (refus) {
        return res.status(403).json({ error: refus });
      }
      const user = await transactionVerifiee(async (tx) => {
        // Un autre type peut retirer un super administrateur : verrou des retraits en tête. Puis la
        // fiche intervenant, verrouillée avant le compte, dans le même ordre que la route qui la relie.
        if (!isSuperAdminRole(role)) await verrouillerRetraitsComptes(tx);
        const fiches = await tx.$queryRaw<Array<{ id: string; nom: string }>>(Prisma.sql`SELECT "id", "nom" FROM "Intervenant" WHERE "userId" = ${target.id} FOR UPDATE`);
        const avant = await lireCompteVerrouille(tx, target.id);
        if (!avant) throw Object.assign(new Error('Utilisateur introuvable.'), { code: 'P2025' });
        refuserCibleSuperAdminSousVerrou(req, avant.role);
        if (!isSuperAdminRole(role) && (await estDernierSuperAdminActif(tx, avant))) throw erreurDernierSuperAdmin();
        const apres = await tx.user.update({
        where: { id: target.id },
        // "estCommercial" n'a de sens que pour un ADMIN/SUPERADMIN : on le retire si le
        // compte quitte ces rôles, pour ne pas laisser un état orphelin qui réapparaîtrait
        // s'il y revenait plus tard sans qu'on l'ait explicitement redemandé.
        // accesFinance n'est PAS touché : il ne dépend pas du rôle, un conducteur comme un
        // commercial peut le conserver en changeant de fonction. Pour un technicien, il reste
        // enregistré mais sans effet (cf. DROITS_INTERDITS_TECHNICIEN, peutVoirFinance), comme ses
        // droits individuels : il retrouve son effet si le compte reprend un autre type.
        data: isAdminRole(role) ? { role } : { role, estCommercial: false },
        select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true }
        });
        await journaliserDroitsCompte(tx, req, 'TYPE_COMPTE', avant, apres, ['role', 'estCommercial']);
        await delierFicheSiPlusTechnicien(tx, req as AuthRequest, avant, apres.role, fiches);
        return apres;
      }, ISOLATION_RETRAIT);
      res.json(user);
    } catch (error) {
      if (estRefusCibleSuperAdmin(error)) return res.status(403).json({ error: error.message });
      if ((error as { code?: string })?.code === 'DERNIER_SUPERADMIN') return res.status(409).json({ error: 'Impossible de retirer le rôle du dernier compte super administrateur.' });
      if ((error as { code?: string })?.code === 'FICHE_RELIEE') return res.status(409).json({ error: 'Ce compte vient d’être relié à une fiche intervenant : réessayez.' });
      if ((error as { code?: string })?.code === 'P2025') return res.status(404).json({ error: 'Utilisateur introuvable.' });
      res.status(500).json({ error: 'Impossible de modifier le type de compte.' });
    }
  });

  // Rattachement hiérarchique d'un compte. C'est une décision d'accès : il ouvre au responsable
  // choisi, et à toute la chaîne au-dessus de lui, la lecture des chantiers de ce compte et,
  // si la société le laisse (Parametres.rentabiliteHierarchie), leur rentabilité. Réservé aux
  // administrateurs, il est contrôlé ici : ni soi-même, ni un compte désactivé, ni une boucle
  // (le responsable choisi relevant déjà de ce compte). Les rattachements sont sérialisés par
  // un verrou, pour que deux modifications simultanées ne puissent pas former une boucle.
  app.patch('/api/users/:id/responsable-hierarchique', requireAuth, requireAdmin, async (req, res) => {
    try {
      const demandeurSuper = isSuperAdminRole((req as AuthRequest).user?.role);
      const brut = req.body?.responsableHierarchiqueId;
      if (brut !== null && brut !== '' && typeof brut !== 'string') {
        return res.status(400).json({ error: 'Responsable hiérarchique invalide.' });
      }
      const responsableId = brut ? String(brut) : null;
      const resultat = await transactionVerifiee(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(814090)::text AS verrou`;
        // Puis le verrou des retraits : ni le compte ni l'un de ses responsables ne peut être supprimé,
        // désactivé ou rétrogradé pendant ce rattachement, et la cascade d'une suppression sur ses
        // collaborateurs n'attend jamais un compte que le rattachement tiendrait. Le compte, le
        // responsable choisi et l'ancien sont ensuite verrouillés par identifiant croissant (une
        // promotion attend ce verrou de ligne) : les types lus pour le garde et pour le journal sont
        // ceux du moment de l'écriture (#215). Plus aucun verrou n'est demandé ensuite.
        await verrouillerRetraitsComptes(tx);
        const actuel = await tx.user.findFirst({ where: compteGere(paramId(req)), select: { responsableHierarchiqueId: true } });
        if (!actuel) return { statut: 404, erreur: 'Utilisateur introuvable.' };
        const verrouilles = [...new Set([paramId(req), responsableId, actuel.responsableHierarchiqueId].filter((v): v is string => !!v))].sort();
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" IN (${Prisma.join(verrouilles)}) ORDER BY "id" FOR UPDATE`);
        const target = await tx.user.findFirst({
          where: compteGere(paramId(req)),
          select: { id: true, name: true, email: true, role: true, responsableHierarchique: { select: { id: true, name: true, role: true } } },
        });
        if (!target) return { statut: 404, erreur: 'Utilisateur introuvable.' };
        const refus = refuseSuperAdminTarget(req, target.role);
        if (refus) return { statut: 403, erreur: refus };
        let responsable: { name: string; role: string; actif: boolean } | null = null;
        if (responsableId) {
          if (responsableId === target.id) return { statut: 400, erreur: 'Un compte ne peut pas être son propre responsable hiérarchique.' };
          responsable = await tx.user.findUnique({ where: { id: responsableId }, select: { name: true, role: true, actif: true } });
          // Un super administrateur n'existe pas pour un simple administrateur : même réponse
          // qu'un compte absent.
          if (!responsable || !responsable.actif || (!demandeurSuper && isSuperAdminRole(responsable.role))) {
            return { statut: 400, erreur: 'Responsable hiérarchique introuvable ou désactivé.' };
          }
          if ((await brancheHierarchique(target.id, tx)).includes(responsableId)) {
            return { statut: 400, erreur: 'Rattachement refusé : le responsable choisi relève déjà de ce compte, cela formerait une boucle.' };
          }
        }
        const user = await tx.user.update({
          where: { id: target.id },
          data: { responsableHierarchiqueId: responsableId },
          select: { id: true, name: true, responsableHierarchique: { select: { id: true, name: true } } },
        });
        const ancien = target.responsableHierarchique;
        if ((ancien?.id ?? null) !== responsableId) {
          await journaliserAdministration(tx, req as AuthRequest, {
            domaine: 'DROITS', type: 'COMPTE', action: 'RATTACHEMENT', cibleId: target.id, cibleLibelle: libelleCompteJournal(target),
            concerneSuperAdmin: isSuperAdminRole(target.role) || isSuperAdminRole(ancien?.role) || (responsableId ? isSuperAdminRole(responsable?.role) : false),
            avant: { responsableHierarchique: ancien?.name ?? null }, apres: { responsableHierarchique: user.responsableHierarchique?.name ?? null },
          });
        }
        return { statut: 200, user };
      }, ISOLATION_RETRAIT);
      if (resultat.statut !== 200) return res.status(resultat.statut).json({ error: resultat.erreur });
      res.json(resultat.user);
    } catch (error) {
      res.status(500).json({ error: 'Impossible de modifier le responsable hiérarchique.' });
    }
  });

  // Bascule "estCommercial" sur un compte ADMIN : il apparaît alors, en plus de ses droits
  // d'administration intacts, comme un choix possible de commercial rattaché à un chantier
  // et dans les statistiques/marges de "Mes commerciaux" (cf. isCommercialLike). Réservé aux
  // ADMIN : un COMMERCIAL est déjà commercial, un conducteur n'a pas vocation à y apparaître.
  app.patch('/api/users/:id/est-commercial', requireAuth, requireAdmin, async (req, res) => {
    try {
      const target = await prisma.user.findFirst({ where: compteGere(paramId(req)) });
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
      const user = await transactionVerifiee(async (tx) => {
        const avant = await lireCompteVerrouille(tx, target.id);
        if (!avant) throw Object.assign(new Error('Utilisateur introuvable.'), { code: 'P2025' });
        refuserCibleSuperAdminSousVerrou(req, avant.role);
        // Même relecture pour le type : un compte qui a quitté l'administration entre-temps ne
        // reçoit pas un « aussi commercial » orphelin (le changement de type le retire).
        if (!isAdminRole(avant.role)) throw Object.assign(new Error('Seul un compte Administrateur peut être marqué "aussi commercial".'), { code: 'TYPE_CHANGE' });
        const apres = await tx.user.update({
          where: { id: target.id },
          data: { estCommercial: !!req.body.estCommercial },
          select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true },
        });
        await journaliserDroitsCompte(tx, req, 'AUSSI_COMMERCIAL', avant, apres, ['estCommercial']);
        return apres;
      }, ISOLATION_RETRAIT);
      res.json(user);
    } catch (error) {
      if (estRefusCibleSuperAdmin(error)) return res.status(403).json({ error: error.message });
      if ((error as { code?: string })?.code === 'TYPE_CHANGE') return res.status(400).json({ error: (error as Error).message });
      if ((error as { code?: string })?.code === 'P2025') return res.status(404).json({ error: 'Utilisateur introuvable.' });
      res.status(500).json({ error: 'Impossible de modifier la case Commercial.' });
    }
  });

  // Permissions individuelles : complètent le type de compte sans retirer ses droits par
  // défaut. Seul un superadministrateur peut les accorder ou les retirer.
  app.put('/api/users/:id/permissions', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
      const target = await prisma.user.findFirst({ where: compteGere(paramId(req)) });
      if (!target) return void res.status(404).json({ error: 'Utilisateur introuvable.' });
      const rawPermissions: unknown[] | null = Array.isArray(req.body?.permissions) ? req.body.permissions : null;
      const permissions: string[] | null = rawPermissions ? [...new Set(rawPermissions.map((permission) => String(permission)))] : null;
      if (!permissions || permissions.some((permission) => !(API_SCOPES as readonly string[]).includes(permission))) {
        return void res.status(400).json({ error: 'Liste de permissions invalide.' });
      }
      // Un technicien n'en reçoit aucun nouveau ; ceux enregistrés avant (règle, changement de
      // type) restent sans effet et peuvent être conservés ou retirés. L'accès financier, lui, ne
      // peut qu'être retiré : sa route refuse toute valeur vraie pour un technicien.
      const interdites = target.role === ROLE_TECHNICIEN
        ? permissions.filter((permission) => DROITS_INTERDITS_TECHNICIEN.includes(permission) && !target.permissions.includes(permission))
        : [];
      if (interdites.length) {
        return void res.status(400).json({ error: `Ces droits ne s’accordent pas à un compte technicien : ${interdites.join(', ')}.` });
      }
      // État « avant » relu sous verrou, en READ COMMITTED explicite : celui du moment (ISOLATION_RETRAIT).
      const user = await transactionVerifiee(async (tx) => {
        const avant = await lireCompteVerrouille(tx, target.id);
        const apres = await tx.user.update({ where: { id: target.id }, data: { permissions }, select: { id: true, name: true, email: true, role: true, permissions: true } });
        await journaliserDroitsCompte(tx, req, 'PERMISSIONS', avant, apres, ['permissions']);
        return apres;
      }, ISOLATION_RETRAIT);
      res.json(user);
    } catch { res.status(500).json({ error: 'Impossible de modifier les permissions individuelles.' }); }
  });

  // Bascule l'accès au Suivi financier d'un compte, quel que soit son rôle. RÉSERVÉ AU
  // SUPERADMIN : ces données (encaissements, impayés, montants clients) relèvent de la
  // direction, et un administrateur qui pourrait cocher la case se l'attribuerait à
  // lui-même. Un superadmin y accède de toute façon sans cette autorisation.
  app.patch('/api/users/:id/acces-finance', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
      const target = await prisma.user.findFirst({ where: compteGere(paramId(req)) });
      if (!target) {
        return res.status(404).json({ error: 'Utilisateur introuvable.' });
      }
      if (req.body.accesFinance && target.role === ROLE_TECHNICIEN) {
        return res.status(400).json({ error: 'L’accès financier ne s’accorde pas à un compte technicien.' });
      }
      // État « avant » relu sous verrou, en READ COMMITTED explicite : celui du moment (ISOLATION_RETRAIT).
      const user = await transactionVerifiee(async (tx) => {
        const avant = await lireCompteVerrouille(tx, target.id);
        const apres = await tx.user.update({
          where: { id: target.id },
          data: { accesFinance: !!req.body.accesFinance },
          select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true },
        });
        await journaliserDroitsCompte(tx, req, 'ACCES_FINANCE', avant, apres, ['accesFinance']);
        return apres;
      }, ISOLATION_RETRAIT);
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
      const target = await prisma.user.findFirst({ where: compteGere(paramId(req)) });
      if (!target) {
        return res.status(404).json({ error: 'Utilisateur introuvable.' });
      }
      const refus = refuseSuperAdminTarget(req, target.role);
      if (refus) {
        return res.status(403).json({ error: refus });
      }
      const actif = !!req.body.actif;
      // On ne se désactive pas soi-même (on se verrouillerait dehors), et on ne désactive pas
      // le dernier superadmin actif : plus personne ne piloterait les modules ni les comptes.
      if (!actif && target.id === authUser.id) {
        return res.status(400).json({ error: 'Vous ne pouvez pas désactiver votre propre compte.' });
      }
      const user = await transactionVerifiee(async (tx) => {
        if (!actif) await verrouillerRetraitsComptes(tx);
        const avant = await lireCompteVerrouille(tx, target.id);
        if (!avant) throw Object.assign(new Error('Utilisateur introuvable.'), { code: 'P2025' });
        refuserCibleSuperAdminSousVerrou(req, avant.role);
        if (!actif && (await estDernierSuperAdminActif(tx, avant))) throw erreurDernierSuperAdmin();
        const apres = await tx.user.update({
          where: { id: target.id },
          data: { actif },
          select: { id: true, name: true, email: true, role: true, estCommercial: true, accesFinance: true, permissions: true, actif: true },
        });
        await journaliserDroitsCompte(tx, req, actif ? 'ACTIVATION' : 'DESACTIVATION', avant, apres, ['actif']);
        return apres;
      }, ISOLATION_RETRAIT);
      res.json(user);
    } catch (error) {
      if (estRefusCibleSuperAdmin(error)) return res.status(403).json({ error: error.message });
      if ((error as { code?: string })?.code === 'DERNIER_SUPERADMIN') return res.status(400).json({ error: "Ce compte est le dernier super administrateur : il ne peut pas être désactivé." });
      if ((error as { code?: string })?.code === 'P2025') return res.status(404).json({ error: 'Utilisateur introuvable.' });
      res.status(500).json({ error: "Impossible de modifier l'activation du compte." });
    }
  });
}
