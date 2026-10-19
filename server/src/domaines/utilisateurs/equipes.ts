import type { Express } from 'express';
import { Prisma } from '@prisma/client';
import { prisma, transactionVerifiee } from '../../db';
import { ROLE_TECHNICIEN, isSuperAdminRole, isCommercialLike, COMMERCIAL_OR_FILTER } from '../../droits/roles';
import { saisieSelonDroits } from '../../droits/visibilite';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { requireAdmin } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { decimalToNumber } from '../../commun/montants';
import { journaliserAdministration, changementsJournal } from '../../commun/journal-administration';
import { refuseSuperAdminTarget, libelleCompteJournal, lireCompteVerrouille, ISOLATION_RETRAIT, verrouillerRetraitsComptes } from './comptes';

export function enregistrerRoutesEquipes(app: Express): void {
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
      const intervenants = decimalToNumber(await prisma.intervenant.findMany());
      // Le taux horaire chargé de chacun n’est envoyé qu’à l’administration (et à une clé d’intégration).
      res.json(intervenants.map(saisieSelonDroits(req)));
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

  // Relier un compte à sa fiche intervenant (lot pilote 3) : c'est ce lien qui ouvre au technicien
  // les interventions auxquelles sa fiche est affectée, et sur lesquelles il saisit ses heures. Il
  // touche donc aux droits d'un compte : réservé à l'administration et journalisé dans la même
  // transaction. Seul un compte technicien actif, relié à aucune autre fiche, peut l'être (choix par
  // défaut, à confirmer) ; `userId: null` délie la fiche.
  app.put('/api/intervenants/:id/compte', requireAuth, requireAdmin, async (req, res) => {
    const id = paramId(req);
    const brut = (req.body ?? {}).userId;
    if (brut !== null && (typeof brut !== 'string' || !brut.trim())) return res.status(400).json({ error: 'Compte invalide.' });
    const userId = brut === null ? null : brut.trim();
    try {
      // READ COMMITTED explicite (#226) : les comptes relus sous verrou pour le garde sont ceux du
      // moment, quel que soit le réglage de la base (ISOLATION_RETRAIT).
      const resultat = await transactionVerifiee(async (tx) => {
        // Le verrou des retraits en tête, comme le rattachement : la liaison verrouille l'ancien
        // compte de la fiche, qui peut être le collaborateur d'un compte en cours de suppression, et
        // la cascade de cette suppression l'attendrait pendant que la liaison attend le compte
        // supprimé (interblocage). Qui attend ce verrou ne tient rien. La liaison se sérialise ainsi
        // avec la suppression d'un compte et son changement de type (hors promotion super
        // administrateur) : aucune fiche ne lui est reliée par cette route pendant ce temps.
        await verrouillerRetraitsComptes(tx);
        // Puis toujours dans le même ordre : la fiche, puis les comptes par identifiant croissant
        // (comme le changement de type d'un compte, qui verrouille sa fiche avant lui).
        const [fiche] = await tx.$queryRaw<Array<{ id: string; nom: string; userId: string | null }>>(Prisma.sql`SELECT "id", "nom", "userId" FROM "Intervenant" WHERE "id" = ${id} FOR UPDATE`);
        if (!fiche) return { statut: 404, erreur: 'Intervenant introuvable.' };
        if (fiche.userId === userId) return { statut: 200 };
        const ids = [...new Set([userId, fiche.userId].filter((v): v is string => !!v))].sort();
        const verrouilles = await tx.$queryRaw<Array<{ id: string; name: string; email: string; role: string; actif: boolean }>>(Prisma.sql`SELECT "id", "name", "email", "role", "actif" FROM "User" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`);
        const ancien = fiche.userId ? verrouilles.find((u) => u.id === fiche.userId) ?? null : null;
        // Comme toute route de droits : un simple administrateur ne touche pas au lien d'un compte
        // super administrateur (cf. refuseSuperAdminTarget).
        const refus = refuseSuperAdminTarget(req, ancien?.role);
        if (refus) return { statut: 403, erreur: refus };
        let compte: { id: string; name: string; email: string } | null = null;
        if (userId) {
          const cible = verrouilles.find((u) => u.id === userId);
          if (!cible || !cible.actif || cible.role !== ROLE_TECHNICIEN) return { statut: 400, erreur: 'Seul un compte technicien actif peut être relié à une fiche intervenant.' };
          const autre = await tx.intervenant.findFirst({ where: { userId, id: { not: id } }, select: { nom: true } });
          if (autre) return { statut: 409, erreur: `Ce compte est déjà relié à la fiche « ${autre.nom} ».` };
          compte = cible;
        }
        await tx.intervenant.update({ where: { id }, data: { userId } });
        // Une entrée par compte dont l'accès change : celui qui perd la fiche, celui qui la reçoit.
        if (ancien) {
          await journaliserAdministration(tx, req as AuthRequest, {
            domaine: 'DROITS', type: 'COMPTE', action: 'FICHE_INTERVENANT', cibleId: ancien.id, cibleLibelle: libelleCompteJournal(ancien),
            concerneSuperAdmin: isSuperAdminRole(ancien.role), avant: { ficheIntervenant: fiche.nom }, apres: { ficheIntervenant: null },
            detail: `Fiche intervenant ${fiche.id}.`,
          });
        }
        if (compte) {
          await journaliserAdministration(tx, req as AuthRequest, {
            domaine: 'DROITS', type: 'COMPTE', action: 'FICHE_INTERVENANT', cibleId: compte.id, cibleLibelle: libelleCompteJournal(compte),
            avant: { ficheIntervenant: null }, apres: { ficheIntervenant: fiche.nom }, detail: `Fiche intervenant ${fiche.id}.`,
          });
        }
        return { statut: 200 };
      }, ISOLATION_RETRAIT);
      if (resultat.statut !== 200) return res.status(resultat.statut).json({ error: resultat.erreur });
      res.json(decimalToNumber(await prisma.intervenant.findUnique({ where: { id } })));
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Ce compte vient d’être relié à une autre fiche.' });
      res.status(500).json({ error: 'Impossible de relier le compte à cette fiche.' });
    }
  });

  // Supprimer un intervenant. Bloqué s'il possède des pointages ou des coûts SAV (historique préservé) ou
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
      const couts = await prisma.coutInterventionHeure.count({ where: { intervenantId: id } });
      if (couts > 0) {
        return res.status(409).json({ error: `Suppression impossible : cet intervenant a ${couts} coût(s) d'heures SAV dans l'historique.` });
      }
      const affecte = await prisma.interventionAffectation.count({ where: { intervenantId: id } });
      if (affecte > 0) {
        return res.status(409).json({ error: `Suppression impossible : cet intervenant est affecté à ${affecte} intervention(s) SAV.` });
      }
      const affectationsSolo = await prisma.planningEvent.findMany({
        where: { intervenants: { some: { id }, every: { id } } },
        select: { id: true },
      });
      // READ COMMITTED explicite (#226), comme la liaison : le compte relu sous verrou est celui du moment.
      const resultat = await transactionVerifiee(async (tx) => {
        // Fiche, puis compte, verrouillés : le compte relu est bien celui que la suppression délie.
        const [verrou] = await tx.$queryRaw<Array<{ nom: string; userId: string | null }>>(Prisma.sql`SELECT "nom", "userId" FROM "Intervenant" WHERE "id" = ${id} FOR UPDATE`);
        if (!verrou) return { statut: 404, erreur: 'Intervenant introuvable.' };
        const compte = verrou.userId ? await lireCompteVerrouille(tx, verrou.userId) : null;
        const refus = refuseSuperAdminTarget(req, compte?.role);
        if (refus) return { statut: 403, erreur: refus };
        await tx.planningEvent.deleteMany({ where: { id: { in: affectationsSolo.map((e) => e.id) } } });
        await tx.intervenant.delete({ where: { id } });
        // Supprimer une fiche reliée délie aussi son compte : changement de droits, journalisé.
        if (compte) {
          await journaliserAdministration(tx, req as AuthRequest, {
            domaine: 'DROITS', type: 'COMPTE', action: 'FICHE_INTERVENANT', cibleId: compte.id, cibleLibelle: libelleCompteJournal(compte),
            concerneSuperAdmin: isSuperAdminRole(compte.role), avant: { ficheIntervenant: verrou.nom }, apres: { ficheIntervenant: null },
            detail: `Fiche intervenant supprimée (${id}).`,
          });
        }
        return { statut: 200 };
      }, ISOLATION_RETRAIT);
      if (resultat.statut !== 200) return res.status(resultat.statut).json({ error: resultat.erreur });
      res.json({ success: true });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2003') return res.status(409).json({ error: 'Suppression impossible : cet intervenant vient d’être rattaché à des données métier.' });
      if ((error as { code?: string })?.code === 'P2025') return res.status(404).json({ error: 'Intervenant introuvable.' });
      res.status(500).json({ error: 'Error deleting intervenant' });
    }
  });
}

