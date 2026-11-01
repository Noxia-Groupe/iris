import type { Express, RequestHandler } from 'express';
import type { Prisma } from '@prisma/client';
import { transactionVerifiee } from '../../db';
import { ROLE_TECHNICIEN } from '../../droits/roles';
import { requirePermission } from '../../droits/permissions';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { blockCommercial } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { IdentiteEmetteurIncompleteError } from '../documents/identite';
import {
  SaisieEnvoiInvalideError, lireDemandeEnvoi, lireEnvois, propositionDestinataire, refusEnvoi, repondreEnvoi, texteEnvoiCompteRendu,
} from '../documents/envois';
import { envoyerDocument, propositionMicrosoft365 } from '../documents/envoiMicrosoft365';
import { getInterventionFilterForUser } from './metier';
import { interventionDansPerimetre, verrouillerIntervention } from './comptesRendus';
import { lireCompteRenduPdf, rendreFichierCompteRenduPdf } from './productionPdf';

// --- Envoi du compte rendu d'intervention par la messagerie de l'utilisateur (lot 6a-4d) ---
//
// Sur le modèle du lot 6a-3 (cf. documents/envois.ts) : le PDF du compte rendu (lot 6a-4a) est
// téléchargé par l'écran, puis l'envoi est enregistré au journal des envois, puis la messagerie s'ouvre
// avec le destinataire, l'objet et le texte remplis. Depuis le lot 6b-1b, l'envoi peut aussi être fait
// par Microsoft 365 (documents/envoiMicrosoft365.ts), avec le PDF produit par Iris, sous les mêmes
// gardes et la même préparation. Un envoi ne change aucun statut.
//
// En session seulement, sans clé d'intégration ni route /api/v1. Mêmes gardes que le PDF : le
// technicien est refusé (403) avant tout périmètre, puis le périmètre SAV de la fiche s'applique. La
// lecture (proposition et journal) et l'enregistrement sont ouverts aux mêmes comptes, qui peuvent déjà
// modifier l'intervention dans ce périmètre, et exigent en plus le droit clients:read, en permission
// effective : le destinataire proposé et le journal exposent des courriels du client, que le PDF
// n'imprime pas (choix par défaut, le plus restrictif, à confirmer). Le lot D1 nommera la permission
// d'envoi.
//
// Ordre des contrôles, comme le lot 6a-3 et le PDF : gardes et refus du technicien (403), droit
// clients:read (403), destinataire ou canal (400), introuvable ou hors périmètre (404), annulée (409, à
// l'enregistrement seulement), sans compte rendu (409), identité de la société incomplète (409) ; puis,
// pour Microsoft 365 seulement, ses propres refus (documents/envoiMicrosoft365.ts).

class RefusEnvoiCompteRendu extends Error {
  constructor(readonly statut: 404 | 409, message: string) { super(message); }
}
const INTROUVABLE = 'Intervention introuvable.';
const SANS_COMPTE_RENDU = 'Aucun compte rendu à envoyer.';
const introuvable = () => new RefusEnvoiCompteRendu(404, INTROUVABLE);
const sansCompteRendu = () => new RefusEnvoiCompteRendu(409, SANS_COMPTE_RENDU);

const refuserTechnicien: RequestHandler = (req, res, next) => {
  if ((req as AuthRequest).user?.role === ROLE_TECHNICIEN) return void res.status(403).json({ error: 'L’envoi du compte rendu n’est pas ouvert au technicien.' });
  next();
};

function repondreErreur(res: Parameters<RequestHandler>[1], error: unknown, contexte: string, message: string) {
  if (error instanceof RefusEnvoiCompteRendu) return void res.status(error.statut).json({ error: error.message });
  if (error instanceof SaisieEnvoiInvalideError) return void res.status(400).json({ error: error.message });
  if (error instanceof IdentiteEmetteurIncompleteError) return void res.status(409).json({ error: error.message });
  console.error(contexte, error);
  res.status(500).json({ error: message });
}

