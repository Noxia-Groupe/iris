import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { apiFetch } from '../api';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { formatCompanyDateTime, formatDateOnly } from '../lib/dateFormatting';
import { bilanGeneration, pluriel } from '../lib/generationVisites';

// Génération automatique des visites de maintenance (lot pilote 5) : réglage de l'anticipation,
// dernier passage, contrats laissés de côté, erreurs, alerte et passage lancé à la main. Réservé à
// l'administration, comme les contrats.
type ExecutionGeneration = {
  id: string; jour: string; declenchement: 'AUTOMATIQUE' | 'MANUEL'; auteurNom: string | null; anticipationJours: number;
  debut: string; fin: string | null; statut: 'EN_COURS' | 'REUSSIE' | 'ECHEC'; visitesCreees: number; echeancesAvancees: number;
  contratsIgnores: { contratId: string; titre: string; motif: string }[];
  erreurs: { contratId: string | null; titre: string | null; message: string }[];
};
export type EtatGenerationVisites = {
  anticipationVisitesJours: number | null; minuteurActif: boolean; alerte: string | null;
  derniereExecution: ExecutionGeneration | null; derniereExecutionAutomatique: ExecutionGeneration | null;
};


async function lireEtat(): Promise<EtatGenerationVisites> {
  const res = await apiFetch('/contrats-maintenance/generation-visites');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Lecture de l’état de la génération des visites impossible.');
  return data as EtatGenerationVisites;
}

function AlerteGeneration({ texte, lien }: { texte: string; lien?: boolean }) {
  return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">
    {texte}{lien && <> <Link to="/contrats-maintenance" className="font-medium underline">Contrats de maintenance</Link></>}
  </div>;
}

// Alerte seule, en tête de l'écran des interventions : l'administration la voit là où elle suit
// la file à planifier. Rien ne s'affiche sans alerte ni si l'état ne se lit pas.
export function AlerteGenerationVisites() {
  const [alerte, setAlerte] = useState<string | null>(null);
  useEffect(() => {
    let annule = false;
    lireEtat().then((etat) => { if (!annule) setAlerte(etat.alerte); }).catch(() => undefined);
    return () => { annule = true; };
  }, []);
  return alerte ? <AlerteGeneration texte={alerte} lien /> : null;
}

export function GenerationVisites({ onGeneration }: { onGeneration: () => void }) {
  const fuseau = useCompanyTimezone();
  const [etat, setEtat] = useState<EtatGenerationVisites | null>(null);
  const [erreur, setErreur] = useState('');
  const [succes, setSucces] = useState('');
  const [enCours, setEnCours] = useState(false);
  // Un second clic avant la fin du premier envoi ne relance rien.
  const envoi = useRef(false);

  const charger = useCallback(async () => {
    try {
      setEtat(await lireEtat());
    } catch (err) {
      setErreur(err instanceof Error ? err.message : 'Lecture de l’état de la génération des visites impossible.');
    }
  }, []);
  useEffect(() => { void charger(); }, [charger]);

  const agir = async (action: () => Promise<void>) => {
    if (envoi.current) return;
    envoi.current = true;
    setEnCours(true); setErreur(''); setSucces('');
    try {
      await action();
    } finally {
      envoi.current = false;
      setEnCours(false);
    }
  };

  const enregistrerAnticipation = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const valeur = String(new FormData(event.currentTarget).get('anticipationVisitesJours') ?? '').trim();
    void agir(async () => {
      const res = await apiFetch('/parametres', { method: 'PUT', body: JSON.stringify({ anticipationVisitesJours: valeur }) });
      const data = await res.json();
      if (!res.ok) return setErreur(data.error || 'Enregistrement de l’anticipation impossible.');
      setSucces(data.anticipationVisitesJours === null ? 'Génération automatique désactivée.' : `Anticipation enregistrée : ${pluriel(data.anticipationVisitesJours, 'jour', 'jours')}.`);
      await charger();
    });
  };

  const lancer = () => void agir(async () => {
    const res = await apiFetch('/contrats-maintenance/generation-visites', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return setErreur(data.error || 'Génération des visites impossible.');
    setEtat(data.etat as EtatGenerationVisites);
    const execution = data.execution as ExecutionGeneration;
    if (execution.statut === 'REUSSIE') setSucces(`Génération terminée : ${bilanGeneration(execution)}.`);
    onGeneration();
  });

  const derniere = etat?.derniereExecution;
  return <section aria-labelledby="titre-generation-visites" className="rounded-xl border bg-white p-5 shadow-sm space-y-3 break-words">
    <h2 id="titre-generation-visites" className="flex items-center gap-2 font-semibold text-gray-900"><CalendarClock size={18} /> Génération automatique des visites</h2>
    <p className="text-sm text-gray-600">Chaque jour, le serveur crée l’intervention à planifier d’une échéance dès qu’elle tombe dans l’anticipation, et passe à l’échéance suivante quand la visite est terminée.</p>
    {etat?.alerte && <AlerteGeneration texte={etat.alerte} />}
    {erreur && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">{erreur}</div>}
    {succes && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-700">{succes}</div>}
    {etat && !etat.minuteurActif && <p className="text-sm text-amber-700">La génération automatique est arrêtée sur ce serveur : seules les générations lancées ici s’exécutent.</p>}
    {etat && <form key={String(etat.anticipationVisitesJours)} onSubmit={enregistrerAnticipation} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <label className="text-sm text-gray-700">Anticipation (jours avant l’échéance)
        <input name="anticipationVisitesJours" type="number" min="0" max="365" step="1" defaultValue={etat.anticipationVisitesJours ?? ''} className="form-input mt-1" placeholder="Vide : désactivée" />
      </label>
      <button type="submit" className="btn btn-secondary" disabled={enCours}>Enregistrer</button>
      <button type="button" className="btn btn-primary" disabled={enCours || etat.anticipationVisitesJours === null} onClick={lancer}>{enCours ? 'Génération…' : 'Lancer la génération maintenant'}</button>
    </form>}
    {etat && etat.anticipationVisitesJours === null && <p className="text-sm text-gray-500">Génération automatique désactivée : les actions de chaque contrat restent disponibles.</p>}
    {derniere && <div className="text-sm text-gray-700 space-y-2">
      <p>
        Dernier passage : {formatCompanyDateTime(derniere.debut, fuseau)} ({derniere.declenchement === 'AUTOMATIQUE' ? 'automatique' : `lancé par ${derniere.auteurNom}`}, échéances jusqu’à {pluriel(derniere.anticipationJours, 'jour', 'jours')} après le {formatDateOnly(derniere.jour)})
        {derniere.statut === 'EN_COURS' ? ' : en cours.' : ` : ${bilanGeneration(derniere)}${derniere.statut === 'ECHEC' ? ', en échec' : ''}.`}
      </p>
      {derniere.contratsIgnores.length > 0 && <div><p className="font-medium">Contrats laissés de côté</p><ul className="list-disc pl-5">{derniere.contratsIgnores.map((contrat) => <li key={contrat.contratId}>{contrat.titre} : {contrat.motif}</li>)}</ul></div>}
      {derniere.erreurs.length > 0 && <div className="text-red-700"><p className="font-medium">Erreurs</p><ul className="list-disc pl-5">{derniere.erreurs.map((erreurContrat, index) => <li key={erreurContrat.contratId ?? `erreur-${index}`}>{erreurContrat.titre ? `${erreurContrat.titre} : ` : ''}{erreurContrat.message}</li>)}</ul></div>}
    </div>}
  </section>;
}
