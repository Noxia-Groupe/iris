import { useState } from 'react';
import { createPortal } from 'react-dom';
import { FileDown, X } from 'lucide-react';
import { getCurrentRole, isAdminRole } from '../roles';
import { nomFichierRapportChantier, telechargerPdf } from '../lib/documentPdf';

// Rapport de chantier remis au client (lot 6a-4c) : PDF produit par le serveur, sans montant ni
// heures, que seule l'administration télécharge (la route le refuse aux autres comptes). Le bouton se
// place dans la barre d'actions de la fiche, hors de la capture du « Rapport interne (PDF) »
// (data-html2canvas-ignore). Un refus du serveur (identité de la société incomplète, chantier
// introuvable) s'affiche en tête de l'écran, hors de la zone capturée, et rien n'est téléchargé.
export function RapportClientChantier({ chantier }: { chantier: { id: string; nom: string } }) {
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);
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
      {erreur && createPortal(
        <div role="alert" data-html2canvas-ignore className="fixed inset-x-4 top-4 z-50 mx-auto flex max-w-2xl items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700 shadow-lg">
          <p className="m-0 flex-1">{erreur}</p>
          <button type="button" onClick={() => setErreur('')} aria-label="Fermer le message" className="shrink-0 rounded p-0.5 hover:bg-red-100">
            <X size={16} aria-hidden="true" />
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
