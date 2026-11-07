import { Link } from 'react-router-dom';
import { texteCible, type ConversionEnregistree } from '../lib/ciblesDevis';

// Ce que le devis a créé (lot 4 suite : jusqu'à deux cibles), une ligne par cible. Chaque lien n'est montré
// qu'à qui lit sa cible : la fiche d'un chantier ou d'une intervention à qui lit toutes les affaires
// (`litTout`, cf. litToutesLesAffaires : administration et assistante technique), la liste des contrats à
// qui les gère (`gereContrats`, cf. gereLesContrats : les mêmes). Hors de son périmètre, un autre porteur du
// droit devis tomberait sur une fiche « introuvable » ou un écran fermé. Une intervention annulée avec le
// devis n'a plus de fiche (choix par défaut, à confirmer : pas de lien).
export function CiblesDuDevis({ conversions, annule, litTout, gereContrats }: { conversions: ConversionEnregistree[]; annule: boolean; litTout: boolean; gereContrats: boolean }) {
  return <>{conversions.map(c => {
    const avecLien = c.cibleType === 'CONTRAT' ? gereContrats : litTout && !(annule && c.cibleType === 'INTERVENTION');
    const lien = c.cibleType === 'CHANTIER' ? <Link to={`/chantiers/${c.cibleId}`} aria-label="voir la fiche du chantier" className="underline font-semibold">voir la fiche</Link>
      : c.cibleType === 'INTERVENTION' ? <Link to={`/interventions/${c.cibleId}`} aria-label="voir la fiche de l’intervention" className="underline font-semibold">voir la fiche</Link>
      : <Link to="/contrats-maintenance" className="underline font-semibold">voir les contrats</Link>;
    return <p key={c.cibleType} className={`text-sm ${annule ? 'text-gray-600' : 'text-green-700'}`}>{texteCible(c.cibleType, annule)}{avecLien ? <> : {lien}</> : '.'}</p>;
  })}</>;
}
