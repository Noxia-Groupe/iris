import express from 'express';
import type { Express } from 'express';
import crypto from 'crypto';
import { prisma, transactionVerifiee } from '../../db';
import { isAdminRole } from '../../droits/roles';
import { requirePermission } from '../../droits/permissions';
import { voitPrixAchatDevis, ecritPrixAchatDevis } from '../../droits/visibilite';
import { type AuthRequest, requireAuth } from '../../http/auth';
import type { ApiRequest } from '../../http/cles-api';
import { requireAdmin } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { routeMixte } from '../../http/routes-mixtes';
import { FUSEAU_HORAIRE_PAR_DEFAUT, anneeEntreprise, aujourdHuiEntreprise, dateIsoStricte } from '../../commun/dates';
import { decimalToNumber, centimes } from '../../commun/montants';
import { nombreDecimalNonNegatif } from '../../commun/validation';
import { getParametres } from '../parametres/metier';
import { getCompanySettings } from '../administration/metier';
import { type CatalogueFamily, catalogueFamily, catalogueModels } from '../catalogue/metier';
import { sanitizeTypes, refusTitulaire, refusCommercial } from '../chantiers/metier';
import { SaisieInterventionInvalide, creerInterventionNumerotee, estEncadrementCoutIntervention, exposerIntervention, lireDetailsIntervention } from '../interventions/metier';
import { SaisieContratInvalide, creerContratMaintenance, lireSaisieContrat } from '../contrats/metier';
import {
  DevisSaisieError, DevisConflitError, DevisDroitError, devisPayload, NATURE_DEVIS_PAR_FAMILLE, devisPourLecteur, resoudreLignesDevis,
  devisInclude, contenuDevisSigne, copieLigneDevis, verrouillerDevis, acompteDevisPayload, nouveauNumeroDevis,
} from './metier';

function devisErreur(res: express.Response, error: unknown) {
  if (error instanceof DevisSaisieError) return res.status(400).json({ error: error.message });
  if (error instanceof DevisConflitError) return res.status(409).json({ error: error.message });
  if (error instanceof DevisDroitError) return res.status(403).json({ error: error.message });
  if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Une révision concurrente vient d’être créée, réessayez.' });
  console.error('Devis:', error); return res.status(500).json({ error: 'Opération devis impossible.' });
}

