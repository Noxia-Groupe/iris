import { jourFrancais, jourSemaineFrancais } from './dateFormatting';

// Coordonnées d'une intervention pour s'y rendre (lot pilote 3b-4) : adresse du site, à défaut celle
// de l'affaire ; téléphone du contact ; créneau planifié (choix par défaut de #253, à confirmer).

export type SiteIntervention = { nom?: string | null; adresse?: string | null; complementAdresse?: string | null; codePostal?: string | null; ville?: string | null };
export type ContactIntervention = { prenom?: string | null; nom: string; telephone?: string | null };
export type Planification = { dateDebut: string; dateFin: string; creneau: string; heureDebut?: string | null; heureFin?: string | null };

const nettoyer = (texte?: string | null) => (texte ?? '').trim();

export function adresseIntervention(intervention: { site?: SiteIntervention | null; chantier?: { adresse?: string | null } | null }): string | null {
  const site = intervention.site;
  if (site && nettoyer(site.adresse)) {
    const commune = [nettoyer(site.codePostal), nettoyer(site.ville)].filter(Boolean).join(' ');
    return [nettoyer(site.adresse), nettoyer(site.complementAdresse), commune].filter(Boolean).join(', ');
  }
  return nettoyer(intervention.chantier?.adresse) || null;
}

export function nomContact(contact: ContactIntervention): string {
  return [nettoyer(contact.prenom), nettoyer(contact.nom)].filter(Boolean).join(' ');
}

// Lien d'appel : le téléphone du contact est un texte libre. Seul son premier numéro (chiffres, espaces,
// points, tirets, parenthèses, « + » initial) passe dans le lien, réduit à ses chiffres : un second numéro
// ou un poste écrit après ne s'y ajoute pas. Le « (0) » d'un numéro international (+33 (0)6…) ne se compose
// pas. Hors de 3 à 15 chiffres (E.164), aucun lien n'est proposé.
export function lienTelephone(telephone?: string | null): string | null {
  const numero = (/\+?\d[\d\s.()-]*/.exec(nettoyer(telephone))?.[0] ?? '').replace(/\(0\)/g, '');
  const chiffres = numero.replace(/\D/g, '');
  if (chiffres.length < 3 || chiffres.length > 15) return null;
  return `tel:${numero.startsWith('+') ? '+' : ''}${chiffres}`;
}

export function libelleCreneau(planification: Planification): string {
  if (planification.creneau === 'MATIN') return 'Matin';
  if (planification.creneau === 'APRES_MIDI') return 'Après-midi';
  if (planification.creneau === 'HEURES' && planification.heureDebut && planification.heureFin) return `${planification.heureDebut}–${planification.heureFin}`;
  return 'Journée';
}

// Jours planifiés, en dates-seules : « mar. 20-10-2026 », ou « du 20-10-2026 au 22-10-2026 ».
export function joursPlanifies(planification: Planification): string {
  const debut = planification.dateDebut.slice(0, 10);
  const fin = planification.dateFin.slice(0, 10);
  return debut === fin ? jourSemaineFrancais(debut) : `du ${jourFrancais(debut)} au ${jourFrancais(fin)}`;
}
