import { useState } from 'react';
import { createPortal } from 'react-dom';
import { FileDown, Mail, X } from 'lucide-react';
import { getCurrentRole, isAdminRole } from '../roles';
import { nomFichierRapportChantier, telechargerPdf } from '../lib/documentPdf';
import EnvoiDocument from './EnvoiDocument';

// Rapport de chantier remis au client (lot 6a-4c) : PDF produit par le serveur, sans montant ni
// heures, que seule l'administration télécharge (la route le refuse aux autres comptes). Le bouton se
// place dans la barre d'actions de la fiche, hors de la capture du « Rapport interne (PDF) »
// (data-html2canvas-ignore). Un refus du serveur (identité de la société incomplète, chantier
// introuvable) s'affiche en tête de l'écran, hors de la zone capturée, et rien n'est téléchargé.
//
// Envoi de ce rapport par la messagerie de l'utilisateur (lot 6a-4e) : un bouton « Envoyer », lui aussi
// réservé à l'administration et hors de la capture, sauf pour un chantier annulé (le serveur refuse son
// envoi, 409). Il ouvre le dialogue commun des envois (EnvoiDocument, chemin /chantiers/:id), avec le
// journal des envois du rapport, dans une fenêtre superposée, rendue par un portail vers document.body,
// donc hors de la fiche et de la zone capturée, et qui défile sur un téléphone. Elle ne se ferme que par
// « Fermer », et non d'un clic à l'extérieur, pour qu'un clic égaré ne fasse pas perdre le lien d'un
// envoi préparé (choix par défaut, à confirmer). Envoyer ne change aucun statut du chantier.
export function RapportClientChantier({ chantier }: { chantier: { id: string; nom: string; statut: string } }) {
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [envoiOuvert, setEnvoiOuvert] = useState(false);
  if (!isAdminRole(getCurrentRole())) return null;

  const telecharger = async () => {
    setErreur('');
    setEnCours(true);
    try {
      await telechargerPdf(`/chantiers/${chantier.id}/document.pdf`, nomFichierRapportChantier(chantier));
    } catch (err) {
      setErreur(err instanceof Error ? err.message : 'Document indisponible.');
    } finally {
      setEnCours(false);
    }
  };

  const ouvrirEnvoi = () => {
    setErreur('');
    setEnvoiOuvert(true);
  };

  return (
    <>
      <button
        type="button"
        data-testid="rapport-client-pdf"
        data-html2canvas-ignore
        onClick={() => void telecharger()}
        disabled={enCours}
        aria-busy={enCours}
        className="flex items-center gap-2 bg-gray-800 text-white px-4 py-2 rounded-lg font-semibold hover:bg-gray-700 transition-colors shadow-sm text-sm disabled:opacity-60"
      >
        <FileDown size={16} /> Rapport client (PDF)
      </button>
      {chantier.statut !== 'ANNULE' && (
        <button
          type="button"
          data-testid="envoyer-rapport-client"
          data-html2canvas-ignore
          aria-label={`Envoyer le rapport de chantier ${chantier.nom}`}
          onClick={ouvrirEnvoi}
          className="flex items-center gap-2 bg-white border border-gray-200 text-gray-700 px-4 py-2 rounded-lg font-semibold hover:bg-gray-50 transition-colors shadow-sm text-sm"
        >
          <Mail size={16} /> Envoyer
        </button>
      )}
      {erreur && createPortal(
        <div role="alert" data-html2canvas-ignore className="fixed inset-x-4 top-4 z-50 mx-auto flex max-w-2xl items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700 shadow-lg">
          <p className="m-0 flex-1">{erreur}</p>
          <button type="button" onClick={() => setErreur('')} aria-label="Fermer le message" className="shrink-0 rounded p-0.5 hover:bg-red-100">
            <X size={16} aria-hidden="true" />
          </button>
        </div>,
        document.body,
      )}
      {envoiOuvert && createPortal(
        <div data-html2canvas-ignore className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-xl">
            <EnvoiDocument
              document={{ libelle: `le rapport de chantier ${chantier.nom}`, chemin: `/chantiers/${chantier.id}`, nomFichier: nomFichierRapportChantier(chantier) }}
              onFermer={() => setEnvoiOuvert(false)}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