const creerDevis: express.RequestHandler = async (req, res) => { try {
  const payload = devisPayload((req.body ?? {}) as Record<string, unknown>);
  if (!await prisma.client.findUnique({ where: { id: payload.clientId } })) throw new DevisSaisieError('Client introuvable.');
  const lignes = await resoudreLignesDevis(prisma, payload, [], ecritPrixAchatDevis(req));
  const { acompteExige, tauxAcompte } = await acompteDevisPayload((req.body ?? {}) as Record<string, unknown>);
  const devis = await prisma.devis.create({ data: { dossierId: crypto.randomUUID(), numero: await nouveauNumeroDevis(), version: 1, clientId: payload.clientId, objet: payload.objet, totalHt: payload.totalHt, totalTva: payload.totalTva, totalTtc: payload.totalTtc, acompteExige, tauxAcompte, lignes: { create: lignes } }, include: devisInclude });
  res.status(201).json(devisPourLecteur(req, decimalToNumber(devis)));
} catch (error) { devisErreur(res, error); } };
const listerDevis: express.RequestHandler = async (req, res) => { try { res.json(devisPourLecteur(req, decimalToNumber(await prisma.devis.findMany({ include: devisInclude, orderBy: { createdAt: 'desc' } })))); } catch (error) { devisErreur(res, error); } };
const modifierDevis: express.RequestHandler = async (req, res) => { try {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const payload = devisPayload(body);
  const devis = await transactionVerifiee(async tx => {
    if (!await verrouillerDevis(tx, paramId(req))) throw new DevisSaisieError('Devis introuvable.');
    const precedent = await tx.devis.findUniqueOrThrow({ where: { id: paramId(req) }, include: { signature: true, conversion: true, lignes: true } });
    if (precedent.signature) throw new DevisConflitError('Ce devis est signé : créez une nouvelle révision brouillon pour le modifier.');
    if (precedent.conversion) throw new DevisConflitError('Ce devis est déjà converti : il ne peut plus être modifié.');
    if (!['BROUILLON', 'ENVOYE'].includes(precedent.statut)) throw new DevisConflitError('Seuls les devis brouillon ou envoyés, non signés, peuvent être modifiés.');
    if (!await tx.client.findUnique({ where: { id: payload.clientId } })) throw new DevisSaisieError('Client introuvable.');
    const acompte = await acompteDevisPayload(body, precedent);
    const lignes = await resoudreLignesDevis(tx, payload, precedent.lignes, ecritPrixAchatDevis(req));
    return tx.devis.update({
      where: { id: precedent.id },
      data: { clientId: payload.clientId, objet: payload.objet, totalHt: payload.totalHt, totalTva: payload.totalTva, totalTtc: payload.totalTtc, ...acompte,
        lignes: { deleteMany: {}, create: lignes } }, include: devisInclude,
    });
  });
  res.json(devisPourLecteur(req, decimalToNumber(devis)));
} catch (error) { devisErreur(res, error); } };
const creerRevision: express.RequestHandler = async (req, res) => { try {
  const devis = await transactionVerifiee(async tx => {
    if (!await verrouillerDevis(tx, paramId(req))) throw new DevisSaisieError('Devis introuvable.');
    const precedent = await tx.devis.findUniqueOrThrow({ where: { id: paramId(req) }, include: devisInclude });
    if (!precedent.signature) throw new DevisConflitError('Seul un devis signé peut ouvrir une nouvelle révision.');
    if (precedent.conversion) throw new DevisConflitError('Ce devis est déjà converti : il ne peut plus être révisé.');
    const versionPlusRecente = await tx.devis.findFirst({ where: { dossierId: precedent.dossierId, version: { gt: precedent.version } }, select: { id: true } });
    if (versionPlusRecente) throw new DevisConflitError('Seule la dernière version du dossier peut être révisée.');
    const version = ((await tx.devis.aggregate({ where: { dossierId: precedent.dossierId }, _max: { version: true } }))._max.version ?? 0) + 1;
    return tx.devis.create({ data: {
      dossierId: precedent.dossierId, numero: precedent.numero, version, clientId: precedent.clientId, objet: precedent.objet,
      totalHt: precedent.totalHt, totalTva: precedent.totalTva, totalTtc: precedent.totalTtc,
      acompteExige: precedent.acompteExige, tauxAcompte: precedent.tauxAcompte,
      acompteRecuLe: precedent.acompteRecuLe, acompteMontant: precedent.acompteMontant,
      acompteReference: precedent.acompteReference, acompteConstateParId: precedent.acompteConstateParId,
      lignes: { create: precedent.lignes.map(copieLigneDevis) },
    }, include: devisInclude });
  });
  res.status(201).json(devisPourLecteur(req, decimalToNumber(devis)));
} catch (error) { devisErreur(res, error); } };
const signerDevis: express.RequestHandler = async (req, res) => { try {
  const signataire = typeof req.body?.signataire === 'string' ? req.body.signataire.trim() : '';
  if (signataire.length < 2 || signataire.length > 200 || req.body?.confirme !== true) throw new DevisSaisieError('Le signataire et sa confirmation explicite sont obligatoires.');
  const signature = await transactionVerifiee(async tx => {
    if (!await verrouillerDevis(tx, paramId(req))) throw new DevisSaisieError('Devis introuvable.');
    const devis = await tx.devis.findUniqueOrThrow({ where: { id: paramId(req) }, include: { lignes: { orderBy: { ordre: 'asc' } }, signature: true, conversion: true } });
    if (devis.signature) throw new DevisConflitError('Ce devis est déjà signé.');
    if (devis.conversion) throw new DevisConflitError('Ce devis est déjà converti : il ne peut plus être signé.');
    if (devis.statut === 'ANNULE' || devis.statut === 'REFUSE') throw new DevisConflitError('Ce devis ne peut plus être signé dans son état actuel.');
    const empreinte = crypto.createHash('sha256').update(JSON.stringify(contenuDevisSigne(devis)), 'utf8').digest('hex');
    await tx.devis.update({ where: { id: devis.id }, data: { statut: 'ACCEPTE' } });
    const auteur = (req as AuthRequest).user;
    if (!auteur) throw new DevisConflitError('Une session humaine active est obligatoire pour signer un devis.');
    return tx.devisSignature.create({ data: { devisId: devis.id, enregistreParId: auteur.id, signataire, empreinte }, select: { id: true, signataire: true, empreinte: true, signeLe: true, enregistreParId: true } });
  });
  res.status(201).json(signature);
} catch (error) { devisErreur(res, error); } };

// Cycle de vie d'un devis. `ANNULE` ne figure dans aucune liste de destinations : on n'y
// entre que par la route d'annulation, qui exige un motif et vérifie le chantier lié — et
// on n'en sort jamais. `EN_ATTENTE_ACOMPTE` est le choix explicite fait après acceptation :
// ouvrir le chantier tout de suite, ou attendre l'acompte. Un devis peut y revenir tant
// que l'acompte n'est pas constaté, mais pas une fois le chantier ouvert.
const TRANSITIONS_DEVIS: Record<string, string[]> = {
  BROUILLON: ['ENVOYE'],
  ENVOYE: ['REFUSE', 'BROUILLON'],
  ACCEPTE: ['EN_ATTENTE_ACOMPTE'],
  EN_ATTENTE_ACOMPTE: ['ACCEPTE'],
  REFUSE: [],
  ANNULE: [],
};

