import express from 'express';
import type { Express } from 'express';
import { prisma, transactionVerifiee } from '../../db';
import { isSuperAdminRole } from '../../droits/roles';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { requireAdmin, requireSuperAdmin } from '../../http/gardes';
import {
  FUSEAU_HORAIRE_PAR_DEFAUT, jourCivilEntreprise, aujourdHuiEntreprise, dateIsoStricte, ajouterJoursCivils, debutJourCivilEntreprise,
} from '../../commun/dates';
import { csvComptable } from '../../commun/csv';
import { changementsJournal, journaliserAdministration, purgerJournalAdministration, verrouillerReglage } from '../../commun/journal-administration';
import { getParametres } from '../parametres/metier';
import { getCompanySettings } from './metier';

// --- Journal des paramètres et des droits : consultation et export (administrateurs) ---
// Option retenue par Nelson (13-10-2026) : un onglet « Journal » dans Administration, filtrable par
// date, type et auteur, avec export CSV. Un simple administrateur ne reçoit ni les entrées qui
// concernent un compte super administrateur, ni l'historique des clés d'intégration.
const TYPES_JOURNAL_ADMINISTRATION = ['COMPTE', 'PARAMETRES', 'MODULES', 'REMUNERATION', 'PRIME_COMMERCIAL', 'SOCIETE', 'CLE_INTEGRATION', 'PARTAGE_PLANNING', 'CONSERVATION_JOURNAL', 'MAIN_OEUVRE', 'INTERVENANT'];

const AUTEUR_FILTRE_DEMARRAGE = 'DEMARRAGE';

const ENTREES_JOURNAL_PAR_PAGE = 50;

const ENTREES_JOURNAL_EXPORT_MAX = 10000;

function entreesVisiblesJournal(req: express.Request) {
  return isSuperAdminRole((req as AuthRequest).user?.role) ? {} : { concerneSuperAdmin: false, reserveSuperAdmin: false };
}

// Filtres : du / au (jours civils de la société, JJ-MM-AAAA ou AAAA-MM-JJ, bornes incluses),
// type, auteur (identifiant, ou DEMARRAGE pour les entrées sans auteur), cible (identifiant du compte,
// de la clé ou du commercial concerné).
async function filtreJournalAdministration(req: express.Request): Promise<{ where: Record<string, unknown>; fuseau: string } | { erreur: string }> {
  const fuseau = (await getCompanySettings()).fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
  const where: Record<string, unknown> = { ...entreesVisiblesJournal(req) };
  const { du, au, type, auteur, cible } = req.query;
  const periode: { gte?: Date; lt?: Date } = {};
  if (du !== undefined && du !== '') {
    const jour = dateIsoStricte(du);
    if (!jour) return { erreur: 'Date de début invalide (JJ-MM-AAAA).' };
    periode.gte = debutJourCivilEntreprise(jour.slice(0, 10), fuseau);
  }
  if (au !== undefined && au !== '') {
    const jour = dateIsoStricte(au);
    if (!jour) return { erreur: 'Date de fin invalide (JJ-MM-AAAA).' };
    periode.lt = debutJourCivilEntreprise(ajouterJoursCivils(jour.slice(0, 10), 1), fuseau);
  }
  if (periode.gte && periode.lt && periode.gte >= periode.lt) return { erreur: 'La date de fin doit être postérieure ou égale à la date de début.' };
  if (periode.gte || periode.lt) where.createdAt = periode;
  if (type !== undefined && type !== '') {
    if (typeof type !== 'string' || !TYPES_JOURNAL_ADMINISTRATION.includes(type)) return { erreur: 'Type d’entrée inconnu.' };
    where.type = type;
  }
  if (auteur !== undefined && auteur !== '') {
    if (typeof auteur !== 'string') return { erreur: 'Auteur invalide.' };
    where.auteurId = auteur === AUTEUR_FILTRE_DEMARRAGE ? null : auteur;
  }
  if (cible !== undefined && cible !== '') {
    if (typeof cible !== 'string') return { erreur: 'Cible invalide.' };
    where.cibleId = cible;
  }
  return { where, fuseau };
}

function entreeJournalPublique(entree: { id: string; createdAt: Date; domaine: string; type: string; action: string; cibleId: string | null; cibleLibelle: string | null; avant: unknown; apres: unknown; detail: string | null; auteurId: string | null; auteurNom: string }) {
  const { id, createdAt, domaine, type, action, cibleId, cibleLibelle, avant, apres, detail, auteurId, auteurNom } = entree;
  return { id, createdAt, domaine, type, action, cibleId, cibleLibelle, avant, apres, detail, auteurId, auteurNom };
}

