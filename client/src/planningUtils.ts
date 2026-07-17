// Types et fonctions partagés entre la page admin (Planning.tsx) et la page publique en
// lecture seule (PlanningPublic.tsx) : mêmes affectations, mêmes règles d'affichage
// (libellé, couleur, badge de créneau) des deux côtés — un seul endroit à maintenir.

export interface Intervenant { id: string; nom: string; role?: string }
export interface ChantierLite { id?: string; nom: string; client: string; statut?: string }
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
  typeEventId?: string | null;
  typeEvent: PlanningType | null;
  commentaire: string | null;
  intervenants: Intervenant[];
}

// --- Aides dates (le planning raisonne en jours "YYYY-MM-DD", jamais en heures) ---

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function mondayOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay(); // 0 = dimanche
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
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

export function tooltipEvent(ev: PlanningEvent): string {
  const lignes = [libelleEvent(ev)];
  const client = ev.categorie === 'CHANTIER' ? ev.chantier?.client : ev.client;
  if (client) lignes.push(`Client : ${client}`);
  const debut = ev.dateDebut.slice(0, 10);
  const fin = ev.dateFin.slice(0, 10);
  lignes.push(debut === fin ? `Le ${formatFr(debut)}` : `Du ${formatFr(debut)} au ${formatFr(fin)}`);
  const badge = badgeCreneau(ev);
  if (badge) lignes.push(badge);
  lignes.push(`Technicien(s) : ${ev.intervenants.map((i) => i.nom).join(', ')}`);
  if (ev.commentaire) lignes.push(ev.commentaire);
  return lignes.join('\n');
}