// Un devis converti est figé : celui qui a ouvert un chantier ne peut plus qu'être annulé, par
// sa propre route ; celui qui a créé une intervention ou un contrat ne change plus (lot pilote 4).
function refusStatutFige(devis: { statut: string; conversion?: { cibleType: string } | null }): string | null {
  if (devis.statut === 'ANNULE') return 'Ce devis est annulé : son statut ne peut plus changer.';
  if (devis.conversion?.cibleType === 'CHANTIER') return 'Le chantier de ce devis est déjà ouvert : seule une annulation peut revenir dessus.';
  if (devis.conversion) return 'Ce devis est déjà converti : son statut ne change plus.';
  return null;
}
const changerStatutDevis: express.RequestHandler = async (req, res) => { try {
  const statut = String((req.body ?? {}).statut || '');
  // Sous le verrou du devis : un changement de statut concurrent d'une conversion attend sa fin
  // et lit alors le chantier ouvert (statut figé), au lieu d'écraser le statut d'un devis converti.
  const maj = await transactionVerifiee(async tx => {
    if (!await verrouillerDevis(tx, paramId(req))) return null;
    const devis = await tx.devis.findUniqueOrThrow({ where: { id: paramId(req) }, include: { conversion: true } });
    const fige = refusStatutFige(devis);
    if (fige) throw new DevisSaisieError(fige);
    if (!TRANSITIONS_DEVIS[devis.statut]?.includes(statut)) throw new DevisSaisieError(`Transition ${devis.statut} → ${statut} interdite.`);
    // Passer en attente d'acompte n'a de sens que si le devis en exige un.
    if (statut === 'EN_ATTENTE_ACOMPTE' && !devis.acompteExige) throw new DevisSaisieError('Ce devis n’exige pas d’acompte.');
    if (statut === 'ACCEPTE' && devis.statut === 'EN_ATTENTE_ACOMPTE' && !devis.acompteRecuLe) throw new DevisSaisieError('L’acompte de ce devis n’a pas encore été constaté.');
    return tx.devis.update({ where: { id: devis.id }, data: { statut }, include: devisInclude });
  });
  if (!maj) return void res.status(404).json({ error: 'Devis introuvable.' });
  res.json(devisPourLecteur(req, decimalToNumber(maj)));
} catch (error) { devisErreur(res, error); } };

