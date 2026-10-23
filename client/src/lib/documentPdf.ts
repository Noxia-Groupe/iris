import { apiFetch } from '../api';

// Télécharge le PDF d'un document (devis, facture, avoir) sous le nom donné. Un refus du serveur est
// levé avec son message, ou « Document indisponible. » sans corps JSON (passerelle, proxy) : rien
// n'est alors téléchargé. Commun aux boutons « PDF » et à l'envoi par la messagerie (lot 6a-3), qui
// télécharge le même fichier, à joindre à la main.
export async function telechargerPdf(chemin: string, nomFichier: string): Promise<void> {
  const res = await apiFetch(chemin);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Document indisponible.');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = nomFichier; a.click();
  URL.revokeObjectURL(url);
}