export function enregistrerRoutesPrimeMensuelle(app: Express): void {
  // Suivi administratif (qualité et rigueur) d'un commercial, validé à la main par un
  // administrateur, mois par mois (periode "YYYY-MM"), et journalisé. Sans plan commercial,
  // il n'ouvre aucune prime (décision du 17-10-2026) et n'a plus de saisie à l'écran : la
  // route reste, sans montant (choix par défaut, à confirmer).
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
      const prime = await transactionVerifiee(async (tx) => {
        // Verrou sur le couple commercial + période, que la ligne existe déjà ou non : deux
        // enregistrements simultanés ne journalisent pas deux fois le même changement.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`prime-mensuelle:${commercial.id}:${periode}`}))::text AS verrou`;
        const avant = await tx.primeMensuelleCommercial.findUnique({ where: { commercialId_periode: { commercialId: commercial.id, periode } } });
        const apres = await tx.primeMensuelleCommercial.upsert({
          where: { commercialId_periode: { commercialId: commercial.id, periode } },
          update: { suiviAdministratif },
          create: { commercialId: commercial.id, periode, suiviAdministratif },
        });
        // Faute de ligne, la prime n'était pas accordée : l'avant vaut « non ».
        const changements = changementsJournal({ suiviAdministratif: avant?.suiviAdministratif ?? false }, apres, ['suiviAdministratif']);
        if (changements) {
          await journaliserAdministration(tx, req as AuthRequest, {
            domaine: 'REGLAGES', type: 'PRIME_COMMERCIAL', action: 'MODIFICATION', cibleId: commercial.id, cibleLibelle: commercial.name,
            detail: `Période ${periode.slice(5, 7)}-${periode.slice(0, 4)}`, concerneSuperAdmin: isSuperAdminRole(commercial.role), ...changements,
          });
        }
        return apres;
      });
      res.json(prime);
    } catch (error) {
      res.status(500).json({ error: 'Error updating prime mensuelle' });
    }
  });
}