// Valeurs avant / après d'une entrée, lisibles dans un tableur : « champ : valeur ; … ».
function valeursJournalCsv(valeurs: unknown): string {
  if (!valeurs || typeof valeurs !== 'object') return '';
  return Object.entries(valeurs as Record<string, unknown>)
    .map(([champ, valeur]) => `${champ} : ${typeof valeur === 'string' ? valeur : JSON.stringify(valeur)}`)
    .join(' ; ');
}

export function enregistrerRoutesJournalAdministration(app: Express): void {
  app.get('/api/journal-administration', requireAuth, requireAdmin, async (req, res) => {
    try {
      await purgerJournalAdministration();
      const filtre = await filtreJournalAdministration(req);
      if ('erreur' in filtre) return res.status(400).json({ error: filtre.erreur });
      const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
      const [total, entrees, auteurs, parametres] = await Promise.all([
        prisma.journalAdministration.count({ where: filtre.where }),
        prisma.journalAdministration.findMany({
          where: filtre.where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * ENTREES_JOURNAL_PAR_PAGE, take: ENTREES_JOURNAL_PAR_PAGE,
        }),
        // Auteurs proposés au filtre : ceux des seules entrées visibles par le demandeur.
        prisma.journalAdministration.findMany({
          where: entreesVisiblesJournal(req), distinct: ['auteurId', 'auteurNom'],
          select: { auteurId: true, auteurNom: true }, orderBy: { auteurNom: 'asc' },
        }),
        getParametres(),
      ]);
      res.json({
        entrees: entrees.map(entreeJournalPublique), total, page, parPage: ENTREES_JOURNAL_PAR_PAGE,
        auteurs: auteurs.map((a) => ({ id: a.auteurId ?? AUTEUR_FILTRE_DEMARRAGE, nom: a.auteurNom })),
        conservationJours: parametres.journalConservationJours,
      });
    } catch {
      res.status(500).json({ error: 'Lecture du journal impossible.' });
    }
  });

  app.get('/api/journal-administration/export.csv', requireAuth, requireAdmin, async (req, res) => {
    try {
      await purgerJournalAdministration();
      const filtre = await filtreJournalAdministration(req);
      if ('erreur' in filtre) return res.status(400).json({ error: filtre.erreur });
      const entrees = await prisma.journalAdministration.findMany({
        where: filtre.where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: ENTREES_JOURNAL_EXPORT_MAX,
      });
      const heure = new Intl.DateTimeFormat('fr-FR', { timeZone: filtre.fuseau, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
      const lignes = ['Date;Heure;Auteur;Domaine;Type;Action;Cible;Avant;Après;Détail'];
      for (const e of entrees) {
        lignes.push([
          jourCivilEntreprise(e.createdAt, filtre.fuseau).split('-').reverse().join('-'), heure.format(e.createdAt), e.auteurNom, e.domaine, e.type, e.action,
          e.cibleLibelle ?? '', valeursJournalCsv(e.avant), valeursJournalCsv(e.apres), e.detail ?? '',
        ].map(csvComptable).join(';'));
      }
      const jour = aujourdHuiEntreprise(filtre.fuseau).split('-').reverse().join('-');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="journal-parametres-droits-${jour}.csv"`);
      res.send(`\uFEFF${lignes.join('\n')}\n`);
    } catch {
      res.status(500).json({ error: 'Export du journal impossible.' });
    }
  });

  // Durée de conservation (1 à 90 jours) : réglée par un super administrateur, et journalisée.
  // La réduire efface aussitôt les entrées devenues plus anciennes que la nouvelle durée.
  app.put('/api/journal-administration/conservation', requireAuth, requireSuperAdmin, async (req, res) => {
    const brut = req.body?.jours;
    const jours = typeof brut === 'number' ? brut : typeof brut === 'string' && /^\d+$/.test(brut.trim()) ? Number(brut.trim()) : NaN;
    if (!Number.isInteger(jours) || jours < 1 || jours > 90) {
      return res.status(400).json({ error: 'La durée de conservation est un nombre entier de jours, de 1 à 90.' });
    }
    try {
      await transactionVerifiee(async (tx) => {
        await verrouillerReglage(tx, 'Parametres');
        const avant = await tx.parametres.findUnique({ where: { id: 'singleton' } });
        const apres = await tx.parametres.upsert({ where: { id: 'singleton' }, update: { journalConservationJours: jours }, create: { id: 'singleton', journalConservationJours: jours } });
        const changements = changementsJournal(avant, apres, ['journalConservationJours']);
        if (changements) await journaliserAdministration(tx, req as AuthRequest, { domaine: 'REGLAGES', type: 'CONSERVATION_JOURNAL', action: 'MODIFICATION', ...changements });
      });
      await purgerJournalAdministration();
      res.json({ conservationJours: jours });
    } catch {
      res.status(500).json({ error: 'Enregistrement de la durée de conservation impossible.' });
    }
  });
}
