import { useEffect, useState } from 'react';
import { Building2, Search, Save, Palette } from 'lucide-react';
import { apiFetch } from '../api';

/**
 * Identité de la société exploitant cette instance Iris.
 *
 * Une installation = une société (cf. docs/ARCHITECTURE-INSTANCE-DEDIEE.md) : ces valeurs
 * alimenteront l'en-tête des devis et factures, les mentions légales et le branding.
 * Lecture ouverte à tout compte connecté (l'application en a besoin pour s'afficher),
 * écriture réservée au super administrateur.
 */
type Societe = {
  raisonSociale: string | null; nomCommercial: string | null; siret: string | null; tvaIntra: string | null;
  adresse: string | null; codePostal: string | null; ville: string | null; pays: string | null;
  telephone: string | null; email: string | null; siteWeb: string | null; logoUrl: string | null;
  couleurPrimaire: string | null; couleurSecondaire: string | null;
  prefixeFacture: string | null; prefixeAvoir: string | null; piedFacture: string | null;
};

type ResultatRegistre = {
  siren: string | null; siret: string | null; raisonSociale: string | null; nomCommercial: string | null;
  adresse: string | null; codePostal: string | null; ville: string | null; etatAdministratif: string | null;
};

const CHAMPS_TEXTE: Array<{ cle: keyof Societe; libelle: string; type?: string; placeholder?: string }> = [
  { cle: 'raisonSociale', libelle: 'Raison sociale' },
  { cle: 'nomCommercial', libelle: 'Nom commercial' },
  { cle: 'siret', libelle: 'SIRET' },
  { cle: 'tvaIntra', libelle: 'TVA intracommunautaire' },
  { cle: 'adresse', libelle: 'Adresse' },
  { cle: 'codePostal', libelle: 'Code postal' },
  { cle: 'ville', libelle: 'Ville' },
  { cle: 'pays', libelle: 'Pays' },
  { cle: 'telephone', libelle: 'Téléphone', type: 'tel' },
  { cle: 'email', libelle: 'E-mail', type: 'email' },
  { cle: 'siteWeb', libelle: 'Site web', placeholder: 'https://' },
  { cle: 'logoUrl', libelle: 'URL du logo', placeholder: 'https://…/logo.png' },
  { cle: 'prefixeFacture', libelle: 'Préfixe de facture', placeholder: 'FA' },
  { cle: 'prefixeAvoir', libelle: 'Préfixe d’avoir', placeholder: 'AV' },
];

