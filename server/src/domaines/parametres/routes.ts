import type { Express } from 'express';
import { transactionVerifiee } from '../../db';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { requireAdmin, requireSuperAdmin } from '../../http/gardes';
import { decimalToNumber } from '../../commun/montants';
import { nombreDecimalNonNegatif } from '../../commun/validation';
import { changementsJournal, journaliserAdministration, verrouillerReglage } from '../../commun/journal-administration';
import { getParametres, validerBareme, montantPositif, getReglesRemuneration, serialiseBareme } from './metier';
import { TempsPasseSaisieError, lireReglagePasTempsPasse, lireReglageTempsMinimum } from '../devis/tempsPasse';

export function enregistrerRoutesParametres(app: Express): void {
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
}

export function enregistrerRoutesRemunerationEtReglages(app: Express): void {
  // --- Règles de rémunération commerciale (singleton) ---
  // Lecture ouverte aux administrateurs, écriture réservée au superadmin. Ces règles
  // générales ne sont plus appliquées : sans plan commercial, aucune commission ni prime
  // (cf. computeCommissionsParCommercial). Seul leur libellé du barème réduit sert encore.
  app.get('/api/parametres/remuneration', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const regles = await getReglesRemuneration();
      res.json({ ...regles, baremeStandard: serialiseBareme(regles.baremeStandard), baremeReduit: serialiseBareme(regles.baremeReduit) });
    } catch {
      res.status(500).json({ error: 'Error fetching remuneration settings' });
    }
  });

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
      await transactionVerifiee(async (tx) => {
        await verrouillerReglage(tx, 'ParametresRemuneration');
        const avant = await tx.parametresRemuneration.findUnique({ where: { id: 'singleton' } });
        const apres = await tx.parametresRemuneration.upsert({
          where: { id: 'singleton' },
          update: data,
          create: { id: 'singleton', ...data },
        });
        const changements = changementsJournal(avant, apres, Object.keys(data));
        if (changements) await journaliserAdministration(tx, req as AuthRequest, { domaine: 'REGLAGES', type: 'REMUNERATION', action: 'MODIFICATION', ...changements });
      });
      console.warn(`[REMUNERATION] Règles modifiées par ${(req as AuthRequest).user!.id}`);
      const regles = await getReglesRemuneration();
      res.json({ ...regles, baremeStandard: serialiseBareme(regles.baremeStandard), baremeReduit: serialiseBareme(regles.baremeReduit) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Enregistrement impossible.';
      res.status(message.includes('Barème') || message.includes('montant') || message.includes('libellé') ? 400 : 500).json({ error: message });
    }
  });

  // N'écrit QUE les réglages de marge, d'acompte, d'alertes, d'anticipation des visites et du temps passé (pas, minimum) : l'activation des modules (planningActif) et le
  // mode d'envoi des documents (modeEnvoi) sont réservés au superadmin et passent par PUT /api/modules — un ADMIN ne doit pas pouvoir les
  // modifier, même en glissant le champ dans le corps de cette requête.
  app.put('/api/parametres', requireAuth, requireAdmin, async (req, res) => {
    try {
      // Comme les autres réglages, un champ absent garde sa valeur : un appel qui ne règle que
      // les destinataires ne doit pas désactiver la marge commerciale au passage.
      const data: Record<string, unknown> = {};
      if ('margeCommercialeActive' in req.body) {
        if (typeof req.body.margeCommercialeActive !== 'boolean') {
          return res.status(400).json({ error: 'L’activation de la marge commerciale se règle par oui ou non.' });
        }
        data.margeCommercialeActive = req.body.margeCommercialeActive;
      }
      // Politique d'acompte de la société : jamais en dur dans le code, éditable ici.
      // Ne s'applique qu'aux devis émis ensuite (cf. Devis.tauxAcompte, figé à l'émission).
      if ('tauxAcompteDefaut' in req.body) {
        const taux = nombreDecimalNonNegatif(req.body.tauxAcompteDefaut, 3, true);
        if (taux === null || taux > 100) {
          return res.status(400).json({ error: 'Le taux d’acompte par défaut doit être un pourcentage compris entre 0 et 100.' });
        }
        data.tauxAcompteDefaut = taux;
      }
      // Alertes de suivi des chantiers : une valeur vide (null ou chaîne vide) désactive le
      // délai sans saisie, ou retire le seuil de marge faible — une marge estimée négative reste
      // alors signalée. Toute autre valeur doit rester dans des bornes qui ont un sens métier.
      if ('seuilMargeFaible' in req.body) {
        const brut = req.body.seuilMargeFaible;
        if (brut === null || brut === '') data.seuilMargeFaible = null;
        else {
          const seuil = nombreDecimalNonNegatif(brut, 3, true);
          if (seuil === null || seuil > 100) {
            return res.status(400).json({ error: 'Le seuil de marge faible doit être un pourcentage compris entre 0 et 100, ou vide pour le retirer (une marge estimée négative reste signalée).' });
          }
          data.seuilMargeFaible = seuil;
        }
      }
      if ('joursSansSaisie' in req.body) {
        const brut = req.body.joursSansSaisie;
        if (brut === null || brut === '') data.joursSansSaisie = null;
        else {
          const jours = typeof brut === 'number' ? brut : typeof brut === 'string' && /^\d+$/.test(brut.trim()) ? Number(brut.trim()) : NaN;
          if (!Number.isInteger(jours) || jours < 1 || jours > 365) {
            return res.status(400).json({ error: 'Le délai sans saisie doit être un nombre entier de jours entre 1 et 365, ou vide pour désactiver l’alerte.' });
          }
          data.joursSansSaisie = jours;
        }
      }
      // Génération automatique des visites de maintenance (lot pilote 5) : anticipation en jours
      // civils, de 0 (le jour de l'échéance) à 365 ; vide, la génération automatique est désactivée.
      if ('anticipationVisitesJours' in req.body) {
        const brut = req.body.anticipationVisitesJours;
        if (brut === null || brut === '') data.anticipationVisitesJours = null;
        else {
          const jours = typeof brut === 'number' ? brut : typeof brut === 'string' && /^\d+$/.test(brut.trim()) ? Number(brut.trim()) : NaN;
          if (!Number.isInteger(jours) || jours < 0 || jours > 365) {
            return res.status(400).json({ error: 'L’anticipation des visites doit être un nombre entier de jours entre 0 et 365, ou vide pour désactiver la génération automatique.' });
          }
          data.anticipationVisitesJours = jours;
        }
      }
      // Pas du temps passé (lot « devis au temps passé ») : vide au démarrage, les devis au temps passé
      // étant refusés tant qu'il n'est pas fixé ; 15, 30, 45 ou 60 minutes depuis le lot « facture au
      // temps passé » (décision de la nuit du 26 au 27-10-2026, point 8) ; vide (null ou chaîne vide), il
      // est retiré. Temps minimum facturé (même lot, points 8 et 9) : un multiple de 15 minutes, de
      // 15 minutes à 8 heures ; vide, il revient à une heure. Sans effet sur les devis déjà au temps
      // passé, qui gardent leur pas et leur minimum figés.
      try {
        if ('pasTempsPasseMinutes' in req.body) data.pasTempsPasseMinutes = lireReglagePasTempsPasse(req.body.pasTempsPasseMinutes);
        if ('tempsMinimumMinutes' in req.body) data.tempsMinimumMinutes = lireReglageTempsMinimum(req.body.tempsMinimumMinutes);
      } catch (error) {
        if (error instanceof TempsPasseSaisieError) return res.status(400).json({ error: error.message });
        throw error;
      }
      // Destinataires du suivi de rentabilité (cf. voitRentabilite) : chaque case absente du
      // corps garde sa valeur ; une valeur présente doit être un vrai booléen, pour qu'une
      // chaîne « false » ne soit jamais lue comme une activation.
      for (const champ of ['rentabiliteConducteur', 'rentabiliteHierarchie', 'rentabiliteDirecteurs'] as const) {
        if (!(champ in req.body)) continue;
        if (typeof req.body[champ] !== 'boolean') {
          return res.status(400).json({ error: 'Les destinataires du suivi de rentabilité se règlent par oui ou non.' });
        }
        data[champ] = req.body[champ];
      }
      const p = await transactionVerifiee(async (tx) => {
        await verrouillerReglage(tx, 'Parametres');
        const avant = await tx.parametres.findUnique({ where: { id: 'singleton' } });
        const apres = await tx.parametres.upsert({
          where: { id: 'singleton' },
          update: data,
          create: { id: 'singleton', ...data },
        });
        const changements = changementsJournal(avant, apres, Object.keys(data));
        if (changements) await journaliserAdministration(tx, req as AuthRequest, { domaine: 'REGLAGES', type: 'PARAMETRES', action: 'MODIFICATION', ...changements });
        return apres;
      });
      res.json(decimalToNumber(p));
    } catch (error) {
      res.status(500).json({ error: 'Error updating parametres' });
    }
  });
}
