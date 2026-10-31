import { apiFetch } from '../api';

// Télécharge le PDF d'un document (devis, facture, avoir, contrat de maintenance) sous le nom donné.
// Un refus du serveur est levé avec son message, ou « Document indisponible. » sans corps JSON
// (passerelle, proxy) : rien n'est alors téléchargé. Commun aux boutons « PDF » et à l'envoi par la
// messagerie (lot 6a-3), qui télécharge le même fichier, à joindre à la main.
export async function telechargerPdf(chemin: string, nomFichier: string): Promise<void> {
  const res = await apiFetch(chemin);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Document indisponible.');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = nomFichier; a.click();
  URL.revokeObjectURL(url);
}

// Nom du fichier du PDF d'un contrat de maintenance (lot 6a-4b), calculé comme celui que donne le
// serveur (server/src/domaines/contrats/document.ts) : l'intitulé réduit aux lettres sans accent, aux
// chiffres, au tiret et au tiret bas, toute autre suite de caractères devenant un tiret, sans tiret en
// tête ni en fin ; l'identifiant du contrat si rien n'en reste.
export function nomFichierContrat(contrat: { id: string; titre: string }): string {
  const intitule = contrat.titre.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return `Contrat-${intitule || contrat.id}.pdf`;
}