// Une conversion ne démarre qu'après acceptation. Elle ouvre le chantier de l'affaire, ou, depuis
// le lot pilote 4 (décision A7), crée son intervention SAV ou son contrat de maintenance, sans
// ressaisie du client ni de l'objet. La facture reste créée depuis l'écran Factures.
//
// Chaque affaire n'est convertie qu'une fois, quelle que soit la cible (décision de Nelson du
// 14-10-2026 pour le chantier, étendue aux deux autres cibles, choix par défaut à confirmer) : un
// devis déjà converti, un dossier dont une autre version l'est déjà et une référence d'affaire
// déjà portée par un chantier sont refusés (409). Le verrou du devis fait passer l'une après
// l'autre deux conversions du même devis ; les contraintes uniques de DevisConversion restent le
// filet.
//
// L'intervention et le contrat ne se créent que depuis une session, avec les droits de leur
// création directe : l'encadrement SAV pour l'intervention, l'administration pour le contrat.
// Aucune clé d'intégration ne crée l'un ou l'autre, ni par cette route ni ailleurs.
//
// Depuis l'Administration, la même conversion ouvre le chantier avec son titulaire, son
// commercial, ses types et sa date de début. Ces choix relèvent de la fiche, que seuls
// l'administration et le titulaire modifient : ils ne sont acceptés que d'une session
// administrateur. Sans eux, c'est la conversion de l'écran Devis, et le chantier s'attribue
// ensuite depuis sa fiche.
const CHAMPS_OUVERTURE_CHANTIER = ['responsableId', 'commercialId', 'types', 'dateDebut'];
const REFUS_DOUBLE_CONVERSION = 'Ce devis a déjà été converti : chaque affaire n’ouvre qu’un seul chantier.';
type CibleConversion = 'CHANTIER' | 'INTERVENTION' | 'CONTRAT';
const CIBLES_CONVERSION: CibleConversion[] = ['CHANTIER', 'INTERVENTION', 'CONTRAT'];
const LIBELLES_CIBLE: Record<CibleConversion, { ouvrir: string; pasEncore: string; pas: string; dossier: string }> = {
  CHANTIER: { ouvrir: 'ouvrir de chantier', pasEncore: 'le chantier ne peut pas encore être ouvert', pas: 'le chantier ne peut pas être ouvert', dossier: 'son chantier' },
  INTERVENTION: { ouvrir: 'créer d’intervention', pasEncore: 'l’intervention ne peut pas encore être créée', pas: 'l’intervention ne peut pas être créée', dossier: 'son intervention' },
  CONTRAT: { ouvrir: 'créer de contrat', pasEncore: 'le contrat ne peut pas encore être créé', pas: 'le contrat ne peut pas être créé', dossier: 'son contrat' },
};
const cibleConnue = (valeur: string): CibleConversion => (CIBLES_CONVERSION as string[]).includes(valeur) ? valeur as CibleConversion : 'CHANTIER';
function refusDejaConverti(existante: string, cible: CibleConversion): string {
  if (existante === 'CHANTIER' && cible === 'CHANTIER') return REFUS_DOUBLE_CONVERSION;
  return `Ce devis a déjà créé ${LIBELLES_CIBLE[cibleConnue(existante)].dossier} : chaque affaire n’est convertie qu’une fois.`;
}
// Le titulaire, le commercial et les types n'existent que sur un chantier.
const CHAMPS_CHANTIER_SEUL = ['responsableId', 'commercialId', 'types'];
async function ouvertureChantier(body: Record<string, unknown>): Promise<{ responsableId?: string; commercialId?: string | null; types?: string[]; dateDebut?: string }> {
  const ouverture: { responsableId?: string; commercialId?: string | null; types?: string[]; dateDebut?: string } = {};
  if ('responsableId' in body) {
    const responsableId = String(body.responsableId || '');
    const refus = await refusTitulaire(responsableId, null);
    if (refus) throw new DevisSaisieError(refus);
    ouverture.responsableId = responsableId;
  }
  if ('commercialId' in body) {
    const commercialId = String(body.commercialId || '');
    const refus = await refusCommercial(commercialId, null);
    if (refus) throw new DevisSaisieError(refus);
    ouverture.commercialId = commercialId || null;
  }
  if ('types' in body) ouverture.types = sanitizeTypes(body.types);
  // Une date présente mais vide est refusée, comme un titulaire vide : seule son absence laisse le
  // chantier commencer le jour de la conversion.
  if ('dateDebut' in body) {
    const dateDebut = dateIsoStricte(body.dateDebut);
    if (!dateDebut) throw new DevisSaisieError('La date de début doit être valide au format JJ-MM-AAAA.');
    ouverture.dateDebut = dateDebut;
  }
  return ouverture;
}
const convertirDevis: express.RequestHandler = async (req, res) => { try {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const valeurCible = String(body.cible || '');
  if (!(CIBLES_CONVERSION as string[]).includes(valeurCible)) throw new DevisSaisieError('Cible de conversion non disponible.');
  const cible = valeurCible as CibleConversion;
  const auteur = (req as AuthRequest).user;
  if (cible === 'CHANTIER' && CHAMPS_OUVERTURE_CHANTIER.some(cle => cle in body) && ((req as ApiRequest).apiKey || !isAdminRole(auteur?.role))) {
    return void res.status(403).json({ error: 'Seule l’administration choisit le titulaire, le commercial, les types et la date de début à l’ouverture du chantier ; ils se modifient ensuite depuis sa fiche.' });
  }
  if (cible !== 'CHANTIER') {
    if ((req as ApiRequest).apiKey || !auteur) return void res.status(403).json({ error: 'Une intervention ou un contrat ne se crée depuis un devis que dans une session de l’application.' });
    if (cible === 'INTERVENTION' && !estEncadrementCoutIntervention(auteur.role)) return void res.status(403).json({ error: 'Création réservée à l’encadrement SAV.' });
    if (cible === 'CONTRAT' && !isAdminRole(auteur.role)) return void res.status(403).json({ error: 'La création d’un contrat de maintenance est réservée à l’administration.' });
    if (CHAMPS_CHANTIER_SEUL.some(cle => cle in body)) throw new DevisSaisieError('Le titulaire, le commercial et les types ne s’attribuent qu’à l’ouverture d’un chantier.');
  }
  const libelles = LIBELLES_CIBLE[cible];
  const ouverture = cible === 'CHANTIER' ? await ouvertureChantier(body) : {};
  // Sans date choisie, le chantier commence le jour civil de la société (décision de Nelson du
  // 14-10-2026), enregistré en date-seule comme une date saisie, et non à l'instant UTC.
  const societe = await getCompanySettings();
  const fuseau = societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
  const debutParDefaut = `${aujourdHuiEntreprise(fuseau)}T00:00:00.000Z`;
  const resultat = await transactionVerifiee(async tx => {
    // Verrou du devis, comme pour sa modification, sa révision, sa signature, son statut, son
    // acompte et son annulation : ces écritures et deux conversions simultanées du même devis
    // passent l'une après l'autre. La seconde conversion lit celle de la première (« déjà
    // converti »), au lieu de tomber, selon le moment, sur le contrôle du dossier ou de la
    // référence avec un message inexact.
    if (!await verrouillerDevis(tx, paramId(req))) throw new DevisSaisieError('Devis introuvable.');
    const devis = await tx.devis.findUnique({ where: { id: paramId(req) }, include: { client: true, conversion: true, signature: true, lignes: true } });
    if (!devis) throw new DevisSaisieError('Devis introuvable.');
    if (devis.statut === 'ANNULE') throw new DevisSaisieError(`Ce devis est annulé : il ne peut plus ${libelles.ouvrir}.`);
    const versionPlusRecente = await tx.devis.findFirst({ where: { dossierId: devis.dossierId, version: { gt: devis.version }, statut: { not: 'ANNULE' } }, select: { id: true } });
    if (versionPlusRecente) throw new DevisConflitError('Seule la dernière version non annulée du dossier peut être convertie.');
    if (devis.statut === 'EN_ATTENTE_ACOMPTE') throw new DevisSaisieError(`Ce devis attend son acompte : ${libelles.pasEncore}.`);
    if (devis.statut !== 'ACCEPTE') throw new DevisSaisieError('Seul un devis accepté peut être converti.');
    if (!devis.signature) throw new DevisSaisieError('Seul un devis signé en interne peut être converti.');
    if (devis.conversion) throw new DevisConflitError(refusDejaConverti(devis.conversion.cibleType, cible));
    // Verrou de fond, indépendant du statut : un devis qui exige un acompte n'ouvre pas de
    // chantier tant que sa réception n'a pas été constatée. Le statut peut être manipulé,
    // pas ce fait.
    if (devis.acompteExige && !devis.acompteRecuLe) throw new DevisSaisieError(`L’acompte exigé par ce devis n’a pas été constaté : ${libelles.pas}.`);
    // Une autre version du dossier a déjà ouvert le chantier de l'affaire, puis a pu être annulée
    // avec lui : l'affaire a eu son chantier. Sa reprise passe par la duplication du devis, qui
    // crée une nouvelle affaire (cf. POST /api/devis/:id/duplication).
    const conversionDuDossier = await tx.devisConversion.findFirst({ where: { dossierId: devis.dossierId }, select: { cibleType: true } });
    if (conversionDuDossier) {
      throw new DevisConflitError(conversionDuDossier.cibleType === 'CHANTIER' && cible === 'CHANTIER'
        ? 'Une autre version de ce devis a déjà ouvert le chantier de l’affaire : chaque affaire n’en ouvre qu’un. Pour la reprendre, dupliquez le devis.'
        : 'Une autre version de ce devis a déjà été convertie : chaque affaire n’est convertie qu’une fois. Pour la reprendre, dupliquez le devis.');
    }
    // Un chantier saisi à la main sous cette référence (fiche corrigée, par exemple) est déjà
    // celui de l'affaire : la fiche refuse de même un numéro déjà pris. Une affaire annulée ne
    // se modifie plus : on oriente alors vers la duplication, et non vers une correction.
    const chantierDeLaReference = await tx.chantier.findFirst({ where: { numeroDevis: devis.numero }, select: { statut: true } });
    if (chantierDeLaReference) {
      throw new DevisConflitError(chantierDeLaReference.statut === 'ANNULE'
        ? `L’affaire ${devis.numero} a déjà eu un chantier, annulé depuis : pour la reprendre, dupliquez le devis.`
        : `L’affaire ${devis.numero} a déjà un chantier : corrigez la référence de ce chantier avant de convertir le devis.`);
    }
    const motif = `Conversion du devis ${devis.numero} (version ${devis.version}).`;
    if (cible !== 'CHANTIER') {
      // Comme leur création directe : un client désactivé n'ouvre plus de dossier.
      if (!await tx.client.findFirst({ where: { id: devis.clientId, actif: true }, select: { id: true } })) {
        throw new DevisConflitError(`Le client de ce devis est désactivé : ${libelles.pas}. Réactivez d’abord sa fiche.`);
      }
      const titre = typeof body.titre === 'string' && body.titre.trim() ? body.titre.trim() : devis.objet;
      if (cible === 'INTERVENTION') {
        const details = await lireDetailsIntervention(tx, body, devis.clientId, fuseau);
        const intervention = await creerInterventionNumerotee(tx, req as AuthRequest, anneeEntreprise(new Date(), fuseau), { clientId: devis.clientId, titre, chantierId: null, ...details }, motif);
        await tx.devisConversion.create({ data: { devisId: devis.id, dossierId: devis.dossierId, cibleType: 'INTERVENTION', cibleId: intervention.id } });
        return exposerIntervention(intervention);
      }
      const saisie = lireSaisieContrat({ ...body, titre });
      const siteId = typeof body.siteId === 'string' && body.siteId ? body.siteId : null;
      if (siteId && !await tx.clientSite.findFirst({ where: { id: siteId, clientId: devis.clientId }, select: { id: true } })) throw new SaisieInterventionInvalide(404, 'Site introuvable.');
      const contrat = await creerContratMaintenance(tx, req as AuthRequest, { clientId: devis.clientId, siteId, ...saisie }, motif);
      await tx.devisConversion.create({ data: { devisId: devis.id, dossierId: devis.dossierId, cibleType: 'CONTRAT', cibleId: contrat.id } });
      return contrat;
    }
    const budgetMaterielVendu = centimes(devis.lignes.filter(l => l.nature === 'FOURNITURE').reduce((total, l) => total + Number(l.totalHt), 0));
    const budgetMainOeuvreVendu = centimes(devis.totalHt.toNumber() - budgetMaterielVendu);
    const heuresVendues = devis.lignes.filter(l => l.nature === 'MAIN_OEUVRE').reduce((total, l) => total + Number(l.quantite), 0);
    const chantier = await tx.chantier.create({ data: {
      nom: devis.objet, client: devis.client.raisonSociale, clientId: devis.clientId, numeroDevis: devis.numero,
      dateDebut: ouverture.dateDebut ?? debutParDefaut, budgetGlobalVendu: devis.totalHt, budgetMaterielVendu, budgetMainOeuvreVendu, heuresVendues,
      responsableId: ouverture.responsableId, commercialId: ouverture.commercialId, types: ouverture.types,
    } });
    await tx.devisConversion.create({ data: { devisId: devis.id, dossierId: devis.dossierId, cibleType: 'CHANTIER', cibleId: chantier.id } });
    return chantier;
  });
  res.status(201).json(decimalToNumber(resultat));
} catch (error) {
  // Défense en profondeur : les contraintes uniques de DevisConversion. Les verrous du devis
  // (conversion, révision, annulation) les rendent inatteignables en fonctionnement normal : deux
  // conversions du même devis passent l'une après l'autre, et une autre version du dossier ne se
  // convertit qu'une fois la conversion précédente visible, que le contrôle du dossier refuse.
  // Si le filet servait malgré tout, la seconde serait refusée et son chantier annulé avec la
  // transaction.
  if ((error as { code?: string })?.code === 'P2002') {
    return void res.status(409).json({ error: String((req.body ?? {}).cible || '') === 'CHANTIER'
      ? 'Une autre version de ce devis vient d’ouvrir le chantier de l’affaire : chaque affaire n’en ouvre qu’un.'
      : 'Une autre version de ce devis vient d’être convertie : chaque affaire n’est convertie qu’une fois.' });
  }
  if (error instanceof SaisieInterventionInvalide) return void res.status(error.status).json({ error: error.message });
  if (error instanceof SaisieContratInvalide) return void res.status(400).json({ error: error.message });
  devisErreur(res, error);
} };

