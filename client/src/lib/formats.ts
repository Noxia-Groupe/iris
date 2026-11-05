// Formats d'affichage communs à tous les écrans (#205) : montants, heures et jours, toujours en
// français (`fr-FR`), quelle que soit la langue du navigateur. Un écran n'écrit plus son propre
// format : il emploie l'une de ces familles, qui gardent chacune leur texte d'avant #205.
import { formatDateOnly, jourFrancais } from './dateFormatting';
import { arrondiCentime, arrondiEuro } from './montants';

// Montant à l'euro près, moitié vers l'extérieur (#198), suivi d'une espace et de « € » :
// « 1 234 € », « -13 € » ; jamais « -0 € ».
export const fmtEuro = (montant: number) => `${arrondiEuro(montant).toLocaleString('fr-FR')} €`;

// Montant au centime, au format monétaire français, arrondi comme `fmtEuro` (#198) :
// « 1 234,50 € », avec l'espace insécable d'`Intl` avant « € » ; jamais « -0,00 € ».
export const fmtEuroCentime = (montant: number) => arrondiCentime(montant).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

// Forme des documents : le texte des PDF, identique à `formatMontantFacture` du serveur
// (server/src/domaines/factures/metier.ts), deux décimales et une espace ordinaire avant « € » :
// « 45,50 € », « 1 234,50 € ». La mention du devis au temps passé doit rester le texte du PDF.
export const fmtMontantDocument = (montant: number) => `${Number(montant).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

// Nombre d'heures, sans décimale inutile : deux décimales au plus (« 18,75 », « 8 », « 7,5 »),
// ou trois pour le temps passé, compté au millième d'heure.
export const fmtNombreHeures = (heures: number, decimalesMax: 2 | 3 = 2) => Number(heures).toLocaleString('fr-FR', { maximumFractionDigits: decimalesMax });

// Le même nombre suivi de « h » : « 18,75 h », « 8 h ».
export const fmtHeures = (heures: number, decimalesMax: 2 | 3 = 2) => `${fmtNombreHeures(heures, decimalesMax)} h`;

// Jour AAAA-MM-JJ (avec ou sans heure) au format JJ-MM-AAAA ; rien pour un jour absent.
export const toDateFrancaise = (jour: string | null | undefined) => (jour ? jourFrancais(jour) : '');

export const fmtDate = (d: string) => formatDateOnly(d);
