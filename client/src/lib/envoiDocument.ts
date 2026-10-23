// Envoi d'un document par la messagerie de l'utilisateur (lot 6a-3, décision de Nelson du
// 22-10-2026) : un lien mailto ouvre la messagerie avec le destinataire, l'objet et le texte remplis.
// Un tel lien ne joint aucun fichier : le PDF est téléchargé en même temps et joint à la main.

export type EnvoiPrepare = { id: string; canal: string; destinataire: string; objet: string; auteurNom: string; createdAt: string };
export type PropositionEnvoi = { destinataire: string; objet: string; corps: string };

// Objet et texte encodés par encodeURIComponent ; les sauts de ligne du texte deviennent CRLF
// (%0D%0A), comme le demande la RFC 6068. L'adresse est encodée de même, arobase laissée lisible :
// une adresse ordinaire reste telle quelle, et un caractère réservé (?, &, #, %) n'y coupe jamais le
// lien. Le serveur n'enregistre qu'une seule adresse, sans espace ni séparateur.
export function lienMessagerie(destinataire: string, objet: string, corps: string): string {
  const adresse = encodeURIComponent(destinataire).replace(/%40/g, '@');
  return `mailto:${adresse}?subject=${encodeURIComponent(objet)}&body=${encodeURIComponent(corps.replace(/\r?\n/g, '\r\n'))}`;
}
