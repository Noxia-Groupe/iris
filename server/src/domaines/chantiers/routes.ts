import express from 'express';
import type { Express } from 'express';
import { Prisma } from '@prisma/client';
import { prisma, transactionVerifiee } from '../../db';
import { ROLE_TECHNICIEN, ROLE_RESPONSABLE, ROLE_DIRECTEUR, isAdminRole } from '../../droits/roles';
import { perimetreChantiers } from '../../droits/perimetres';
import { voitMontantsChantier, voitCoutMainOeuvre, voitPrixAchatDevis, saisieSelonDroits } from '../../droits/visibilite';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { blockCommercial, requireAdmin } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { routeMixte } from '../../http/routes-mixtes';
import { FUSEAU_HORAIRE_PAR_DEFAUT, aujourdHuiEntreprise, dateIsoStricte } from '../../commun/dates';
import { decimalToNumber, sommeExacte, differenceExacte } from '../../commun/montants';
import { nombreDecimalNonNegatif } from '../../commun/validation';
import { getParametres } from '../parametres/metier';
import { getCompanySettings } from '../administration/metier';
import { normaliserNumeroDevis, erreurNumeroDevis, numeroDevisDejaPris } from '../devis/metier';
import { sanitizeTypes, refusTitulaire, refusCommercial, journaliserChangementChantier, compteAuJournal } from './metier';
import {
  voitRentabilite, REFUS_TECHNICIEN_MODIFICATION, REFUS_TECHNICIEN_COMMERCIAL, REFUS_TECHNICIEN_CLOTURE, peutCloturerChantier,
  chantierSelonRentabilite,
} from './droits';
import { contexteSuivi, serializeChantier } from './suivi';
import { avecCoutsSuites } from './coutsSuites';
import { enregistrerEnvoisRapportChantier } from './envois';
import { produirePdf, repondrePdf } from '../documents/productionPdf';
import { lireRapportChantierPdf, rendreFichierRapportChantierPdf } from './productionPdf';

// Champs publics d'un responsable ou d'un commercial rattaché à un chantier : jamais le
// hash de mot de passe, et jamais le rôle non plus — l'application n'en a pas l'usage ici,
// et un commercial rattaché peut être un super administrateur, dont le rôle ne doit pas
// transparaître dans les données d'un chantier renvoyées à un simple administrateur.
const RESPONSABLE_SELECT = { select: { id: true, name: true, email: true } } as const;
// Le rôle du responsable ne sert qu'à décider qui peut clôturer (cf. peutCloturerChantier) :
// il est retiré avant l'envoi, pour ne rien révéler d'un compte au-delà de son nom.
const RESPONSABLE_SELECT_AVEC_ROLE = { select: { id: true, name: true, email: true, role: true } } as const;
// Heures vendues et budgets du chantier (#387) : chiffres permis avant la virgule, ceux de la
// colonne (Decimal(12,2) pour un budget, Decimal(10,2) pour les heures), et message du refus.
const SAISIES_VENDUES: Record<string, { chiffres: number; refus: string }> = {
  budgetGlobalVendu: { chiffres: 10, refus: 'Le budget global doit être un montant positif ou nul, d’au plus 10 chiffres avant la virgule et 2 après.' },
  budgetMaterielVendu: { chiffres: 10, refus: 'Le budget matériel doit être un montant positif ou nul, d’au plus 10 chiffres avant la virgule et 2 après.' },
  budgetMainOeuvreVendu: { chiffres: 10, refus: 'Le budget de main-d’œuvre doit être un montant positif ou nul, d’au plus 10 chiffres avant la virgule et 2 après.' },
  heuresVendues: { chiffres: 8, refus: 'Les heures vendues doivent être un nombre positif ou nul, d’au plus 8 chiffres avant la virgule et 2 après.' },
};
function avecDroitDeCloture<T extends { responsableId: string | null; responsable: { role: string } | null }>(user: AuthRequest['user'], chantier: T) {
  const { responsable, ...reste } = chantier;
  const { role, ...responsableSansRole } = responsable ?? { role: null };
  return {
    ...reste,
    responsable: responsable ? responsableSansRole : null,
    // Sans objet pour une clé d'intégration, qui ne clôture rien : le champ n'est envoyé qu'aux sessions.
    ...(user ? { peutCloturer: peutCloturerChantier(user, { responsableId: chantier.responsableId, responsableRole: role }) } : {}),
  };
}