export function enregistrerRoutesDevis(app: Express): void {
  // Fiches actives du catalogue, pour composer un devis : réservé aux porteurs du droit devis
  // (jamais le technicien, qui ne l'a jamais). La recherche porte sur la référence et la
  // désignation ; 50 fiches au plus, triées par désignation (choix par défaut, à confirmer).
  app.get('/api/devis/catalogue', requireAuth, requirePermission('devis:write'), async (req, res) => {
    try {
      const recherche = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
      const famille = req.query.famille === undefined ? null : catalogueFamily(String(req.query.famille));
      if (req.query.famille !== undefined && !famille) return void res.status(400).json({ error: 'Famille de catalogue inconnue.' });
      const filtre = { actif: true, ...(recherche ? { OR: [{ reference: { contains: recherche, mode: 'insensitive' as const } }, { nom: { contains: recherche, mode: 'insensitive' as const } }] } : {}) };
      const familles = famille ? [famille] : (['prestations', 'articles', 'equipements'] as CatalogueFamily[]);
      const voitPrixAchat = voitPrixAchatDevis(req);
      const fiches = (await Promise.all(familles.map(async (f) => {
        const lignes = await (catalogueModels[f] as unknown as { findMany: (args: unknown) => Promise<Record<string, unknown>[]> })
          .findMany({ where: filtre, orderBy: { nom: 'asc' }, take: 50 });
        return lignes.map((fiche) => ({
          famille: f, id: fiche.id, reference: fiche.reference, nom: fiche.nom,
          unite: (fiche.unite as string | undefined) ?? null, nature: NATURE_DEVIS_PAR_FAMILLE[f],
          prixVenteHt: fiche.prixVenteHt, tauxTva: fiche.tauxTva,
          ...(voitPrixAchat ? { prixAchatHt: fiche.prixAchatHt ?? null } : {}),
        }));
      }))).flat().sort((a, b) => String(a.nom).localeCompare(String(b.nom), 'fr')).slice(0, 50);
      res.json(decimalToNumber(fiches));
    } catch {
      res.status(500).json({ error: 'Lecture du catalogue impossible.' });
    }
  });

  routeMixte('get', '/devis', 'devis:read', listerDevis, [requirePermission('devis:read')]);
  routeMixte('post', '/devis', 'devis:write', creerDevis, [requirePermission('devis:write')]);
  routeMixte('patch', '/devis/:id', 'devis:write', modifierDevis, [requirePermission('devis:write')]);
  routeMixte('post', '/devis/:id/revisions', 'devis:write', creerRevision, [requirePermission('devis:write')]);
  // La signature engage une personne identifiée : aucune clé d'intégration ne peut l'émettre.
  app.post('/api/devis/:id/signature', requireAuth, requirePermission('devis:write'), signerDevis);

  routeMixte('put', '/devis/:id/statut', 'devis:write', changerStatutDevis, [requirePermission('devis:write')]);

  routeMixte('post', '/devis/:id/convertir', 'devis:write', convertirDevis, [requirePermission('devis:write')]);

  // Devis qui peuvent ouvrir leur chantier : mêmes conditions que la conversion ci-dessus (accepté,
  // signé, acompte constaté s'il est exigé, dernière version non annulée de son dossier, aucune
  // version du dossier déjà convertie, référence d'affaire portée par aucun chantier). Ils
  // alimentent le formulaire « Ouvrir le chantier d'une affaire » de l'Administration. Réservé à
  // l'interface, comme le formulaire.
  app.get('/api/devis/a-convertir', requireAuth, requirePermission('devis:read'), requirePermission('devis:write'), async (_req, res) => { try {
    const candidats = await prisma.devis.findMany({
      where: { statut: 'ACCEPTE', signature: { isNot: null }, conversion: { is: null }, OR: [{ acompteExige: false }, { acompteRecuLe: { not: null } }] },
      select: { id: true, dossierId: true, numero: true, version: true, objet: true, totalHt: true, client: { select: { id: true, raisonSociale: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const versions = await prisma.devis.groupBy({
      by: ['dossierId'], where: { dossierId: { in: candidats.map(d => d.dossierId) }, statut: { not: 'ANNULE' } }, _max: { version: true },
    });
    const derniere = new Map(versions.map(v => [v.dossierId, v._max.version]));
    const dossiersConvertis = new Set((await prisma.devisConversion.findMany({
      where: { dossierId: { in: candidats.map(d => d.dossierId) } }, select: { dossierId: true },
    })).map(c => c.dossierId));
    const referencesPrises = new Set((await prisma.chantier.findMany({
      where: { numeroDevis: { in: candidats.map(d => d.numero) } }, select: { numeroDevis: true },
    })).map(c => c.numeroDevis));
    res.json(decimalToNumber(candidats.filter(d => derniere.get(d.dossierId) === d.version
      && !dossiersConvertis.has(d.dossierId) && !referencesPrises.has(d.numero))));
  } catch (error) { devisErreur(res, error); } });

  // --- Constatation de l'acompte ---
  // Tant que le module paiements (phase 9) n'existe pas, la réception d'un acompte se
  // constate à la main : date, montant et référence du règlement, par un administrateur.
  // Le rapprochement bancaire alimentera ces mêmes champs plus tard sans changer la règle.
  // Réservée aux administrateurs : constater un encaissement débloque l'ouverture d'un
  // chantier, ce n'est pas un geste que celui qui a vendu l'affaire se rend à lui-même.
  app.post('/api/devis/:id/acompte', requireAuth, requireAdmin, async (req, res) => { try {
    // Sous le verrou du devis, comme son statut, qu'il peut faire passer à « accepté ».
    const maj = await transactionVerifiee(async tx => {
      if (!await verrouillerDevis(tx, paramId(req))) return null;
      const devis = await tx.devis.findUniqueOrThrow({ where: { id: paramId(req) } });
      if (devis.statut === 'ANNULE') throw new DevisSaisieError('Ce devis est annulé.');
      if (!devis.acompteExige) throw new DevisSaisieError('Ce devis n’exige pas d’acompte.');
      if (devis.acompteRecuLe) throw new DevisSaisieError('L’acompte de ce devis a déjà été constaté.');

      const recuLe = dateIsoStricte((req.body ?? {}).recuLe);
      if (!recuLe) throw new DevisSaisieError('La date de réception doit être valide au format JJ-MM-AAAA.');
      const montant = nombreDecimalNonNegatif((req.body ?? {}).montant, 10);
      if (montant === null) throw new DevisSaisieError('Le montant de l’acompte doit être un nombre strictement positif.');
      const reference = String((req.body ?? {}).reference ?? '').trim();
      if (!reference) throw new DevisSaisieError('La référence du règlement est requise.');

      return tx.devis.update({
        where: { id: devis.id },
        data: {
          acompteRecuLe: recuLe, acompteMontant: montant, acompteReference: reference,
          acompteConstateParId: (req as AuthRequest).user!.id,
          // Constater l'acompte remet le devis en état d'être converti.
          statut: devis.statut === 'EN_ATTENTE_ACOMPTE' ? 'ACCEPTE' : devis.statut,
        },
        include: devisInclude,
      });
    });
    if (!maj) return void res.status(404).json({ error: 'Devis introuvable.' });
    res.json(devisPourLecteur(req, decimalToNumber(maj)));
  } catch (error) { devisErreur(res, error); } });

  // --- Annulation d'un devis, et archivage du chantier qui en est issu ---
  // C'est le SEUL chemin qui revient sur une affaire ouverte par erreur : un chantier ne se
  // supprime plus (cf. DELETE /api/chantiers/:id). Réservée aux administrateurs, elle exige
  // un motif, et elle est refusée dès qu'une heure ou un achat a été saisi sur le chantier —
  // à ce stade l'affaire a commencé à vivre, on ne l'efface pas, on la mène à son terme.
  //
  // Le chantier n'est pas détruit mais archivé : il sort des listes, des coûts, des marges et
  // des commissions, et conserve la raison de son annulation. Une annulation ne s'annule pas ;
  // la reprise passe par la duplication du devis (cf. POST /devis/:id/duplication).
  app.post('/api/devis/:id/annulation', requireAuth, requireAdmin, async (req, res) => { try {
    const motif = String((req.body ?? {}).motif ?? '').trim();
    if (!motif) throw new DevisSaisieError('Un motif d’annulation est obligatoire.');

    const resultat = await transactionVerifiee(async tx => {
      // Verrou du devis d'abord, comme la conversion : une annulation concurrente d'une conversion
      // attend sa fin et archive alors le chantier ouvert, au lieu d'annuler le devis en laissant
      // son chantier en cours. Le chantier, lui, n'est verrouillé que par sa mise à jour, après le
      // comptage des saisies (course avec une saisie simultanée, non corrigée : constat « Saisie sur
      // un chantier pendant l'annulation de son devis » de docs/ROADMAP-PASSATION.md).
      if (!await verrouillerDevis(tx, paramId(req))) throw new DevisSaisieError('Devis introuvable.');
      const devis = await tx.devis.findUnique({ where: { id: paramId(req) }, include: { conversion: true } });
      if (!devis) throw new DevisSaisieError('Devis introuvable.');
      if (devis.statut === 'ANNULE') throw new DevisSaisieError('Ce devis est déjà annulé.');
      // L'intervention ou le contrat créé depuis le devis vit sa propre vie : le devis, trace de la
      // vente, ne s'annule plus (choix par défaut, à confirmer).
      if (devis.conversion?.cibleType === 'INTERVENTION') throw new DevisConflitError('Ce devis a créé une intervention : il ne s’annule plus. Annulez l’intervention depuis sa fiche si elle ne doit pas avoir lieu.');
      if (devis.conversion?.cibleType === 'CONTRAT') throw new DevisConflitError('Ce devis a créé un contrat de maintenance : il ne s’annule plus. Suspendez ou terminez le contrat depuis la liste des contrats.');

      let chantierArchive: string | null = null;
      if (devis.conversion?.cibleType === 'CHANTIER') {
        const chantierId = devis.conversion.cibleId;
        // Le verrou porte sur les écritures VIVANTES : une ligne déjà archivée n'engage rien.
        const [heures, achats] = await Promise.all([
          tx.pointageHeure.count({ where: { chantierId, archivedAt: null } }),
          tx.achatReel.count({ where: { chantierId, archivedAt: null } }),
        ]);
        if (heures > 0 || achats > 0) {
          throw new DevisConflitError(
            `Annulation impossible : ce chantier porte déjà ${heures} pointage(s) d’heures et ${achats} achat(s). Une affaire commencée ne s’annule pas.`,
          );
        }
        await tx.chantier.update({
          where: { id: chantierId },
          data: { statut: 'ANNULE', annuleLe: new Date(), annuleParId: (req as AuthRequest).user!.id, motifAnnulation: motif },
        });
        chantierArchive = chantierId;
      }

      const maj = await tx.devis.update({
        where: { id: devis.id },
        data: { statut: 'ANNULE', annuleLe: new Date(), annuleParId: (req as AuthRequest).user!.id, motifAnnulation: motif },
        include: devisInclude,
      });
      return { devis: maj, chantierArchive };
    });
    res.json({ devis: devisPourLecteur(req, decimalToNumber(resultat.devis)), chantierArchive: resultat.chantierArchive });
  } catch (error) { devisErreur(res, error); } });

  // --- Duplication ---
  // Reprend un devis à l'identique — client, objet, lignes, option d'acompte — avec son
  // PROPRE numéro d'affaire et un dossier neuf. C'est la voie de reprise après une annulation :
  // on ne ressuscite pas un devis annulé, on en refait un. Le duplicata repart en BROUILLON,
  // donc à renvoyer et à faire réaccepter : dupliquer ne contourne pas l'accord du client.
  // Le lien vers l'origine évite de retrouver deux devis jumeaux sans savoir lequel remplace
  // l'autre. Le taux d'acompte est relu depuis les paramètres du jour : un duplicata est un
  // devis neuf, il suit la politique en vigueur au moment où il est émis.
  // La source est lue sous son verrou, dans la transaction qui crée le duplicata, comme pour une
  // révision : une modification en cours est attendue puis copiée en entier, lignes et totaux.
  // Le taux et le numéro d'affaire sont lus avant, sur le client global : pendant la transaction,
  // chaque appel réclamerait une seconde connexion du pool en gardant la première, et des
  // duplications simultanées l'épuiseraient. Un devis introuvable ne consomme pas de numéro.
  app.post('/api/devis/:id/duplication', requireAuth, requirePermission('devis:write'), async (req, res) => { try {
    if (!await prisma.devis.findUnique({ where: { id: paramId(req) }, select: { id: true } })) return void res.status(404).json({ error: 'Devis introuvable.' });
    const { tauxAcompteDefaut } = await getParametres();
    const numero = await nouveauNumeroDevis();
    const duplicata = await transactionVerifiee(async tx => {
      if (!await verrouillerDevis(tx, paramId(req))) return null;
      const source = await tx.devis.findUniqueOrThrow({ where: { id: paramId(req) }, include: devisInclude });
      return tx.devis.create({
        data: {
          dossierId: crypto.randomUUID(), numero, version: 1,
          clientId: source.clientId, objet: source.objet,
          totalHt: source.totalHt, totalTva: source.totalTva, totalTtc: source.totalTtc,
          acompteExige: source.acompteExige,
          tauxAcompte: source.acompteExige ? tauxAcompteDefaut : null,
          origineDevisId: source.id,
          lignes: { create: source.lignes.map(copieLigneDevis) },
        },
        include: devisInclude,
      });
    });
    if (!duplicata) return void res.status(404).json({ error: 'Devis introuvable.' });
    res.status(201).json(devisPourLecteur(req, decimalToNumber(duplicata)));
  } catch (error) { devisErreur(res, error); } });
}
