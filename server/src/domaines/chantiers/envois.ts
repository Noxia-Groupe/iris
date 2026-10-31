import type { Express, RequestHandler } from 'express';
import { transactionVerifiee } from '../../db';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { requireAdmin } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { IdentiteEmetteurIncompleteError } from '../documents/identite';
import { DestinataireInvalideError, enregistrerEnvoi, lireEnvois, propositionDestinataire, texteEnvoiRapportChantier, validerDestinataire } from '../documents/envois';

// --- Envoi du rapport de chantier remis au client par la messagerie de l'utilisateur (lot 6a-4e) ---
//
// Sur le modèle de l'envoi du contrat de maintenance (lot 6a-4d) et du lot 6a-3 (cf.
// documents/envois.ts) : le PDF du rapport remis au client (lot 6a-4c, sans montant ni heures) est
// téléchargé par l'écran, puis l'envoi est enregistré au journal des envois, puis la messagerie s'ouvre
// avec le destinataire, l'objet et le texte remplis. Un envoi ne change aucun statut du chantier.
//
// Réservé à l'administration, en session seulement, sans clé d'intégration ni route /api/v1, pour la
// lecture (proposition et journal) comme pour l'enregistrement (choix par défaut, le plus restrictif, à
// confirmer) : c'est la règle du PDF qu'on envoie ; le rapport réunit les comptes rendus de toutes les
// interventions du chantier, hors périmètre SAV ; le destinataire proposé et le journal exposent des
// courriels du client. Le lot D1 nommera la permission d'envoi.
//
// Ordre des contrôles, comme le contrat : gardes (401, 403), destinataire (400, à l'enregistrement),
// introuvable (404), annulé (409, à l'enregistrement seulement), identité de la société incomplète
// (409). Un refus n'écrit rien.

class RefusEnvoiRapportChantier extends Error {
  constructor(readonly statut: 404 | 409, message: string) { super(message); }
}
// Même message que le PDF du rapport (imprimerRapportChantier).
const introuvable = () => new RefusEnvoiRapportChantier(404, 'Chantier introuvable');

function repondreErreur(res: Parameters<RequestHandler>[1], error: unknown, contexte: string, message: string) {
  if (error instanceof RefusEnvoiRapportChantier) return void res.status(error.statut).json({ error: error.message });
  if (error instanceof DestinataireInvalideError) return void res.status(400).json({ error: error.message });
  if (error instanceof IdentiteEmetteurIncompleteError) return void res.status(409).json({ error: error.message });
  console.error(contexte, error);
  res.status(500).json({ error: message });
}

// Destinataire proposé : la règle du lot 6a-3, inchangée, appliquée à la fiche client du chantier. Un
// chantier sans fiche client, qui ne garde que l'ancien libellé, n'en a pas : la saisie reste possible
// (sans objet tant qu'aucune donnée ancienne n'existe : tout chantier converti porte sa fiche client).
const destinatairePropose = (tx: Parameters<typeof propositionDestinataire>[0], clientId: string | null) =>
  clientId ? propositionDestinataire(tx, clientId) : Promise.resolve('');

// Lecture : destinataire, objet et texte proposés, et envois déjà préparés, du plus récent au plus
// ancien, dans une même photo de la base (REPEATABLE READ), comme le contrat. Un chantier annulé garde
// son journal et sa proposition lisibles, comme un contrat annulé ; son PDF reste imprimable, avec la
// mention « CHANTIER ANNULÉ », et l'écran ne lui affiche pas de bouton « Envoyer ».
const lireEnvoisRapportChantier: RequestHandler = async (req, res) => {
  try {
    const lu = await transactionVerifiee(async (tx) => {
      const chantier = await tx.chantier.findUnique({ where: { id: paramId(req) }, select: { id: true, nom: true, clientId: true } });
      if (!chantier) throw introuvable();
      const { objet, corps } = await texteEnvoiRapportChantier(tx, chantier);
      return { proposition: { destinataire: await destinatairePropose(tx, chantier.clientId), objet, corps }, envois: await lireEnvois(tx, { chantierId: chantier.id }) };
    }, { isolationLevel: 'RepeatableRead' });
    res.json(lu);
  } catch (error) { repondreErreur(res, error, 'Chantier, lecture des envois du rapport :', 'Lecture des envois du rapport de chantier impossible.'); }
};

// Enregistrement de l'envoi préparé, sous un verrou partagé du chantier, pris d'abord par une requête
// directe, puis le statut relu dans la transaction : l'annulation d'un devis converti prend FOR NO KEY
// UPDATE sur son chantier (devis/annulation.ts), qu'un FOR SHARE bloque ; une annulation en cours est
// donc attendue, puis refuse l'envoi (409, comme un contrat ou un devis annulés). Un chantier terminé,
// ou sans intervention, s'envoie, avec ce que son PDF imprime (choix par défaut, à confirmer). Un envoi
// ne change aucun statut, et un refus n'écrit rien. L'écran télécharge le PDF avant cet appel.
const envoyerRapportChantier: RequestHandler = async (req, res) => {
  try {
    const destinataire = validerDestinataire(req.body?.destinataire);
    const resultat = await transactionVerifiee(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Chantier" WHERE "id" = ${paramId(req)} FOR SHARE`;
      const chantier = await tx.chantier.findUnique({ where: { id: paramId(req) }, select: { id: true, nom: true, statut: true } });
      if (!chantier) throw introuvable();
      if (chantier.statut === 'ANNULE') throw new RefusEnvoiRapportChantier(409, 'Un chantier annulé ne s’envoie pas.');
      const { objet, corps } = await texteEnvoiRapportChantier(tx, chantier);
      const envoi = await enregistrerEnvoi(tx, { chantierId: chantier.id }, { destinataire, objet }, (req as AuthRequest).user!);
      return { envoi, objet, corps };
    });
    res.status(201).json(resultat);
  } catch (error) { repondreErreur(res, error, 'Chantier, envoi du rapport :', 'Enregistrement de l’envoi du rapport de chantier impossible.'); }
};

export function enregistrerEnvoisRapportChantier(app: Express): void {
  app.get('/api/chantiers/:id/envois', requireAuth, requireAdmin, lireEnvoisRapportChantier);
  app.post('/api/chantiers/:id/envois', requireAuth, requireAdmin, envoyerRapportChantier);
}