const Societe = ({ modifiable }: { modifiable: boolean }) => {
  const [societe, setSociete] = useState<Societe | null>(null);
  const [recherche, setRecherche] = useState('');
  const [resultats, setResultats] = useState<ResultatRegistre[]>([]);
  const [message, setMessage] = useState('');
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);

  const charger = async () => {
    const res = await apiFetch('/company');
    const data = await res.json();
    if (res.ok) setSociete(data);
    else setErreur(data.error || 'Chargement impossible.');
  };
  useEffect(() => { void charger(); }, []);

  const majChamp = (cle: keyof Societe, valeur: string) =>
    setSociete((s) => (s ? { ...s, [cle]: valeur } : s));

  // Recherche au registre national des entreprises (API publique, appelée par le backend).
  // Elle ne fait que PRÉREMPLIR le formulaire : rien n'est enregistré sans validation.
  const chercherAuRegistre = async () => {
    setErreur(''); setResultats([]);
    if (recherche.trim().length < 3) { setErreur('Saisissez au moins trois caractères.'); return; }
    const res = await apiFetch(`/registry/companies?q=${encodeURIComponent(recherche.trim())}`);
    const data = await res.json();
    if (!res.ok) { setErreur(data.error || 'Registre indisponible.'); return; }
    setResultats(data.companies || []);
    if ((data.companies || []).length === 0) setMessage('Aucune entreprise trouvée pour cette recherche.');
  };

  const preremplir = (r: ResultatRegistre) => {
    setSociete((s) => (s ? {
      ...s,
      raisonSociale: r.raisonSociale ?? s.raisonSociale,
      nomCommercial: r.nomCommercial ?? s.nomCommercial,
      siret: r.siret ?? s.siret,
      adresse: r.adresse ?? s.adresse,
      codePostal: r.codePostal ?? s.codePostal,
      ville: r.ville ?? s.ville,
    } : s));
    setResultats([]);
    setMessage('Fiche préremplie depuis le registre. Vérifiez puis enregistrez.');
  };

  const enregistrer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!societe) return;
    setErreur(''); setMessage(''); setEnCours(true);
    try {
      // Le serveur refuse `null` sur ses champs texte : on envoie des chaînes, qu'il
      // reconvertit en null quand elles sont vides.
      const corps: Record<string, string> = {};
      for (const { cle } of CHAMPS_TEXTE) corps[cle] = societe[cle] ?? '';
      corps.piedFacture = societe.piedFacture ?? '';
      corps.couleurPrimaire = societe.couleurPrimaire || '#1e3a8a';
      corps.couleurSecondaire = societe.couleurSecondaire || '#f59e0b';
      const res = await apiFetch('/company', { method: 'PUT', body: JSON.stringify(corps) });
      const data = await res.json();
      if (!res.ok) { setErreur(data.error || 'Enregistrement impossible.'); return; }
      setSociete(data);
      setMessage('Identité de la société enregistrée.');
    } catch {
      setErreur('Impossible de joindre le serveur.');
    } finally {
      setEnCours(false);
    }
  };

  if (!societe) return <p className="text-muted">Chargement…</p>;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Building2 className="text-blue-700" size={26} />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Société</h1>
          <p className="text-gray-500">Identité légale et visuelle de l'instance : en-têtes de documents, mentions légales et branding.</p>
        </div>
      </div>

      {erreur && <div className="p-3 bg-red-100 text-red-700 rounded-md text-sm">{erreur}</div>}
      {message && <div className="p-3 bg-emerald-50 text-emerald-800 rounded-md text-sm">{message}</div>}

      {modifiable && (
        <section className="bg-white border border-gray-100 rounded-xl p-5">
          <h2 className="font-semibold flex items-center gap-2 text-gray-800"><Search size={18} /> Préremplir depuis le registre des entreprises</h2>
          <p className="text-sm text-gray-500 mt-1">Recherchez par nom ou SIREN pour éviter la saisie manuelle.</p>
          <div className="flex gap-2 mt-3">
            <input
              value={recherche}
              onChange={(e) => setRecherche(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void chercherAuRegistre(); } }}
              placeholder="Nom de la société ou SIREN"
              className="form-input flex-1"
            />
            <button type="button" className="btn btn-secondary" onClick={() => void chercherAuRegistre()}>Rechercher</button>
          </div>
          {resultats.length > 0 && (
            <ul className="mt-3 divide-y border border-gray-100 rounded-lg">
              {resultats.map((r, i) => (
                <li key={`${r.siren}-${i}`} className="p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">{r.raisonSociale || 'Sans nom'}</p>
                    <p className="text-sm text-gray-500">
                      {r.siret ? `SIRET ${r.siret} · ` : ''}{[r.codePostal, r.ville].filter(Boolean).join(' ')}
                      {r.etatAdministratif === 'F' ? ' · établissement fermé' : ''}
                    </p>
                  </div>
                  <button type="button" className="btn btn-secondary" onClick={() => preremplir(r)}>Utiliser</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <form onSubmit={enregistrer} className="bg-white border border-gray-100 rounded-xl p-5 space-y-5">
        <div className="grid md:grid-cols-2 gap-4">
          {CHAMPS_TEXTE.map(({ cle, libelle, type, placeholder }) => (
            <div className="form-group" key={cle}>
              <label className="form-label">{libelle}</label>
              <input
                type={type || 'text'}
                value={societe[cle] ?? ''}
                placeholder={placeholder}
                disabled={!modifiable}
                onChange={(e) => majChamp(cle, e.target.value)}
                className="form-input"
              />
            </div>
          ))}
        </div>

        <div className="form-group">
          <label className="form-label">Pied de facture (mentions légales, conditions de règlement)</label>
          <textarea
            value={societe.piedFacture ?? ''}
            disabled={!modifiable}
            onChange={(e) => majChamp('piedFacture', e.target.value)}
            className="form-input"
            rows={3}
          />
        </div>

        <div>
          <h2 className="font-semibold flex items-center gap-2 text-gray-800 mb-3"><Palette size={18} /> Couleurs de marque</h2>
          <div className="flex flex-wrap gap-6">
            {(['couleurPrimaire', 'couleurSecondaire'] as const).map((cle) => (
              <label key={cle} className="flex items-center gap-3 text-sm">
                <input
                  type="color"
                  value={societe[cle] || (cle === 'couleurPrimaire' ? '#1e3a8a' : '#f59e0b')}
                  disabled={!modifiable}
                  onChange={(e) => majChamp(cle, e.target.value)}
                  style={{ width: 44, height: 32, padding: 0, border: 'none', background: 'none' }}
                />
                {cle === 'couleurPrimaire' ? 'Couleur principale' : 'Couleur secondaire'}
              </label>
            ))}
          </div>
        </div>

        {modifiable ? (
          <button type="submit" disabled={enCours} className="btn btn-primary flex items-center gap-2">
            <Save size={16} /> {enCours ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        ) : (
          <p className="text-sm text-gray-500">Seul un super administrateur peut modifier ces informations.</p>
        )}
      </form>
    </div>
  );
};

export default Societe;
