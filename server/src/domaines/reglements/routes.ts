import type { Express } from 'express';
import { Prisma } from '@prisma/client';
import { prisma, transactionVerifiee } from '../../db';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { requireAdmin } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { FUSEAU_HORAIRE_PAR_DEFAUT, aujourdHuiEntreprise, dateSeuleEnJourCivil, dateIsoStricte } from '../../commun/dates';
import { decimalToNumber, PLAFOND_MONTANT } from '../../commun/montants';
import { nombreDecimalNonNegatif, motifCorrectionValide } from '../../commun/validation';
import { formatMontantFacture, formatDateFacture } from '../factures/metier';
import {
  MOYENS_REGLEMENT, LIBELLES_MOYEN_REGLEMENT, MAX_AFFECTATIONS_REGLEMENT, ReglementRefuse, reglementInclude, soldesFactures,
  synchroniserStatutReglement, centimesEntiers, referenceReglementValide,
} from './metier';

export function enregistrerRoutesReglements(app: Express): void {
  // Règlements : lecture paginée, la plus récente d'abord, filtrable par client ou par facture.
  app.get('/api/reglements', requireAuth, requireAdmin, async (req, res) => {
    const entierStrict = (valeur: unknown, defaut: number): number | null => {
      if (valeur === undefined) return defaut;
      if (typeof valeur !== 'string' || !/^[1-9]\d*$/.test(valeur)) return null;
      const nombre = Number(valeur);
      return Number.isSafeInteger(nombre) ? nombre : null;
    };
    const page = entierStrict(req.query.page, 1), pageSize = entierStrict(req.query.pageSize, 25);
    if (page === null || pageSize === null || pageSize > 100) return res.status(400).json({ error: 'page et pageSize doivent être des entiers positifs (pageSize ≤ 100).' });
    // Un filtre répété (?clientId=a&clientId=b) arrive en tableau : le refuser plutôt que tout lister.
    if ([req.query.clientId, req.query.factureId].some(valeur => valeur !== undefined && typeof valeur !== 'string')) return res.status(400).json({ error: 'Les filtres clientId et factureId sont des valeurs uniques.' });
    const clientId = typeof req.query.clientId === 'string' && req.query.clientId ? req.query.clientId : null;
    const factureId = typeof req.query.factureId === 'string' && req.query.factureId ? req.query.factureId : null;
    const where: Prisma.ReglementWhereInput = { ...(clientId ? { clientId } : {}), ...(factureId ? { affectations: { some: { factureId } } } : {}) };
    try {
      const skip = (page - 1) * pageSize;
      const { total, items } = await transactionVerifiee(async tx => {
        const total = await tx.reglement.count({ where });
        const items = skip >= total ? [] : await tx.reglement.findMany({ where, include: reglementInclude, orderBy: [{ dateReglement: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], skip, take: pageSize });
        return { total, items };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      return res.json({ items: decimalToNumber(items), page, pageSize, total });
    } catch { return res.status(500).json({ error: 'Lecture des règlements impossible.' }); }
  });

  // Saisie d'un règlement reçu, réparti sur une ou plusieurs factures émises du même client.
  // La somme des parts égale le montant ; le reste dû est relu sous verrou. Une facture que ses
  // règlements atteignent ou dépassent passe à « réglée » dans la même transaction.
  app.post('/api/reglements', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const corps = req.body || {};
      const clientId = typeof corps.clientId === 'string' ? corps.clientId : '';
      // Date civile : `dateIsoStricte` rend minuit UTC en ISO, comparé ici par son seul jour.
      const dateReglementIso = dateIsoStricte(corps.dateReglement);
      const dateReglement = dateReglementIso ? dateSeuleEnJourCivil(dateReglementIso) : null;
      const montant = nombreDecimalNonNegatif(corps.montant, 10);
      const moyen = String(corps.moyen || '');
      const reference = referenceReglementValide(corps.reference);
      if (!clientId) return res.status(400).json({ error: 'Le client du règlement est obligatoire.' });
      if (!dateReglement) return res.status(400).json({ error: 'La date du règlement doit être valide au format JJ-MM-AAAA.' });
      if (montant === null || montant > PLAFOND_MONTANT) return res.status(400).json({ error: 'Le montant du règlement doit être un nombre positif, avec au plus deux décimales.' });
      if (!(MOYENS_REGLEMENT as readonly string[]).includes(moyen)) return res.status(400).json({ error: 'Le moyen de paiement doit être virement, chèque, carte, prélèvement ou espèces.' });
      if (reference === undefined) return res.status(400).json({ error: 'La référence compte au plus 200 caractères, sans caractère de contrôle.' });
      const brutes = Array.isArray(corps.affectations) ? corps.affectations : [];
      if (!brutes.length || brutes.length > MAX_AFFECTATIONS_REGLEMENT) return res.status(400).json({ error: `Un règlement s’affecte à au moins une facture, et au plus ${MAX_AFFECTATIONS_REGLEMENT}.` });
      const affectations: { factureId: string; montant: number }[] = [];
      for (const brute of brutes) {
        const factureId = typeof brute?.factureId === 'string' ? brute.factureId : '';
        const part = nombreDecimalNonNegatif(brute?.montant, 10);
        if (!factureId || part === null) return res.status(400).json({ error: 'Chaque affectation désigne une facture et un montant positif, avec au plus deux décimales.' });
        if (affectations.some(affectation => affectation.factureId === factureId)) return res.status(400).json({ error: 'Une facture ne figure qu’une fois dans un règlement.' });
        affectations.push({ factureId, montant: part });
      }
      const totalAffecte = affectations.reduce((somme, affectation) => somme + centimesEntiers(affectation.montant), 0);
      if (totalAffecte !== centimesEntiers(montant)) return res.status(400).json({ error: `Le règlement doit être entièrement affecté : ${formatMontantFacture(totalAffecte / 100)} répartis pour un montant de ${formatMontantFacture(montant)}.` });
      const societe = await prisma.companySettings.findUnique({ where: { id: 'singleton' }, select: { fuseauHoraire: true } });
      if (dateReglement > aujourdHuiEntreprise(societe?.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT)) return res.status(400).json({ error: 'La date du règlement ne peut pas être postérieure à aujourd’hui.' });

      const reglement = await transactionVerifiee(async (tx) => {
        const client = await tx.client.findUnique({ where: { id: clientId }, select: { id: true } });
        if (!client) throw new ReglementRefuse(404, 'Client introuvable.');
        // Toujours le même ordre de verrous (identifiants croissants) : deux règlements
        // concurrents sur les mêmes factures s'attendent au lieu de s'interbloquer. Avoirs et
        // annulation verrouillent la même ligne : le reste dû relu ci-dessous ne peut plus bouger.
        const ids = affectations.map(affectation => affectation.factureId).sort();
        const verrouillees = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "Facture" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`);
        if (verrouillees.length !== ids.length) throw new ReglementRefuse(404, 'Facture introuvable.');
        const factures = await tx.facture.findMany({ where: { id: { in: ids } }, select: { id: true, numero: true, clientId: true, type: true, statut: true, totalTtc: true, dateEmission: true } });
        const parId = new Map(factures.map(facture => [facture.id, facture]));
        for (const affectation of affectations) {
          const facture = parId.get(affectation.factureId)!;
          if (facture.clientId !== client.id) throw new ReglementRefuse(409, `La facture ${facture.numero || 'brouillon'} appartient à un autre client : un règlement ne s’affecte qu’aux factures de son client.`);
          if (facture.type !== 'FACTURE' || facture.statut !== 'EMISE') throw new ReglementRefuse(409, `Seule une facture émise non soldée reçoit un règlement : la facture ${facture.numero || 'brouillon'} ne le peut pas.`);
          if (dateReglement < dateSeuleEnJourCivil(facture.dateEmission)) throw new ReglementRefuse(409, `Le règlement ne peut pas précéder l’émission de la facture ${facture.numero} (${formatDateFacture(facture.dateEmission)}).`);
        }
        // Une part peut dépasser le reste dû (décision de Nelson du 17-10-2026) : la facture est
        // réglée dès que le montant reçu l'atteint ou le dépasse, et le surplus devient un trop-perçu.
        // Choix par défaut, à confirmer : une facture déjà soldée (par avoir) ne reçoit plus rien, et
        // un surplus ne va sur une facture que si les autres factures du règlement sont couvertes.
        const soldes = await soldesFactures(tx, factures);
        const resteApresPart = (affectation: { factureId: string; montant: number }) => centimesEntiers(soldes.get(affectation.factureId)!.resteDu) - centimesEntiers(affectation.montant);
        for (const affectation of affectations) {
          const facture = parId.get(affectation.factureId)!;
          if (centimesEntiers(soldes.get(facture.id)!.resteDu) <= 0) throw new ReglementRefuse(409, `La facture ${facture.numero} est déjà soldée (reste dû ${formatMontantFacture(soldes.get(facture.id)!.resteDu)}) : elle ne reçoit plus de règlement.`);
        }
        const avecSurplus = affectations.find(affectation => resteApresPart(affectation) < 0);
        const encoreDue = affectations.find(affectation => resteApresPart(affectation) > 0);
        if (avecSurplus && encoreDue) throw new ReglementRefuse(409, `Le surplus ne peut aller sur la facture ${parId.get(avecSurplus.factureId)!.numero} tant que la facture ${parId.get(encoreDue.factureId)!.numero} de ce règlement reste due.`);
        const cree = await tx.reglement.create({ data: {
          clientId: client.id, dateReglement: new Date(dateReglementIso!), montant, moyen, reference, createdById: req.user!.id,
          affectations: { create: affectations.map(affectation => ({ factureId: affectation.factureId, montant: affectation.montant })) },
        }, include: reglementInclude });
        const libelle = `Règlement ${cree.id} du ${formatDateFacture(cree.dateReglement)} (${LIBELLES_MOYEN_REGLEMENT[moyen]}${reference ? `, réf. ${reference}` : ''})`;
        for (const affectation of affectations) {
          const facture = parId.get(affectation.factureId)!;
          const resteApres = resteApresPart(affectation) / 100;
          const solde = resteApres < 0 ? `trop-perçu ${formatMontantFacture(-resteApres)}` : `reste dû ${formatMontantFacture(resteApres)}`;
          await tx.journalFacture.create({ data: { factureId: facture.id, acteurId: req.user!.id, action: 'REGLEMENT_AFFECTE', detail: `${libelle} : ${formatMontantFacture(affectation.montant)} affectés ; ${solde}` } });
          await synchroniserStatutReglement(tx, facture.id, req.user!.id, `règlement ${cree.id}`);
        }
        return cree;
      });
      return res.status(201).json(decimalToNumber(reglement));
    } catch (error) {
      if (error instanceof ReglementRefuse) return res.status(error.statut).json({ error: error.message });
      return res.status(500).json({ error: 'Enregistrement du règlement impossible.' });
    }
  });

  // Une saisie erronée ne s'efface pas : la contre-passation la retire du reste dû de chaque
  // facture, avec motif, instant et auteur. Une facture qui n'est plus soldée redevient émise.
  app.post('/api/reglements/:id/contrepasser', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try {
      const motif = motifCorrectionValide(req.body?.motif);
      if (!motif || /[\u0000-\u001f\u007f]/.test(motif)) return res.status(400).json({ error: 'Un motif de 3 à 500 caractères, sans caractère de contrôle, est obligatoire.' });
      const reglement = await transactionVerifiee(async (tx) => {
        // Les parts sont immuables : les lire avant tout verrou est sûr. Les factures sont
        // ensuite verrouillées par identifiant croissant, comme à la saisie, puis le règlement.
        const parts = await tx.affectationReglement.findMany({ where: { reglementId: paramId(req) }, select: { factureId: true, montant: true } });
        if (!parts.length) throw new ReglementRefuse(404, 'Règlement introuvable.');
        const ids = parts.map(part => part.factureId).sort();
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Facture" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`);
        const [verrouille] = await tx.$queryRaw<{ statut: string }[]>(Prisma.sql`SELECT "statut" FROM "Reglement" WHERE "id" = ${paramId(req)} FOR UPDATE`);
        if (!verrouille) throw new ReglementRefuse(404, 'Règlement introuvable.');
        if (verrouille.statut !== 'ENREGISTRE') throw new ReglementRefuse(409, 'Ce règlement est déjà contre-passé.');
        const maj = await tx.reglement.update({ where: { id: paramId(req) }, data: { statut: 'CONTREPASSE', motifContrepassation: motif, contrepasseLe: new Date(), contrepasseParId: req.user!.id }, include: reglementInclude });
        const factures = await tx.facture.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, statut: true, totalTtc: true } });
        const soldes = await soldesFactures(tx, factures);
        const libelle = `Contre-passation du règlement ${maj.id} du ${formatDateFacture(maj.dateReglement)} de ${formatMontantFacture(maj.montant)} : « ${motif} »`;
        for (const facture of factures) {
          const part = parts.find(ligne => ligne.factureId === facture.id)!;
          const resteDu = soldes.get(facture.id)?.resteDu ?? 0;
          const solde = resteDu < 0 ? `trop-perçu ${formatMontantFacture(-resteDu)}` : `reste dû ${formatMontantFacture(resteDu)}`;
          await tx.journalFacture.create({ data: { factureId: facture.id, acteurId: req.user!.id, action: 'REGLEMENT_CONTREPASSE', detail: `${libelle} ; ${formatMontantFacture(part.montant)} retirés ; ${solde}` } });
          await synchroniserStatutReglement(tx, facture.id, req.user!.id, `contre-passation du règlement ${maj.id}`);
        }
        return maj;
      });
      return res.json(decimalToNumber(reglement));
    } catch (error) {
      if (error instanceof ReglementRefuse) return res.status(error.statut).json({ error: error.message });
      return res.status(500).json({ error: 'Contre-passation du règlement impossible.' });
    }
  });
}
