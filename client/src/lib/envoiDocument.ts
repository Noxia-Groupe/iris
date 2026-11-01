// Envoi d'un document par la messagerie de l'utilisateur (lot 6a-3, décision de Nelson du
// 22-10-2026) : un lien mailto ouvre la messagerie avec le destinataire, l'objet et le texte remplis.
// Un tel lien ne joint aucun fichier : le PDF est téléchargé en même temps et joint à la main.

// Une ligne du journal des envois. canal : MESSAGERIE (envoi préparé) ou MICROSOFT_365 (envoi fait, lot
// 6b-1b), avec alors l'expéditeur, la boîte Microsoft d'envoi ; null pour la messagerie.
export type EnvoiPrepare = { id: string; canal: string; destinataire: string; objet: string; expediteur?: string | null; auteurNom: string; createdAt: string };
// Proposition de l'envoi (GET …/envois). microsoft365 : l'envoi par Microsoft 365 est proposé (mode
// d'envoi MICROSOFT_365 et connexion Microsoft configurée, lot 6b-1b).
export type PropositionEnvoi = { destinataire: string; objet: string; corps: string; microsoft365?: boolean };
// Réponse à l'enregistrement d'un envoi. Celle d'un devis porte aussi son statut après l'envoi : un
// brouillon passe « envoyé » (lot 6a-3 bis, décision de Nelson du 23-10-2026). Celle d'un envoi par
// Microsoft 365 porte aussi l'expéditeur.
export type EnvoiEnregistre = { envoi: EnvoiPrepare; objet: string; corps: string; statutDevis?: string; expediteur?: string };

// Objet et texte encodés par encodeURIComponent ; les sauts de ligne du texte deviennent CRLF
// (%0D%0A), comme le demande la RFC 6068. L'adresse est encodée de même, arobase laissée lisible :
// une adresse ordinaire reste telle quelle, et un caractère réservé (?, &, #, %) n'y coupe jamais le
// lien. Le serveur n'enregistre qu'une seule adresse, sans espace ni séparateur.
export function lienMessagerie(destinataire: string, objet: string, corps: string): string {
  const adresse = encodeURIComponent(destinataire).replace(/%40/g, '@');
  return `mailto:${adresse}?subject=${encodeURIComponent(objet)}&body=${encodeURIComponent(corps.replace(/\r?\n/g, '\r\n'))}`;
}
