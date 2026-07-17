import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ChevronDown, RefreshCw, AlertTriangle, MapPin } from 'lucide-react';
import { API_URL } from '../api';
import {
  type Intervenant, type PlanningEvent,
  toDateStr, mondayOfWeek, addDays, isoWeekNumber,
  couleurEvent, texteSurCouleur, libelleEvent, badgeCreneau, adresseEvent,
} from '../planningUtils';

// Plage "13 – 19 juillet 2026" (ou "28 juin – 4 juillet 2026" si la semaine chevauche deux
// mois) : le mois n'est répété qu'une fois quand il est identique aux deux bornes.
function formatPlageSemaine(debut: Date, fin: Date): string {
  const memeMois = debut.getMonth() === fin.getMonth() && debut.getFullYear() === fin.getFullYear();
  const debutStr = debut.toLocaleDateString('fr-FR', { day: 'numeric', month: memeMois ? undefined : 'long' });
  const finStr = fin.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  return `${debutStr} – ${finStr}`;
}

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
  const [weekStart, setWeekStart] = useState<Date>(() => mondayOfWeek(new Date()));
  const [events, setEvents] = useState<PlanningEvent[]>([]);
  const [intervenants, setIntervenants] = useState<Intervenant[]>([]);
  const [selectedTech, setSelectedTech] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const jours = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekStartStr = toDateStr(weekStart);
  const weekEndStr = toDateStr(jours[6]);
  const todayStr = toDateStr(new Date());
  const isoWeek = isoWeekNumber(weekStart);

  // Retrouve le technicien choisi précédemment sur ce même lien (typiquement gardé en
  // favori sur le téléphone) : évite d'avoir à se re-sélectionner à chaque ouverture.
  useEffect(() => {
    if (!token) return;
    const saved = localStorage.getItem(`planning-public-tech-${token}`);
    if (saved) setSelectedTech(saved);
  }, [token]);

  const fetchData = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`${API_URL}/planning/public/${encodeURIComponent(token)}?start=${weekStartStr}&end=${weekEndStr}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Ce lien de planning n'est plus disponible.");
      } else {
        setError(null);
        setEvents(Array.isArray(data.events) ? data.events : []);
        setIntervenants(Array.isArray(data.intervenants) ? data.intervenants : []);
        setLastUpdated(new Date());
      }
    } catch {
      setError('Impossible de joindre le serveur. Vérifiez votre connexion.');
    } finally {
      setLoading(false);
    }
  }, [token, weekStartStr, weekEndStr]);

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
        <p className="text-xs opacity-80 m-0">NØXIA GROUPE — lecture seule</p>
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
          <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="p-2.5 bg-gray-100 active:bg-gray-200 rounded-lg" title="Semaine précédente">
            <ChevronLeft size={18} />
          </button>
          <button onClick={() => setWeekStart(mondayOfWeek(new Date()))} className="flex-1 text-sm font-bold px-2 py-2 bg-gray-50 rounded-lg text-center">
            Aujourd'hui
          </button>
          <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="p-2.5 bg-gray-100 active:bg-gray-200 rounded-lg" title="Semaine suivante">
            <ChevronRight size={18} />
          </button>
        </div>
        {/* "Aujourd'hui" ci-dessus est une action (revenir à la semaine courante), pas une
            étiquette : elle ne change jamais. Le numéro de semaine ISO 8601 ci-dessous
            indique, lui, la semaine réellement affichée. */}
        <div className="text-center text-xs font-semibold text-gray-500 mt-1.5 mb-4">
          Semaine {isoWeek} · {formatPlageSemaine(weekStart, jours[6])}
        </div>

        {loading && events.length === 0 ? (
          <div className="text-center text-gray-400 py-10 animate-pulse">Chargement du planning...</div>
        ) : (
          <div className="flex flex-col gap-4">
            {jours.map((j) => {
              const jStr = toDateStr(j);
              const isToday = jStr === todayStr;
              const dayEvents = eventsJour(jStr);
              return (
                <div key={jStr}>
                  <div className={`flex items-center gap-2 mb-1.5 px-1 ${isToday ? 'text-accent' : 'text-gray-500'}`}>
                    <span className="text-sm font-extrabold uppercase">
                      {j.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}
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

        {lastUpdated && (
          <div className="flex items-center justify-center gap-1.5 text-xs text-gray-400 mt-6 pb-4">
            <RefreshCw size={11} />
            Mis à jour à {lastUpdated.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
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
