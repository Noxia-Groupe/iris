import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ChevronDown, RefreshCw, AlertTriangle, MapPin } from 'lucide-react';
import { API_URL } from '../api';
import {
  type Intervenant, type PlanningEvent,
  lundiDe, joursDeLaSemaine, numeroSemaineIso, shiftDateStr,
  couleurEvent, texteSurCouleur, libelleEvent, badgeCreneau, adresseEvent,
} from '../planningUtils';
import { formatCompanyDateTime, jourFrancais, jourSemaineFrancais } from '../lib/dateFormatting';
import { NOM_APPLICATION } from '../lib/marque';

// Plage de la semaine au format JJ-MM-AAAA : « 13-07-2026 – 19-07-2026 ».
function formatPlageSemaine(debut: string, fin: string): string {
  return `${jourFrancais(debut)} – ${jourFrancais(fin)}`;
}

// Jour et fuseau de la société, renvoyés par le serveur : la page publique n'a pas de session,
// et le téléphone du technicien peut être dans un autre fuseau (décision de Nelson du 14-10-2026).
type Societe = { fuseauHoraire: string; aujourdhui: string };

// ---------------------------------------------------------------------------
// Vue publique, en LECTURE SEULE et SANS authentification, du planning d'intervention —
// destinée aux techniciens qui n'ont pas de compte dans l'application (lien de partage
// façon "OneDrive", cf. server GET /api/planning/public/:token). Volontairement distincte
// de la page admin (Planning.tsx) : agenda jour par jour (pas de grille à faire défiler
// horizontalement) pensé pour la lecture sur smartphone.
// ---------------------------------------------------------------------------

const POLL_MS = 60_000;
const RANG_CRENEAU: Record<string, number> = { MATIN: 0, JOURNEE: 1, HEURES: 2, APRES_MIDI: 3 };

