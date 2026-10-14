// Types et fonctions partagés entre la page admin (Planning.tsx) et la page publique en
// lecture seule (PlanningPublic.tsx) : mêmes affectations, mêmes règles d'affichage
// (libellé, couleur, badge de créneau) des deux côtés — un seul endroit à maintenir.

export interface Intervenant { id: string; nom: string; role?: string }
export interface ChantierLite { id?: string; nom: string; client: string; statut?: string; adresse?: string | null }
export interface PlanningType { id: string; nom: string; couleur: string }
export interface PlanningEvent {
  id: string;
  categorie: 'CHANTIER' | 'HORS_CHANTIER' | 'EVENEMENT';
  dateDebut: string;
  dateFin: string;
  creneau: 'JOURNEE' | 'MATIN' | 'APRES_MIDI' | 'HEURES';
  heureDebut: string | null;
  heureFin: string | null;
  chantierId?: string | null;
  chantier: ChantierLite | null;
  titre: string | null;
  client: string | null;
  // Adresse du site : celle du chantier suivi (ev.chantier.adresse) pour categorie
  // CHANTIER, ou celle saisie sur l'affectation elle-même pour categorie HORS_CHANTIER
  // (pas de fiche chantier à côté de laquelle la stocker) — cf. adresseEvent() ci-dessous.
  adresse?: string | null;
  typeEventId?: string | null;
  typeEvent: PlanningType | null;
  commentaire: string | null;
  intervenants: Intervenant[];
}

// --- Aides dates (le planning raisonne en jours "YYYY-MM-DD", jamais en heures) ---
// Les jours sont des dates-seules calculées en UTC, sans l'horloge ni le fuseau du navigateur :
// « aujourd'hui » est le jour de la société (décision de Nelson du 14-10-2026), où que se
// trouve celui qui consulte le planning.

// Lundi de la semaine d'un jour "YYYY-MM-DD".
export function lundiDe(jour: string): string {
  const jourSemaine = new Date(`${jour}T00:00:00Z`).getUTCDay(); // 0 = dimanche
  return shiftDateStr(jour, jourSemaine === 0 ? -6 : 1 - jourSemaine);
}

export function joursDeLaSemaine(lundi: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shiftDateStr(lundi, i));
}

export function estWeekEnd(jour: string): boolean {
  const jourSemaine = new Date(`${jour}T00:00:00Z`).getUTCDay();
  return jourSemaine === 0 || jourSemaine === 6;
}

// Numéro de semaine ISO 8601 (celui du calendrier civil français : la semaine 1 est celle
// qui contient le premier jeudi de l'année, semaines toujours lundi-dimanche), quel que soit
// le jour de la semaine passé.
export function numeroSemaineIso(jour: string): number {
  const x = new Date(`${jour}T00:00:00Z`);
  const jourIso = x.getUTCDay() || 7; // lundi=1 ... dimanche=7
  x.setUTCDate(x.getUTCDate() + 4 - jourIso); // jeudi de cette semaine
  const debutAnnee = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x.getTime() - debutAnnee.getTime()) / 86400000 + 1) / 7);
}

// Décale un jour "YYYY-MM-DD" de n jours (en UTC : pas de surprise de fuseau/DST).
export function shiftDateStr(s: string, n: number): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffJours(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function formatFr(s: string): string {
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

// --- Couleurs des pastilles ---
// Chantier suivi : couleur stable dérivée de l'id (palette fermée) — un même chantier
// garde la même couleur d'une semaine à l'autre. Hors suivi : orange fixe. Événement :
// couleur du type (choisie par l'admin).

export const CHANTIER_COLORS = ['#2563eb', '#0e7490', '#7c3aed', '#047857', '#be185d', '#4f46e5', '#0f766e', '#9333ea'];
export const HORS_CHANTIER_COLOR = '#ea580c';

export function couleurEvent(ev: PlanningEvent): string {
  if (ev.categorie === 'EVENEMENT') return ev.typeEvent?.couleur || '#f59e0b';
  if (ev.categorie === 'HORS_CHANTIER') return HORS_CHANTIER_COLOR;
  const id = ev.chantierId || ev.chantier?.id || ev.chantier?.nom || '';
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return CHANTIER_COLORS[Math.abs(h) % CHANTIER_COLORS.length];
}

// Texte blanc ou foncé selon la luminosité du fond (les couleurs de type sont libres).
export function texteSurCouleur(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 160 ? '#1a1a1a' : '#fff';
}

export function libelleEvent(ev: PlanningEvent): string {
  if (ev.categorie === 'CHANTIER') return ev.chantier?.nom || 'Chantier';
  if (ev.categorie === 'HORS_CHANTIER') return ev.titre || 'Intervention';
  return ev.typeEvent?.nom || 'Événement';
}

export function badgeCreneau(ev: PlanningEvent): string | null {
  if (ev.creneau === 'MATIN') return 'Matin';
  if (ev.creneau === 'APRES_MIDI') return 'Ap. midi';
  if (ev.creneau === 'HEURES') return `${ev.heureDebut}–${ev.heureFin}`;
  return null;
}

// Adresse du site à afficher : celle du chantier suivi pour categorie CHANTIER (source
// unique, cf. Chantier.adresse), celle saisie sur l'affectation pour categorie
// HORS_CHANTIER — jamais d'adresse pour un événement personnalisé.
export function adresseEvent(ev: PlanningEvent): string | null {
  if (ev.categorie === 'CHANTIER') return ev.chantier?.adresse || null;
  if (ev.categorie === 'HORS_CHANTIER') return ev.adresse || null;
  return null;
}

export function tooltipEvent(ev: PlanningEvent): string {
  const lignes = [libelleEvent(ev)];
  const client = ev.categorie === 'CHANTIER' ? ev.chantier?.client : ev.client;
  if (client) lignes.push(`Client : ${client}`);
  const adresse = adresseEvent(ev);
  if (adresse) lignes.push(`Adresse : ${adresse}`);
  const debut = ev.dateDebut.slice(0, 10);
  const fin = ev.dateFin.slice(0, 10);
  lignes.push(debut === fin ? `Le ${formatFr(debut)}` : `Du ${formatFr(debut)} au ${formatFr(fin)}`);
  const badge = badgeCreneau(ev);
  if (badge) lignes.push(badge);
  lignes.push(`Technicien(s) : ${ev.intervenants.map((i) => i.nom).join(', ')}`);
  if (ev.commentaire) lignes.push(ev.commentaire);
  return lignes.join('\n');
}