// Chantiers — un conducteur ne voit que les chantiers dont il est responsable, un
// responsable ceux de sa branche ; un admin ou un directeur voit tout. Un chantier sans
// responsable reste invisible aux conducteurs jusqu'à ce qu'un admin lui en affecte un.
// Le périmètre et le masquage financier viennent des deux mêmes fonctions que les
// journaux d'achats et d'heures : un conducteur voit ses chantiers, un commercial ceux
// qu'il a vendus, une clé d'intégration ce que ses scopes autorisent.
const listerChantiers: express.RequestHandler = async (req, res) => {
  try {
    const params = await getParametres();
    const chantiers = await avecCoutsSuites(await prisma.chantier.findMany({
      where: perimetreChantiers(req),
      include: {
        responsable: RESPONSABLE_SELECT_AVEC_ROLE,
        commercial: RESPONSABLE_SELECT,
        achats: { where: { archivedAt: null } },
        pointages: { where: { archivedAt: null } },
      }
    }));
    // Rentabilité décidée chantier par chantier : un responsable la voit sur ceux de sa
    // branche, pas forcément sur tous ceux de sa liste (cf. voitRentabilite).
    const visibles = chantiers.map((c) => voitRentabilite(req, c, params));
    const contexte = await contexteSuivi(params.margeCommercialeActive && visibles.some(Boolean));
    const montantsVisibles = voitMontantsChantier(req);
    const user = (req as AuthRequest).user;
    const coutMainOeuvreVisible = voitCoutMainOeuvre(req);
    const prixAchatVisible = voitPrixAchatDevis(req);
    res.json(chantiers.map((c: any, i) => serializeChantier(avecDroitDeCloture(user, c), params, visibles[i], contexte, montantsVisibles, coutMainOeuvreVisible, prixAchatVisible)));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching chantiers' });
  }
};

// Update Chantier (pour le statut, le budget, etc.) — champs en liste blanche (anti mass-assignment).
// Ouvert aux conducteurs de travaux sur LEURS chantiers : ils corrigent eux-mêmes un nom, une
// date, un budget ou un devis mal saisi, comme le ferait un administrateur, sans avoir à en
// solliciter un. Sur un chantier dont il n'est pas responsable, un conducteur reçoit 404 (et
// non 403) : même règle qu'à la lecture, on ne révèle pas l'existence du chantier.
class ChangementClientRefuse extends Error {}

// Sur un chantier, la clôture est le seul geste d'écriture du directeur (décision de Nelson
// du 14-10-2026) : cette route n'exclut que le commercial. Rouvrir reste réservé à
// l'administration.
const blockCommercialSeulement: express.RequestHandler = (req, res, next) => {
  if ((req as AuthRequest).user?.role === 'COMMERCIAL') {
    res.status(403).json({ error: 'Accès non autorisé pour un compte commercial.' });
    return;
  }
  next();
};

// Rapport de chantier remis au client (lot 6a-4c), sans montant ni heures (réponse de Nelson du
// 31-10-2026). Réservé à l'administration, en session seulement, sans route /api/v1 (choix par défaut,
// le plus restrictif, à confirmer) : il réunit le chantier et les comptes rendus de ses interventions,
// qui n'ont pas les mêmes lecteurs. Refus, sans rien écrire : 404 pour un chantier introuvable ; 409 si
// l'identité de la société est incomplète. Le chantier, ses interventions, leurs comptes rendus et
// signatures, l'identité de la société et son fuseau sont lus dans un même instantané (REPEATABLE
// READ), comme les PDF du compte rendu et du contrat. Un chantier annulé s'imprime, avec la mention.
// Le PDF est lu puis rendu par chantiers/productionPdf.ts (lot 6b-1a), le rendu après la transaction.
const imprimerRapportChantier: express.RequestHandler = async (req, res) => {
  try {
    repondrePdf(res, await produirePdf((tx) => lireRapportChantierPdf(tx, paramId(req)), rendreFichierRapportChantierPdf, { isolationLevel: 'RepeatableRead' }));
  } catch (error) {
    console.error('Chantier, rapport client PDF :', error);
    res.status(500).json({ error: 'Impression du rapport de chantier impossible.' });
  }
};

