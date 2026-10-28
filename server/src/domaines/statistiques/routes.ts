import type { Express } from 'express';
import { prisma } from '../../db';
import { ROLE_RESPONSABLE, isAdminRole, COMMERCIAL_OR_FILTER } from '../../droits/roles';
import { AFFAIRE_NON_ANNULEE, perimetreChantiers } from '../../droits/perimetres';
import { voitMontantsChantier, voitCoutMainOeuvre } from '../../droits/visibilite';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { requireAdmin, requireTravauxRead } from '../../http/gardes';
import { FUSEAU_HORAIRE_PAR_DEFAUT, jourCivilEntreprise, ajouterJoursCivils } from '../../commun/dates';
import { decimalToNumber, sommeExacte, differenceExacte, produitExact } from '../../commun/montants';
import { getParametres } from '../parametres/metier';
import { getCompanySettings } from '../administration/metier';
import { TYPES_CHANTIER } from '../chantiers/metier';
import { voitRentabilite } from '../chantiers/droits';
import { jourCivilDeDebut, computeChantierMetrics } from '../chantiers/suivi';
import { avecCoutsSuites } from '../chantiers/coutsSuites';
import { computeCommissionsParCommercial } from '../commissions/metier';
import { weekBoundsFrom, periodBounds } from './metier';

const JOURS_OUVRES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];