const PlanningPublic = () => {
  const { token } = useParams<{ token: string }>();
  // Semaine choisie (son lundi) ; tant qu'on n'a pas navigué, le serveur renvoie celle du jour de la société.
  const [semaineChoisie, setSemaineChoisie] = useState<string | null>(null);
  const [societe, setSociete] = useState<Societe | null>(null);
  const [events, setEvents] = useState<PlanningEvent[]>([]);
  const [intervenants, setIntervenants] = useState<Intervenant[]>([]);
  const [selectedTech, setSelectedTech] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Seule la dernière lecture s'affiche : une réponse dépassée (semaine changée pendant un
  // rafraîchissement, par exemple) est ignorée.
  const requeteRef = useRef(0);

  // Sans semaine choisie, celle du jour de la société, connu dès la première réponse : le retour
  // à cette semaine est immédiat, sans attendre la réponse suivante.
  const weekStartStr = semaineChoisie ?? (societe ? lundiDe(societe.aujourdhui) : null);
  const jours = weekStartStr ? joursDeLaSemaine(weekStartStr) : [];
  const todayStr = societe?.aujourdhui ?? null;
  const isoWeek = weekStartStr ? numeroSemaineIso(weekStartStr) : null;
  const plage = semaineChoisie ? `?start=${semaineChoisie}&end=${shiftDateStr(semaineChoisie, 6)}` : '';

  // Retrouve le technicien choisi précédemment sur ce même lien (typiquement gardé en
  // favori sur le téléphone) : évite d'avoir à se re-sélectionner à chaque ouverture.
  useEffect(() => {
    if (!token) return;
    const saved = localStorage.getItem(`planning-public-tech-${token}`);
    if (saved) setSelectedTech(saved);
  }, [token]);

  const fetchData = useCallback(async (silent = false) => {
    if (!token) return;
    const requete = ++requeteRef.current;
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`${API_URL}/planning/public/${encodeURIComponent(token)}${plage}`);
      const data = await res.json();
      if (requete !== requeteRef.current) return;
      if (!res.ok) {
        setError(data.error || "Ce lien de planning n'est plus disponible.");
      } else {
        setError(null);
        setEvents(Array.isArray(data.events) ? data.events : []);
        setIntervenants(Array.isArray(data.intervenants) ? data.intervenants : []);
        if (data.fuseauHoraire && data.aujourdhui) setSociete({ fuseauHoraire: data.fuseauHoraire, aujourdhui: data.aujourdhui });
        setLastUpdated(new Date());
      }
    } catch {
      if (requete === requeteRef.current) setError('Impossible de joindre le serveur. Vérifiez votre connexion.');
    } finally {
      if (requete === requeteRef.current) setLoading(false);
    }
  }, [token, plage]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Rafraîchissement quasi temps réel : toutes les 60s, et immédiatement quand l'onglet
  // redevient visible (téléphone déverrouillé après une mise en veille de l'écran).
  useEffect(() => {
    pollRef.current = setInterval(() => fetchData(true), POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') fetchData(true); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [fetchData]);

  const handleSelectTech = (id: string) => {
    setSelectedTech(id);
    if (!token) return;
    if (id) localStorage.setItem(`planning-public-tech-${token}`, id);
    else localStorage.removeItem(`planning-public-tech-${token}`);
  };

  const eventsJour = (jourStr: string) =>
    events
      .filter((ev) => ev.dateDebut.slice(0, 10) <= jourStr && jourStr <= ev.dateFin.slice(0, 10))
      .filter((ev) => !selectedTech || ev.intervenants.some((i) => i.id === selectedTech))
      .sort((a, b) => (RANG_CRENEAU[a.creneau] - RANG_CRENEAU[b.creneau]) || (a.heureDebut || '').localeCompare(b.heureDebut || ''));

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] p-6">
        <div className="max-w-sm w-full bg-white rounded-2xl shadow-md border border-gray-100 p-6 text-center">
          <AlertTriangle className="mx-auto text-amber-500 mb-3" size={36} />
          <h1 className="text-lg font-bold text-primary-dark mb-2">Lien indisponible</h1>
          <p className="text-sm text-gray-500">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-bg)]">
      <header className="bg-primary text-white px-4 py-4 sticky top-0 z-10 shadow-md">
        <h1 className="text-lg font-bold m-0 leading-tight">Planning d'intervention</h1>
        <p className="text-xs opacity-80 m-0">{NOM_APPLICATION} — lecture seule</p>
      </header>

      <div className="max-w-md mx-auto px-3 py-4">
        {intervenants.length > 0 && (
          <select
            value={selectedTech}
            onChange={(e) => handleSelectTech(e.target.value)}
            className="form-input w-full font-semibold text-base py-3 mb-3"
          >
            <option value="">Tous les techniciens</option>
            {intervenants.map((i) => (
              <option key={i.id} value={i.id}>{i.nom}</option>
            ))}
          </select>
        )}

        <div className="flex items-center justify-between gap-2 bg-white px-2 py-2 rounded-xl shadow-sm border border-gray-100">
          <button disabled={!weekStartStr} onClick={() => weekStartStr && setSemaineChoisie(shiftDateStr(weekStartStr, -7))} className="p-2.5 bg-gray-100 active:bg-gray-200 rounded-lg" title="Semaine précédente">
            <ChevronLeft size={18} />
          </button>
          <button onClick={() => setSemaineChoisie(null)} className="flex-1 text-sm font-bold px-2 py-2 bg-gray-50 rounded-lg text-center" title="Revenir à aujourd'hui">
            Semaine {isoWeek ?? '…'}
          </button>
          <button disabled={!weekStartStr} onClick={() => weekStartStr && setSemaineChoisie(shiftDateStr(weekStartStr, 7))} className="p-2.5 bg-gray-100 active:bg-gray-200 rounded-lg" title="Semaine suivante">
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="text-center text-xs font-semibold text-gray-500 mt-1.5 mb-4">
          {jours.length > 0 ? formatPlageSemaine(jours[0], jours[6]) : '…'}
        </div>

        {loading && events.length === 0 ? (
          <div className="text-center text-gray-400 py-10 animate-pulse">Chargement du planning...</div>
        ) : (
          <div className="flex flex-col gap-4">
            {jours.map((jStr) => {
              const isToday = jStr === todayStr;
              const dayEvents = eventsJour(jStr);
              return (
                <div key={jStr}>
                  <div className={`flex items-center gap-2 mb-1.5 px-1 ${isToday ? 'text-accent' : 'text-gray-500'}`}>
                    <span className="text-sm font-extrabold uppercase">
                      {jourSemaineFrancais(jStr, 'long')}
                    </span>
                    {isToday && <span className="text-[10px] font-bold bg-accent text-white px-1.5 py-0.5 rounded">Aujourd'hui</span>}
                  </div>
                  {dayEvents.length === 0 ? (
                    <div className="text-sm text-gray-400 italic px-1 py-2">Rien de prévu.</div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {dayEvents.map((ev) => (
                        <EventCard key={ev.id} ev={ev} showTechniciens={!selectedTech} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {lastUpdated && societe && (
          <div className="flex items-center justify-center gap-1.5 text-xs text-gray-400 mt-6 pb-4">
            <RefreshCw size={11} />
            Mis à jour à {formatCompanyDateTime(lastUpdated, societe.fuseauHoraire, { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Carte d'une affectation. Le nom du client/chantier, quand il y en a un, est cliquable :
// il déplie la carte pour révéler l'adresse du site et le commentaire (consignes,
// matériel à prévoir...). Sans nom cliquable (événement personnalisé, ou SAV sans client
// renseigné), le commentaire reste affiché directement, comme il n'y a rien d'autre sous
// quoi le replier.
// ---------------------------------------------------------------------------
const EventCard = ({ ev, showTechniciens }: { ev: PlanningEvent; showTechniciens: boolean }) => {
  const [expanded, setExpanded] = useState(false);
  const bg = couleurEvent(ev);
  const badge = badgeCreneau(ev);
  const client = ev.categorie === 'CHANTIER' ? ev.chantier?.client : ev.client;
  const adresse = adresseEvent(ev);
  const hasDetail = !!adresse || !!ev.commentaire;

  // L'en-tête (titre + client) devient un bouton dépliant dès qu'il y a quelque chose à
  // montrer (adresse et/ou commentaire) — jamais conditionné à la présence d'un nom de
  // client, pour rester utilisable même sur un SAV où le client n'a pas été renseigné.
  const header = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="font-bold text-base leading-tight">{libelleEvent(ev)}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {badge && <span className="text-xs font-bold opacity-90 bg-black/15 px-2 py-0.5 rounded">{badge}</span>}
          {hasDetail && <ChevronDown size={16} className={`opacity-80 transition-transform ${expanded ? 'rotate-180' : ''}`} />}
        </div>
      </div>
      {client && <div className="text-sm opacity-90 mt-0.5">{client}</div>}
    </>
  );

  return (
    <div className="rounded-xl shadow-sm p-3" style={{ backgroundColor: bg, color: texteSurCouleur(bg) }}>
      {hasDetail ? (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="w-full text-left">
          {header}
        </button>
      ) : header}

      {showTechniciens && (
        <div className="flex flex-wrap gap-1 mt-2">
          {ev.intervenants.map((i) => (
            <span key={i.id} className="text-xs font-semibold bg-black/15 px-2 py-0.5 rounded-full">{i.nom}</span>
          ))}
        </div>
      )}

      {expanded && hasDetail && (
        <div className="mt-2 pt-2 border-t border-white/25 flex flex-col gap-1.5 text-sm">
          {adresse && (
            <div className="flex items-start gap-1.5">
              <MapPin size={14} className="shrink-0 mt-0.5 opacity-90" />
              <span className="opacity-95">{adresse}</span>
            </div>
          )}
          {ev.commentaire && <div className="opacity-90 italic">{ev.commentaire}</div>}
        </div>
      )}
    </div>
  );
};

export default PlanningPublic;
