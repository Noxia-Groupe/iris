import type { Express, Response } from 'express';
import { prisma, transactionVerifiee } from '../../db';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { requireAdmin } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { FUSEAU_HORAIRE_PAR_DEFAUT } from '../../commun/dates';
import { decimalToNumber } from '../../commun/montants';
import { nombreDecimalNonNegatif } from '../../commun/validation';
import { getCompanySettings } from '../administration/metier';
import { dureeTempsPasse } from '../devis/tempsPasse';
import { factureInclude, formatMontantFacture } from './metier';
import { type FactureTempsPassePreparee, RefusFactureTempsPasse, lireDatesFacture, preparerFactureTempsPasse } from './tempsPasse';

const heuresFr = (heures: number) => heures.toLocaleString('fr-FR', { maximumFractionDigits: 3 });
const duree = (minutes: number) => Number.isInteger(minutes) ? dureeTempsPasse(minutes) : `${heuresFr(minutes / 60)} h`;

// Trace du calcul dans le journal de la facture : heures comptées, règle appliquée et devis repris.
function detailJournal(calcul: FactureTempsPassePreparee): string {
  const { heures, devis } = calcul;
  const suites = heures.suites.filter((suite) => suite.heures !== null).length;
  const regle = heures.minimumFige
    ? `minimum ${duree(heures.plancherMinutes)}, puis tranches de ${heures.pasMinutes} min`
    : `devis antérieur au temps minimum : plancher ${duree(heures.plancherMinutes)}, les heures de sa ligne, puis tranches de ${heures.pasMinutes} min`;
  return `Origine INTERVENTION, au temps passé : ${heuresFr(heures.saisies)} h saisies sur l’intervention et ${suites} suite${suites > 1 ? 's' : ''} facturable${suites > 1 ? 's' : ''}, ${heuresFr(heures.facturees)} h facturées (${regle}) ; devis ${devis.numero} v${devis.version}`;
}

const refus = (res: Response, error: unknown) => {
  if (error instanceof RefusFactureTempsPasse) return res.status(error.statut).json({ error: error.message });
  return null;
};

export function enregistrerRoutesFactureTempsPasse(app: Express): void {
  // Aperçu : la facture que créerait la route suivante, sans rien écrire.
  app.get('/api/interventions/:id/facture-temps-passe', requireAuth, requireAdmin, async (req, res) => {
    try {
      const calcul = await preparerFactureTempsPasse(prisma, paramId(req), false);
      res.json(decimalToNumber(calcul));
    } catch (error) {
      if (refus(res, error)) return;
      console.error('Erreur aperçu facture au temps passé', error);
      res.status(500).json({ error: 'Aperçu de la facture au temps passé impossible.' });
    }
  });

  // Création du brouillon. Le total HT de l'aperçu lu par l'administration est exigé : une heure saisie,
  // corrigée ou archivée entre l'aperçu et la création refuse la facture au lieu de la changer en silence.
  app.post('/api/interventions/:id/facture-temps-passe', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const societe = await getCompanySettings();
      const { dateEmission, dateEcheance } = lireDatesFacture(req.body, societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT);
      const totalHtAttendu = nombreDecimalNonNegatif(req.body?.totalHtAttendu, 10, true);
      if (totalHtAttendu === null) return res.status(400).json({ error: 'Le total HT de l’aperçu (totalHtAttendu) est requis : relisez l’aperçu de la facture au temps passé.' });
      const facture = await transactionVerifiee(async (tx) => {
        const calcul = await preparerFactureTempsPasse(tx, paramId(req), true);
        if (calcul.totalHt !== totalHtAttendu) {
          throw new RefusFactureTempsPasse(409, `La facture au temps passé a changé depuis l’aperçu (total HT ${formatMontantFacture(calcul.totalHt)} au lieu de ${formatMontantFacture(totalHtAttendu)}) : relisez l’aperçu avant de la créer.`);
        }
        const creee = await tx.facture.create({ data: {
          clientId: calcul.intervention.clientId, clientRaisonSociale: calcul.intervention.clientRaisonSociale, origine: 'INTERVENTION', interventionId: calcul.intervention.id,
          tempsPasse: true, dateEmission, dateEcheance, totalHt: calcul.totalHt, totalTva: calcul.totalTva, totalTtc: calcul.totalTtc, createdById: req.user!.id,
          lignes: { create: calcul.lignes.map(({ tempsPasse: _tempsPasse, ...ligne }) => ligne) }, ventilationTva: { create: calcul.ventilationTva },
        }, include: factureInclude });
        await tx.journalFacture.create({ data: { factureId: creee.id, acteurId: req.user!.id, action: 'CREATION_BROUILLON', detail: detailJournal(calcul) } });
        return creee;
      });
      res.status(201).json(decimalToNumber(facture));
    } catch (error) {
      if (refus(res, error)) return;
      // Index unique partiel de la migration : une seconde facture vivante au temps passé, concurrente.
      if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'Cette intervention a déjà une facture au temps passé.' });
      console.error('Erreur création facture au temps passé', error);
      res.status(500).json({ error: 'Création de la facture au temps passé impossible.' });
    }
  });
}
