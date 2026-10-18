import type { Express } from 'express';
import { prisma } from '../../db';
import { isAdminRole, COMMERCIAL_OR_FILTER } from '../../droits/roles';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { FUSEAU_HORAIRE_PAR_DEFAUT } from '../../commun/dates';
import { getParametres, getReglesRemuneration } from '../parametres/metier';
import { getCompanySettings } from '../administration/metier';
import { computeChantierMetrics } from '../chantiers/suivi';
import { periodBounds } from '../statistiques/metier';
import { dateClotureChantier, computeCommissionsParCommercial } from './metier';

export function enregistrerRoutesCommissions(app: Express): void {
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
}