export function enregistrerRoutesStatistiques(app: Express): void {
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
          if (d >= start && d < endExclusive) achatsTotal = sommeExacte(achatsTotal, a.montantHT);
        }
        for (const p of c.pointages) {
          const d = new Date(p.date);
          if (d >= start && d < endExclusive) heuresTotal = sommeExacte(heuresTotal, p.nbrHeures);
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

      if (!isCommercial && voitMontantsChantier(req)) {
        // ADMIN + CONDUCTEUR : total des achats de la période (peu importe le statut du
        // chantier — un achat facturé ce mois compte, chantier ouvert ou non). Jamais pour un
        // technicien, qui ne voit aucun coût.
        result.achatsTotal = achatsTotal;
      }
      if (!isAdmin && !isCommercial) {
        // CONDUCTEUR : heures totales enregistrées sur la période, tous ses chantiers.
        result.heuresTotal = heuresTotal;
      }

      if (params.margeCommercialeActive) {
        if (isAdmin) {
          // CA vendu / marge / commission commerciale de la période, tous commerciaux
          // confondus (chantiers Terminés ET Encaissés, rattachés au mois de leur clôture) :
          // ce sont des résultats FINALISÉS du mois, pas un cumul de portefeuille en cours.
          // Sans plan commercial, la commission est nulle.
          const commerciaux = await prisma.user.findMany({ where: { OR: COMMERCIAL_OR_FILTER }, select: { id: true } });
          const { byCommercial } = await computeCommissionsParCommercial(commerciaux.map((c) => c.id), start, endExclusive, params);
          let caTotal = 0, margeTotal = 0, commissionCommercialeTotal = 0;
          for (const agg of Object.values(byCommercial) as any[]) {
            caTotal = sommeExacte(caTotal, agg.caTotal);
            margeTotal = sommeExacte(margeTotal, agg.margeTotal);
            commissionCommercialeTotal = sommeExacte(commissionCommercialeTotal, agg.commissionTotal);
          }
          result.caTotal = caTotal;
          result.margeTotal = margeTotal;
          result.margePct = caTotal > 0 ? (margeTotal / caTotal) * 100 : 0;
          result.commissionCommercialeTotal = commissionCommercialeTotal;
          // Aucun commercial n'a de plan commercial : la carte du tableau de bord le dit.
          result.sansPlanCommercial = (Object.values(byCommercial) as any[]).every((agg) => agg.sansPlanCommercial);
        } else if (isCommercial) {
          const { byCommercial } = await computeCommissionsParCommercial([user.id], start, endExclusive, params);
          const mine = byCommercial[user.id];
          result.margeTotal = mine?.margeTotal ?? 0;
          result.commissionTotal = mine?.commissionTotal ?? 0;
          result.sansPlanCommercial = mine?.sansPlanCommercial ?? true;
        }
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Error computing global stats' });
    }
  });

  // Statistiques par conducteur de travaux (administration, et responsable sur sa branche —
  // CA et marge selon les destinataires de la rentabilité) : marge/CA, avance/retard
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
      const isAdmin = isAdminRole(authUser.role);
      if (!isAdmin && authUser.role !== ROLE_RESPONSABLE) return res.status(403).json({ error: 'Accès réservé à l’administration et aux responsables.' });
      const params = await getParametres();
      const users = await prisma.user.findMany({ where: { role: 'CONDUCTEUR_TRAVAUX', ...(authUser.role === ROLE_RESPONSABLE ? { id: { in: authUser.equipeIds } } : {}) }, select: { id: true, name: true, email: true } });
      const chantiers = await avecCoutsSuites(decimalToNumber(await prisma.chantier.findMany({
        where: perimetreChantiers(req),
        include: { achats: { where: { archivedAt: null } }, pointages: { where: { archivedAt: null } } },
      })) as any[]);

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
        agg.depensesTotal = sommeExacte(agg.depensesTotal, m.totalDepenses);
        // CA et marge : l'administration les voit toujours. Un responsable, comme sur la liste et
        // la fiche : le CA (le vendu) sur les chantiers dont la société le laisse destinataire (cf.
        // voitRentabilite), la marge en plus seulement si la marge commerciale est active.
        if (isAdmin || voitRentabilite(req, c, params)) {
          agg.caVisible = true;
          agg.caTotal = sommeExacte(agg.caTotal, c.budgetGlobalVendu);
          if (isAdmin || params.margeCommercialeActive) {
            agg.margeVisible = true;
            agg.margeTotal = sommeExacte(agg.margeTotal, m.margeCommerciale ?? differenceExacte(c.budgetGlobalVendu, m.totalDepenses));
          }
        }

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

          agg.heuresVenduesTermineTotal = sommeExacte(agg.heuresVenduesTermineTotal, c.heuresVendues);
          agg.heuresRealiseesTermineTotal = sommeExacte(agg.heuresRealiseesTermineTotal, m.heuresRealisees);
          // Manque à gagner = uniquement le coût des heures EN TROP par rapport au vendu,
          // valorisées au taux horaire moyen réellement appliqué sur ce chantier — pas la
          // différence avec le budget main d'œuvre vendu (qui peut s'écarter du taux horaire
          // pour d'autres raisons et fausserait le montant du dépassement lui-même). Les heures
          // des suites sont hors des heures réalisées : leur coût, resté dans le réel, sort aussi
          // du taux (décision de Nelson du 27-10-2026 à 21:41 UTC).
          const heuresDepassement = Math.max(0, differenceExacte(m.heuresRealisees, c.heuresVendues));
          const tauxHoraireMoyen = m.heuresRealisees > 0 ? differenceExacte(m.moReel, m.coutsSuites.coutMainOeuvre) / m.heuresRealisees : 0;
          agg.manqueAGagnerMainOeuvre = sommeExacte(agg.manqueAGagnerMainOeuvre, heuresDepassement * tauxHoraireMoyen);
        }
      }

      const list = Object.values(byUser)
        .filter((a: any) => a.nbChantiers > 0)
        .map(({ caVisible, margeVisible, ...a }: any) => ({
          ...a,
          // Dépenses (main-d'œuvre comprise) et manque à gagner (heures en trop au taux moyen) :
          // coût de main-d'œuvre, réservé à l'administration (cf. voitCoutMainOeuvre).
          depensesTotal: isAdmin ? a.depensesTotal : null,
          manqueAGagnerMainOeuvre: isAdmin ? a.manqueAGagnerMainOeuvre : null,
          caTotal: caVisible ? a.caTotal : null,
          margeTotal: margeVisible ? a.margeTotal : null,
          margePct: !margeVisible ? null : a.caTotal > 0 ? (a.margeTotal / a.caTotal) * 100 : 0,
          tauxObjectifsRespectes: a.nbChantiersTermines > 0 ? (a.nbObjectifsRespectes / a.nbChantiersTermines) * 100 : null,
          // % d'heures consommées au-delà du total vendu, sur les seuls chantiers TERMINES
          // (résultat définitif) — un chantier en cours en avance compenserait à tort un
          // chantier terminé en net dépassement si on les mélangeait.
          tauxDepassementHeures: a.heuresVenduesTermineTotal > 0
            ? (Math.max(0, differenceExacte(a.heuresRealiseesTermineTotal, a.heuresVenduesTermineTotal)) / a.heuresVenduesTermineTotal) * 100
            : null,
        }))
        .sort((x: any, y: any) => (y.margeTotal ?? -Infinity) - (x.margeTotal ?? -Infinity) || x.name.localeCompare(y.name));

      res.json(list);
    } catch (error) {
      res.status(500).json({ error: 'Error computing conducteurs stats' });
    }
  });

  // Assiduité : administration globale, responsable limité aux conducteurs de sa branche.
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
          agg.days[dayIndex].heuresSaisies = sommeExacte(agg.days[dayIndex].heuresSaisies, p.nbrHeures);
        }
        const heure = Number(new Intl.DateTimeFormat('en-GB', { timeZone: fuseauHoraire, hour: '2-digit', hourCycle: 'h23' })
          .formatToParts(created).find((partie) => partie.type === 'hour')?.value);
        agg.heuresParHeureJournee[heure] = (agg.heuresParHeureJournee[heure] || 0) + 1;
      }

      const conducteurs = users.map((u) => {
        const agg = byUser[u.id];
        const joursActifs = agg.days.filter((d) => d.nbSaisies > 0).length;
        const heuresTotalesSaisies = agg.days.reduce((s, d) => sommeExacte(s, d.heuresSaisies), 0);
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
  // Les heures sont celles du chantier, suites exclues ; le coût de main-d'œuvre garde celui
  // des suites, resté dans le réel (choix par défaut, à confirmer).
  // Alimente le camembert de l'onglet Statistiques > Chantiers.
  app.get('/api/stats/chantiers-repartition', requireAuth, requireAdmin, async (req, res) => {
    try {
      const params = await getParametres();
      const chantiers = await avecCoutsSuites(decimalToNumber(await prisma.chantier.findMany({
        where: { statut: 'TERMINE' },
        include: { achats: true, pointages: true },
      })) as any[]);

      let positif = 0, tempsSeul = 0, materielSeul = 0, lesDeux = 0;
      for (const c of chantiers) {
        const m = computeChantierMetrics(c, params, true);
        const tempsOk = m.diffHeures >= 0 && differenceExacte(c.budgetMainOeuvreVendu, m.moReel) >= 0;
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
        cur.heures = sommeExacte(cur.heures, p.nbrHeures);
        cur.cout = sommeExacte(cur.cout, produitExact(p.nbrHeures, p.tauxHoraireApplique));
        byIntervenant[p.intervenantId] = cur;
      }

      // Le coût d'un intervenant, rapporté à ses heures, redonnerait son taux : réservé à
      // l'administration (cf. voitCoutMainOeuvre).
      const coutVisible = voitCoutMainOeuvre(req);
      const list = intervenants
        .map((i) => ({ id: i.id, nom: i.nom, role: i.role, heures: byIntervenant[i.id]?.heures || 0, cout: coutVisible ? byIntervenant[i.id]?.cout || 0 : null }))
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
        cur.total = sommeExacte(cur.total, a.montantHT);
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
      const fuseauHoraire = societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
      const { start, endExclusive } = periodBounds(period, req.query.ref, fuseauHoraire);

      // Le début d'un chantier converti avant #130 est un instant, les autres une date-seule :
      // chacun compte au jour civil de la société (jourCivilDeDebut), d'où une marge d'un jour
      // de part et d'autre de la période, puis un tri sur ce jour civil.
      const debutCivil = start.toISOString().slice(0, 10);
      const finCivileExclue = endExclusive.toISOString().slice(0, 10);
      const chantiers = (await prisma.chantier.findMany({
        where: {
          dateDebut: { gte: new Date(start.getTime() - 86400000), lt: new Date(endExclusive.getTime() + 86400000) },
          ...perimetreChantiers(req),
        },
        select: { types: true, dateDebut: true },
      })).filter((c) => {
        const jour = jourCivilDeDebut(c.dateDebut, fuseauHoraire);
        return jour >= debutCivil && jour < finCivileExclue;
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
}
