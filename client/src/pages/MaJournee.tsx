import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays } from 'lucide-react';
import { apiFetch } from '../api';
import { CoordonneesIntervention } from '../components/CoordonneesIntervention';
import { jourSemaineFrancais } from '../lib/dateFormatting';
import { type ContactIntervention, type Planification, type SiteIntervention } from '../lib/intervention';
import { shiftDateStr } from '../planningUtils';

// « Ma journée » du technicien (lot pilote 3b-4) : ses interventions du jour, au jour civil de la
// société calculé par le serveur, puis la fiche de chacune pour agir.

type InterventionJournee = {
  id: string; reference: string; titre: string; statut: string; priorite: string;
  client: { raisonSociale: string };
  site?: SiteIntervention | null; contact?: ContactIntervention | null; chantier?: { adresse?: string | null } | null;
  planningEvent?: Planification | null;
};
type Journee = { jour: string; aujourdhui: string; aFaire: InterventionJournee[]; resteesOuvertes: InterventionJournee[]; terminees: InterventionJournee[] };

const libelleStatut: Record<string, string> = { A_PLANIFIER: 'À planifier', PLANIFIEE: 'Planifiée', EN_COURS: 'En cours', TERMINEE: 'Terminée' };

function CarteJournee({ intervention }: { intervention: InterventionJournee }) {
  return <article className="rounded-xl border bg-white p-4 shadow-sm">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-blue-700">{intervention.reference}</p>
        <h3 className="font-semibold text-gray-900">{intervention.titre}</h3>
        <p className="text-sm text-gray-600">{intervention.client.raisonSociale}</p>
      </div>
      <p className="shrink-0 text-sm font-medium">{libelleStatut[intervention.statut] || intervention.statut}</p>
    </div>
    <CoordonneesIntervention intervention={intervention} />
    <Link to={`/interventions/${intervention.id}`} className="btn btn-secondary mt-3 inline-flex">Ouvrir la fiche</Link>
  </article>;
}

export default function MaJournee() {
  // Sans jour choisi, le serveur rend celui de la société.
  const [jourDemande, setJourDemande] = useState<string | null>(null);
  const [journee, setJournee] = useState<Journee | null>(null);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState('');
  // Seule la dernière demande s'affiche : une navigation rapide ne mélange pas deux jours.
  const derniere = useRef(0);

  const charger = useCallback(async (jour: string | null) => {
    const numero = ++derniere.current;
    setChargement(true);
    setErreur('');
    try {
      const res = await apiFetch(`/interventions/journee${jour ? `?jour=${jour}` : ''}`);
      const data = await res.json();
      if (numero !== derniere.current) return;
      if (!res.ok) throw new Error(data.error || 'Impossible de charger la journée.');
      setJournee(data as Journee);
    } catch (err) {
      if (numero === derniere.current) setErreur(err instanceof Error ? err.message : 'Impossible de charger la journée.');
    } finally {
      if (numero === derniere.current) setChargement(false);
    }
  }, []);

  useEffect(() => { void charger(jourDemande); }, [charger, jourDemande]);

  const jour = journee?.jour;
  const estAujourdhui = !!journee && journee.jour === journee.aujourdhui;
  const aucune = !!journee && journee.aFaire.length + journee.resteesOuvertes.length + journee.terminees.length === 0;

  return <div className="space-y-5">
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Ma journée</h1>
      <p className="text-gray-500">{jour ? `${estAujourdhui ? 'Aujourd’hui, ' : ''}${jourSemaineFrancais(jour, 'long')}` : 'Interventions qui vous sont affectées.'}</p>
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn btn-secondary" disabled={!jour || chargement} onClick={() => jour && setJourDemande(shiftDateStr(jour, -1))}>Jour précédent</button>
      <button type="button" className="btn btn-secondary" disabled={!journee || estAujourdhui || chargement} onClick={() => journee && setJourDemande(journee.aujourdhui)}>Aujourd’hui</button>
      <button type="button" className="btn btn-secondary" disabled={!jour || chargement} onClick={() => jour && setJourDemande(shiftDateStr(jour, 1))}>Jour suivant</button>
    </div>
    {erreur && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">{erreur}</div>}
    {chargement && !journee ? <p className="text-gray-500">Chargement…</p> : journee && <>
      <section className="space-y-3" aria-label="Interventions du jour">
        <h2 className="text-lg font-semibold text-gray-900">Interventions du jour</h2>
        {journee.aFaire.length === 0 ? <p className="rounded-xl border border-dashed p-6 text-center text-gray-500"><CalendarDays className="mx-auto mb-2" />{aucune ? 'Aucune intervention ne vous est planifiée ce jour.' : 'Aucune autre intervention à faire ce jour.'}</p>
          : journee.aFaire.map((intervention) => <CarteJournee key={intervention.id} intervention={intervention} />)}
      </section>
      {journee.resteesOuvertes.length > 0 && <section className="space-y-3" aria-label="Restées ouvertes les jours précédents">
        <h2 className="text-lg font-semibold text-gray-900">Restées ouvertes les jours précédents</h2>
        {journee.resteesOuvertes.map((intervention) => <CarteJournee key={intervention.id} intervention={intervention} />)}
      </section>}
      {journee.terminees.length > 0 && <section className="space-y-3" aria-label="Terminées ce jour">
        <h2 className="text-lg font-semibold text-gray-900">Terminées</h2>
        {journee.terminees.map((intervention) => <CarteJournee key={intervention.id} intervention={intervention} />)}
      </section>}
    </>}
  </div>;
}