export function enregistrerRoutesChantiers(app: Express): void {
  // Ouverte à tous les rôles, comme les journaux : le périmètre fait le tri.
  routeMixte('get', '/chantiers', 'chantiers:read', listerChantiers, []);

  // Détail d'un chantier : mêmes métriques que la liste, enrichies des relations
  // nécessaires aux répartitions (achats par catégorie/fournisseur, heures par
  // intervenant) et triées de la plus récente à la plus ancienne pour les journaux.
  app.get('/api/chantiers/:id', requireAuth, async (req, res) => {
    try {
      const authUser = (req as AuthRequest).user!;
      const isAdmin = isAdminRole(authUser.role);
      const params = await getParametres();
      const chantier = await prisma.chantier.findUnique({
        where: { id: paramId(req) },
        include: {
          responsable: RESPONSABLE_SELECT_AVEC_ROLE,
          commercial: RESPONSABLE_SELECT,
          achats: { where: { archivedAt: null }, include: { categorie: true, fournisseur: true }, orderBy: { date: 'desc' } },
          pointages: { where: { archivedAt: null }, include: { intervenant: true }, orderBy: { date: 'desc' } },
          // Toute facture numérotée reste rattachée à son affaire ; son statut décrit sa
          // situation, sans rompre la traçabilité du cycle commercial.
          factures: { where: { statut: { in: ['EMISE', 'REGLEE', 'ANNULEE'] } }, select: { id: true, numero: true, statut: true, type: true, factureOrigineId: true, avoirs: { select: { id: true } }, dateEmission: true, totalHt: true, totalTtc: true, origine: true } },
        }
      });
      // 404 (et non 403) pour un chantier auquel on n'est pas rattaché : on ne révèle pas son existence.
      // Un directeur lit toutes les fiches, comme un administrateur, sans pouvoir les modifier.
      const isOwner = !!chantier && (
        authUser.role === ROLE_DIRECTEUR ||
        chantier.commercialId === authUser.id ||
        chantier.responsableId === authUser.id ||
        (authUser.role === ROLE_RESPONSABLE && !!chantier.responsableId && authUser.equipeIds.includes(chantier.responsableId))
      );
      if (!chantier || (!isAdmin && !isOwner)) {
        return res.status(404).json({ error: 'Chantier introuvable' });
      }
      // Mêmes destinataires que la liste : marge, budget vendu, facturation et estimation pour
      // l'administrateur et ceux que la société a laissés destinataires (cf. voitRentabilite) —
      // pas le commercial, qui a sa propre vue "Résultat commercial" à l'échelle du mois.
      const canSeeMarge = voitRentabilite(req, chantier, params);
      // `serializeChantier` étale son entrée : sortir les factures avant sérialisation
      // évite toute fuite de montants vers les rôles qui ne voient pas la marge.
      const { factures, ...chantierSansFactures } = chantier;
      const [chantierAvecSuites] = await avecCoutsSuites([chantierSansFactures]);
      const contexte = await contexteSuivi(canSeeMarge && params.margeCommercialeActive);
      const detail = serializeChantier(avecDroitDeCloture(authUser, chantierAvecSuites), params, canSeeMarge, contexte, voitMontantsChantier(req), voitCoutMainOeuvre(req), voitPrixAchatDevis(req)) as Record<string, unknown>;
      if (canSeeMarge) {
        // Les montants sont positifs en base : seul le type AVOIR en inverse le sens. Une
        // facture annulée est visible mais ne contribue plus, son avoir la neutralise.
        // Sommes exactes, indépendantes de l'ordre des factures (#198).
        const totalFactureHt = factures.reduce((somme, facture) => {
          if (facture.type === 'AVOIR') return differenceExacte(somme, facture.totalHt);
          if (facture.statut === 'ANNULEE' && !facture.avoirs.length) return somme;
          return sommeExacte(somme, facture.totalHt);
        }, 0);
        detail.facturation = decimalToNumber({ factures, totalFactureHt, resteAFacturerHt: differenceExacte(chantier.budgetGlobalVendu, totalFactureHt) });
      }
      res.json(detail);
    } catch (error) {
      res.status(500).json({ error: 'Error fetching chantier' });
    }
  });

  // Journal append-only des saisies Travaux. Il est lisible uniquement dans le même périmètre
  // que la fiche chantier : une trace ne doit jamais devenir une porte latérale vers une affaire.
  app.get('/api/chantiers/:id/journal-saisies', requireAuth, async (req, res) => {
    try {
      const chantierId = paramId(req);
      const chantier = await prisma.chantier.findFirst({
        where: { id: chantierId, ...perimetreChantiers(req) },
        select: { id: true },
      });
      if (!chantier) return res.status(404).json({ error: 'Chantier introuvable' });
      const entrees = decimalToNumber(await prisma.journalSaisieChantier.findMany({
        where: { chantierId },
        orderBy: { createdAt: 'desc' },
      }));
      // Instantanés relus sans leurs montants pour un technicien : le journal reste intact en base.
      const masquer = saisieSelonDroits(req);
      res.json(entrees.map((entree: any) => ({ ...entree, avant: masquer(entree.avant), apres: masquer(entree.apres) })));
    } catch (error) {
      res.status(500).json({ error: 'Error fetching journal des saisies' });
    }
  });

  // Rapport de chantier remis au client (lot 6a-4c) : administration seule, en session seulement.
  app.get('/api/chantiers/:id/document.pdf', requireAuth, requireAdmin, imprimerRapportChantier);
  // Envoi de ce rapport par la messagerie et journal de ses envois (lot 6a-4e ; cf. envois.ts) :
  // administration seule, en session seulement, comme le PDF.
  enregistrerEnvoisRapportChantier(app);

  // L'ouverture d'une affaire est contractualisée par un devis accepté : la conversion en
  // est la seule porte (cf. POST /api/devis/:id/convertir). Cette route historique ne créait
  // déjà plus rien, sauf si la variable d'environnement ALLOW_LEGACY_DIRECT_CHANTIER était
  // posée — une échappatoire qui permettait de fabriquer une affaire sans devis, donc sans
  // numéro d'affaire, sans montant vendu contrôlé et sans rien à annuler en cas d'erreur.
  // Elle est retirée : il ne reste que le message.
  app.post('/api/chantiers', requireAuth, blockCommercial, (_req, res) => {
    res.status(410).json({ error: 'Un chantier est créé uniquement par conversion d’un devis accepté.' });
  });

  app.patch('/api/chantiers/:id', requireAuth, blockCommercial, async (req, res) => {
    try {
      const authUser = (req as AuthRequest).user!;
      const existant = await prisma.chantier.findUnique({
        where: { id: paramId(req) },
        select: { id: true, clientId: true, numeroDevis: true, responsableId: true, statut: true },
      });
      if (!existant || (!isAdminRole(authUser.role) && existant.responsableId !== authUser.id)) {
        return res.status(404).json({ error: 'Chantier introuvable' });
      }
      // Un technicien consulte l'affaire dont il est chargé, sans pouvoir la modifier
      // (décision de Nelson du 13-10-2026) : le refus le lui dit en clair.
      if (authUser.role === ROLE_TECHNICIEN) {
        return res.status(403).json({ error: REFUS_TECHNICIEN_MODIFICATION });
      }
      // Une affaire annulée est close : la corriger reviendrait à la faire revivre sans que
      // le devis annulé, lui, ait bougé.
      if (existant.statut === 'ANNULE') {
        return res.status(409).json({ error: 'Cette affaire est annulée : elle n’est plus modifiable.' });
      }

      // 'statut' n'est modifiable ici que par un admin : la clôture et surtout la RÉOUVERTURE
      // d'un chantier obéissent à des règles propres (cf. PATCH /api/chantiers/:id/statut, où
      // un conducteur peut clôturer mais jamais rouvrir). L'ouvrir ici les contournerait.
      // Les affaires historiques non appariées par la migration doivent pouvoir être réparées
      // sans modifier leur libellé client historique. Après la première facture, ce lien est figé.
      const allowed = isAdminRole(authUser.role)
        ? ['nom', 'numeroDevis', 'statut', 'responsableId', 'clientId']
        : ['nom', 'numeroDevis', 'responsableId'];
      const numericFields = ['budgetGlobalVendu', 'budgetMaterielVendu', 'budgetMainOeuvreVendu', 'heuresVendues'];
      const dateFields = ['dateDebut', 'dateFin'];

      const data: Record<string, unknown> = {};
      for (const key of allowed) {
        if (key !== 'responsableId' && key !== 'numeroDevis' && key !== 'clientId' && key in req.body) data[key] = req.body[key];
      }
      // Un client renvoyé à l'identique n'est pas un changement : la fiche d'un chantier dont le
      // client a été désactivé depuis reste modifiable (#111). Seul un nouveau client doit être
      // actif, et une affaire déjà facturée n'en change pas.
      // Les refus (affaire annulée ou facturée, interventions rattachées — d'un autre client pour la
      // réparation d'une affaire héritée), le libellé et la trace sont décidés plus bas, dans la
      // transaction de l'enregistrement, sur la ligne verrouillée.
      let cibleClient: { id: string; raisonSociale: string } | null = null;
      if (isAdminRole(authUser.role) && 'clientId' in req.body && String(req.body.clientId || '') !== existant.clientId) {
        cibleClient = await prisma.client.findFirst({ where: { id: String(req.body.clientId || ''), actif: true }, select: { id: true, raisonSociale: true } });
        if (!cibleClient) return res.status(404).json({ error: 'Client introuvable.' });
      }
      // Format et unicité du numéro de devis : mêmes règles qu'à la création, mais appliquées
      // SEULEMENT si le numéro change réellement. Des chantiers antérieurs portent une valeur
      // hors format (deux numéros dans le même champ, pour deux devis d'un même client) : les
      // contrôler à chaque enregistrement interdirait toute autre correction sur ces fiches.
      if ('numeroDevis' in req.body) {
        const numeroDevis = normaliserNumeroDevis(req.body.numeroDevis);
        if (numeroDevis !== normaliserNumeroDevis(existant.numeroDevis)) {
          const erreurDevis = erreurNumeroDevis(numeroDevis);
          if (erreurDevis) {
            return res.status(400).json({ error: erreurDevis });
          }
          if (await numeroDevisDejaPris(numeroDevis, existant.id)) {
            return res.status(409).json({ error: `Le devis ${numeroDevis} est déjà rattaché à un autre chantier.` });
          }
          data.numeroDevis = numeroDevis;
        }
      }
      // Un chantier doit toujours avoir un responsable (les conducteurs ne voient que
      // leurs chantiers) : on interdit de le vider, et on vérifie qu'il existe.
      if ('responsableId' in req.body) {
        const responsableId = String(req.body.responsableId || '');
        const refus = await refusTitulaire(responsableId, existant.responsableId);
        if (refus) return res.status(400).json({ error: refus });
        data.responsableId = responsableId;
      }
      // Le montant vendu ne se corrige que par qui le voit : un conducteur à qui la société a
      // retiré la rentabilité ne peut pas l'écraser à l'aveugle.
      if ('budgetGlobalVendu' in req.body && !voitRentabilite(req, existant, await getParametres())) {
        return res.status(403).json({ error: 'Le montant vendu n’est modifiable que par qui suit la rentabilité de ce chantier.' });
      }
      // Heures vendues et budgets (#387) : même règle que les achats et les heures du chantier.
      // Une saisie hors forme est refusée, jamais arrondie ni ramenée à 0, et rien n'est écrit ;
      // le premier champ refusé, dans l'ordre de numericFields, donne le message.
      for (const key of numericFields) {
        if (!(key in req.body)) continue;
        const { chiffres, refus } = SAISIES_VENDUES[key];
        const valeur = nombreDecimalNonNegatif(req.body[key], chiffres, true);
        if (valeur === null) return res.status(400).json({ error: refus });
        data[key] = valeur;
      }
      for (const key of dateFields) {
        if (key in req.body) {
          if (!req.body[key]) {
            // dateFin est facultative ; la vider explicitement conserve ce comportement.
            if (key === 'dateFin') data[key] = null;
            continue;
          }
          const date = dateIsoStricte(req.body[key]);
          if (!date) return res.status(400).json({ error: `La ${key === 'dateDebut' ? 'date de début' : 'date de fin'} doit être valide au format JJ-MM-AAAA.` });
          data[key] = date;
        }
      }
      // Facultative (contrairement au numéro de devis) : peut être vidée.
      if ('adresse' in req.body) data.adresse = String(req.body.adresse || '').trim() || null;
      if ('types' in req.body) data.types = sanitizeTypes(req.body.types);
      if ('baremeReduit' in req.body) data.baremeReduit = !!req.body.baremeReduit;

      const chantier = await transactionVerifiee(async (tx) => {
        if (cibleClient) {
          // Verrou de la ligne : une intervention créée en même temps sur cette affaire attend la
          // fin du changement, ou le fait refuser si elle s'enregistre d'abord (cf. POST
          // /api/interventions) ; deux changements simultanés se suivent au lieu de se croiser.
          const [verrouille] = await tx.$queryRaw<Array<{ clientId: string | null; client: string; statut: string }>>(Prisma.sql`SELECT "clientId", "client", "statut" FROM "Chantier" WHERE "id" = ${existant.id} FOR UPDATE`);
          // Relu sous verrou : une annulation du devis enregistrée entre-temps clôt l'affaire.
          if (verrouille.statut === 'ANNULE') throw new ChangementClientRefuse('Cette affaire est annulée : elle n’est plus modifiable.');
          if (verrouille.clientId !== cibleClient.id) {
            if (await tx.facture.count({ where: { OR: [
              { chantierId: existant.id },
              { intervention: { is: { chantierId: existant.id } } },
            ] } })) {
              throw new ChangementClientRefuse('Une affaire déjà facturée ne change pas de client.');
            }
            // Tant qu'une intervention SAV est rattachée à une affaire liée, même annulée (elle y
            // resterait rattachée), l'affaire ne change pas de client (décision de Nelson du
            // 16-10-2026), quel que soit le client de l'intervention : des données d'avant #142 et
            // #144 en rattachent d'un ancien client. Seule exception, lecture à confirmer : une
            // affaire héritée sans fiche se répare vers le client de ses interventions, jamais vers
            // un autre.
            if (await tx.intervention.count({ where: { chantierId: existant.id, ...(verrouille.clientId ? {} : { clientId: { not: cibleClient.id } }) } })) {
              throw new ChangementClientRefuse(verrouille.clientId
                ? 'Des interventions SAV sont rattachées à cette affaire : elle ne change pas de client.'
                : 'Des interventions SAV d’un autre client sont rattachées à cette affaire : elle ne peut pas être rattachée à ce client.');
            }
            data.clientId = cibleClient.id;
            // Une réaffectation d'un client à un autre reprend la raison sociale du nouveau client
            // (décision de Nelson du 16-10-2026) : l'en-tête de la fiche et les affichages qui lisent
            // ce libellé suivent le client ; le rattachement d'une intervention SAV, lui, passe par
            // clientId depuis #144. Une affaire héritée sans client lié garde son libellé historique
            // quand on la répare.
            if (verrouille.clientId) data.client = cibleClient.raisonSociale;
            // Trace du changement (décision de Nelson du 16-10-2026), dans la même transaction :
            // sans elle, le changement n'a pas lieu. La raison sociale de chaque fiche est figée à
            // l'acte, à côté du libellé de l'affaire, qui peut en différer.
            const ancienne = verrouille.clientId
              ? await tx.client.findUnique({ where: { id: verrouille.clientId }, select: { raisonSociale: true } })
              : null;
            await journaliserChangementChantier(tx, existant.id, authUser, 'CHANGEMENT_CLIENT',
              { clientId: verrouille.clientId, raisonSociale: ancienne?.raisonSociale ?? null, libelle: verrouille.client },
              { clientId: cibleClient.id, raisonSociale: cibleClient.raisonSociale, libelle: String(data.client ?? verrouille.client) });
          }
        }
        // Réattribution du titulaire (#181) : relue sur la ligne verrouillée, journalisée si elle change.
        if (typeof data.responsableId === 'string') {
          const [ligne] = await tx.$queryRaw<Array<{ responsableId: string | null }>>(Prisma.sql`SELECT "responsableId" FROM "Chantier" WHERE "id" = ${existant.id} FOR UPDATE`);
          if (ligne.responsableId !== data.responsableId) {
            const avant = await compteAuJournal(tx, ligne.responsableId);
            const apres = await compteAuJournal(tx, data.responsableId);
            await journaliserChangementChantier(tx, existant.id, authUser, 'CHANGEMENT_TITULAIRE',
              { responsableId: avant.id, nom: avant.nom }, { responsableId: apres.id, nom: apres.nom });
          }
        }
        return tx.chantier.update({ where: { id: existant.id }, data });
      });
      res.json(await chantierSelonRentabilite(req, chantier));
    } catch (error) {
      if (error instanceof ChangementClientRefuse) return res.status(409).json({ error: error.message });
      res.status(500).json({ error: 'Error updating chantier' });
    }
  });

  // Clôture / réouverture d'un chantier. Un conducteur peut clôturer (uniquement
  // clôturer, uniquement ses propres chantiers en cours) : une fois TERMINE, il ne
  // peut plus y ajouter d'heures ou de dépenses (cf. POST /achats et /heures). Un
  // directeur clôture tout chantier en cours (décision de Nelson du 14-10-2026).
  // Seul un admin peut réouvrir un chantier clôturé (repasser en EN_COURS).
  // Un chantier ne se supprime plus, et ne s'archive pas non plus par lui-même.
  //
  // Il n'existe que par la conversion d'un devis accepté : c'est cette conversion qui vaut
  // validation définitive du devis. Revenir dessus n'est donc pas une opération de chantier
  // mais une opération de devis — l'annulation (cf. POST /api/devis/:id/annulation), qui
  // exige un motif, archive le chantier lié et se refuse dès qu'une heure ou un achat a été
  // saisi. Supprimer le chantier ici court-circuiterait ce contrôle et laisserait le devis
  // converti pointer vers une affaire disparue.
  //
  // La route est conservée pour renvoyer cette explication aux clients existants plutôt
  // qu'un 404 muet.
  app.delete('/api/chantiers/:id', requireAuth, requireAdmin, (_req, res) => {
    res.status(410).json({ error: 'Un chantier ne se supprime pas : annulez le devis dont il est issu (une note explicative est exigée).' });
  });

  app.patch('/api/chantiers/:id/statut', requireAuth, blockCommercialSeulement, async (req, res) => {
    try {
      const authUser = (req as AuthRequest).user!;
      const isAdmin = isAdminRole(authUser.role);
      const nextStatut = req.body.statut;
      if (nextStatut !== 'EN_COURS' && nextStatut !== 'TERMINE') {
        return res.status(400).json({ error: 'Statut invalide.' });
      }

      const chantier = await prisma.chantier.findUnique({ where: { id: paramId(req) }, include: { responsable: { select: { role: true } } } });
      // Clôture par un tiers au chantier : directeur, ou compte Responsable de la branche d'un technicien.
      const clotureParUnTiers = !!chantier && peutCloturerChantier(authUser, { responsableId: chantier.responsableId, responsableRole: chantier.responsable?.role })
        && chantier.responsableId !== authUser.id;
      if (!chantier || (!isAdmin && chantier.responsableId !== authUser.id && !clotureParUnTiers)) {
        return res.status(404).json({ error: 'Chantier introuvable' });
      }
      if (authUser.role === ROLE_TECHNICIEN) {
        return res.status(403).json({ error: REFUS_TECHNICIEN_CLOTURE });
      }
      // On ne rouvre pas, ni ne clôture, une affaire annulée : sa fin est déjà écrite, avec
      // son motif. La sortir de cet état supposerait d'annuler l'annulation, ce qui n'existe pas.
      if (chantier.statut === 'ANNULE') {
        return res.status(409).json({ error: 'Cette affaire est annulée : son statut ne change plus.' });
      }

      if (!isAdmin && (nextStatut !== 'TERMINE' || chantier.statut !== 'EN_COURS')) {
        return res.status(403).json({ error: 'Seul un administrateur peut réouvrir un chantier clôturé.' });
      }

      // La date de clôture sert de mois de rattachement au résultat commercial (CA et marge
      // validés, cf. /api/stats/commerciaux) : on la renseigne automatiquement à la clôture
      // si elle n'a pas déjà été saisie à la main.
      const data: Record<string, unknown> = { statut: nextStatut };
      if (nextStatut === 'TERMINE' && !chantier.dateFin) {
        // `dateFin` est une date-seule : elle doit retenir le jour civil de l'entreprise
        // et rester à minuit UTC, comme toute date métier stockée en base.
        const societe = await getCompanySettings();
        data.dateFin = new Date(`${aujourdHuiEntreprise(societe.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT)}T00:00:00.000Z`);
      }

      const updated = await prisma.chantier.update({ where: { id: chantier.id }, data });
      res.json(await chantierSelonRentabilite(req, updated));
    } catch (error) {
      res.status(500).json({ error: 'Error updating chantier status' });
    }
  });

  // Affectation du commercial sur un chantier déjà créé — modifiable par l'admin ou par
  // le conducteur responsable du chantier (pas par le commercial lui-même, ni par un tiers,
  // ni par un directeur resté responsable d'anciens chantiers : le commercial rattaché
  // alimente les commissions).
  app.patch('/api/chantiers/:id/commercial', requireAuth, blockCommercial, async (req, res) => {
    try {
      const authUser = (req as AuthRequest).user!;
      const isAdmin = isAdminRole(authUser.role);
      const chantier = await prisma.chantier.findUnique({ where: { id: paramId(req) } });
      if (!chantier) {
        return res.status(404).json({ error: 'Chantier introuvable' });
      }
      // Hors de son périmètre, le chantier n'existe pas pour lui : 404, comme pour la
      // modification de la fiche, et non 403, qui en révélerait l'existence.
      if (!isAdmin && chantier.responsableId !== authUser.id) {
        return res.status(404).json({ error: 'Chantier introuvable' });
      }
      if (authUser.role === ROLE_TECHNICIEN) {
        return res.status(403).json({ error: REFUS_TECHNICIEN_COMMERCIAL });
      }

      const commercialId = req.body.commercialId ? String(req.body.commercialId) : null;
      const refus = await refusCommercial(commercialId ?? '', chantier.commercialId);
      if (refus) return res.status(400).json({ error: refus });

      // Réattribution journalisée (#181), comparée sur la ligne verrouillée.
      const updated = await transactionVerifiee(async (tx) => {
        const [ligne] = await tx.$queryRaw<Array<{ commercialId: string | null }>>(Prisma.sql`SELECT "commercialId" FROM "Chantier" WHERE "id" = ${chantier.id} FOR UPDATE`);
        if (ligne.commercialId !== commercialId) {
          const avant = await compteAuJournal(tx, ligne.commercialId);
          const apres = await compteAuJournal(tx, commercialId);
          await journaliserChangementChantier(tx, chantier.id, authUser, 'CHANGEMENT_COMMERCIAL',
            { commercialId: avant.id, nom: avant.nom }, { commercialId: apres.id, nom: apres.nom });
        }
        return tx.chantier.update({
          where: { id: chantier.id },
          data: { commercialId },
          include: { commercial: RESPONSABLE_SELECT },
        });
      });
      res.json(await chantierSelonRentabilite(req, updated));
    } catch (error) {
      res.status(500).json({ error: 'Error updating commercial' });
    }
  });
}

export function enregistrerRoutesAnalyseChantier(app: Express): void {
  // Analyse IA désactivée jusqu'à la phase qui définira périmètre, minimisation des données,
  // consentement et journal d'audit. Il est dangereux de transmettre coûts/marges à un tiers
  // sans ces garanties. La route est conservée seulement pour renvoyer un statut explicite.
  app.post('/api/chantiers/:id/analyze', requireAuth, (_req, res) => {
    res.status(410).json({ error: "L'analyse IA de chantier n'est pas encore disponible." });
  });
}