// Lecture : destinataire, objet et texte proposés, et envois déjà préparés, du plus récent au plus
// ancien, dans une même photo de la base ; microsoft365 : l'envoi par Microsoft 365 est proposé (lot
// 6b-1b). Une intervention annulée garde son journal et sa proposition lisibles, comme son journal SAV
// (choix par défaut, à confirmer) ; sa fiche étant introuvable, l'écran n'affiche pas de bouton
// « Envoyer ».
const lireEnvoisCompteRendu: RequestHandler = async (req, res) => {
  try {
    const user = (req as AuthRequest).user!;
    const lu = await transactionVerifiee(async (tx) => {
      const intervention = await tx.intervention.findFirst({
        where: { AND: [{ id: paramId(req) }, getInterventionFilterForUser(user)] },
        select: { id: true, reference: true, clientId: true, _count: { select: { rapports: true } } },
      });
      if (!intervention) throw introuvable();
      if (!intervention._count.rapports) throw sansCompteRendu();
      const { objet, corps } = await texteEnvoiCompteRendu(tx, intervention);
      return { proposition: { destinataire: await propositionDestinataire(tx, intervention.clientId), objet, corps, microsoft365: await propositionMicrosoft365(tx) }, envois: await lireEnvois(tx, { interventionId: intervention.id }) };
    }, { isolationLevel: 'RepeatableRead' });
    res.json(lu);
  } catch (error) { repondreErreur(res, error, 'Erreur lecture des envois du compte rendu', 'Lecture des envois du compte rendu impossible.'); }
};

// Préparation de l'envoi, commune aux deux canaux. Comme l'ajout d'un compte rendu, l'intervention est
// d'abord cherchée dans le périmètre, puis son verrou partagé est pris, et le périmètre, le statut et
// les comptes rendus sont relus sous ce verrou : une annulation ou un retrait d'affectation en cours,
// qui prend le verrou exclusif, est attendu, puis refuse l'envoi. Une intervention en cours qui porte
// un compte rendu s'envoie, comme elle s'imprime (choix par défaut, à confirmer). Rien n'y est écrit.
export async function preparerEnvoiCompteRendu(tx: Prisma.TransactionClient, id: string, auteur: NonNullable<AuthRequest['user']>) {
  const trouvee = await tx.intervention.findFirst({ where: { AND: [{ id }, getInterventionFilterForUser(auteur)] }, select: { id: true } });
  if (!trouvee) return refusEnvoi(404, INTROUVABLE);
  const statut = await verrouillerIntervention(tx, trouvee.id, 'FOR SHARE');
  if (!statut || !await interventionDansPerimetre(tx, trouvee.id, auteur)) return refusEnvoi(404, INTROUVABLE);
  if (statut === 'ANNULEE') return refusEnvoi(409, 'Une intervention annulée ne s’envoie pas.');
  if (!await tx.interventionRapport.count({ where: { interventionId: trouvee.id } })) return refusEnvoi(409, SANS_COMPTE_RENDU);
  const intervention = await tx.intervention.findUniqueOrThrow({ where: { id: trouvee.id }, select: { reference: true } });
  const { objet, corps } = await texteEnvoiCompteRendu(tx, intervention);
  return { journal: { interventionId: trouvee.id }, objet, corps };
}

// Le PDF envoyé par Microsoft 365 est lu dans la transaction de la préparation, sous son verrou : le
// périmètre SAV et l'exclusion des interventions annulées y sont déjà vérifiés, d'où le périmètre {},
// en toutes lettres (interventions/productionPdf.ts).
const envoiCompteRendu = (id: string, auteur: NonNullable<AuthRequest['user']>) => ({
  preparer: (tx: Prisma.TransactionClient) => preparerEnvoiCompteRendu(tx, id, auteur),
  lirePdf: (tx: Prisma.TransactionClient) => lireCompteRenduPdf(tx, id, {}),
  rendrePdf: rendreFichierCompteRenduPdf,
});

// Enregistrement de l'envoi : préparé par la messagerie (l'écran télécharge le PDF avant cet appel), ou
// fait par Microsoft 365 (lot 6b-1b). Un refus n'écrit rien.
const envoyerCompteRendu: RequestHandler = async (req, res) => {
  try {
    const auteur = (req as AuthRequest).user!;
    repondreEnvoi(res, await envoyerDocument(req as AuthRequest, lireDemandeEnvoi(req.body), envoiCompteRendu(paramId(req), auteur)));
  } catch (error) { repondreErreur(res, error, 'Erreur envoi du compte rendu', 'Enregistrement de l’envoi du compte rendu impossible.'); }
};

export function enregistrerEnvoisCompteRendu(app: Express): void {
  app.get('/api/interventions/:id/envois', requireAuth, blockCommercial, refuserTechnicien, requirePermission('clients:read'), lireEnvoisCompteRendu);
  app.post('/api/interventions/:id/envois', requireAuth, blockCommercial, refuserTechnicien, requirePermission('clients:read'), envoyerCompteRendu);
}
