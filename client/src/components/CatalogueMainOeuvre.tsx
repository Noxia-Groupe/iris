import { Fragment, useId, useState } from 'react';
import { HardHat, Pencil, Plus, Power } from 'lucide-react';
import { apiFetch } from '../api';
import { LIBELLE_HEURES_PAR_JOUR, PRIX_MAIN_OEUVRE, formatEuros, formatHeures, valeurSaisie, type ChampPrixMainOeuvre, type MainOeuvre } from '../lib/mainOeuvre';

/**
 * Onglet « Main d'œuvre » du catalogue (décisions de Nelson du 24-10-2026) : chaque main d'œuvre est
 * une prestation du catalogue avec quatre prix de vente, hors contrat et sous contrat, à l'heure et
 * au forfait jour, et son nombre d'heures par jour. Ce sont des prix de vente, jamais des coûts : le
 * coût reste le taux horaire chargé de l'intervenant. Le paramétrage part vide.
 *
 * L'écran crée une main d'œuvre, modifie ses prix et ses heures par jour (choix par défaut, à
 * confirmer : les autres fiches du catalogue ne se modifient que par l'API), la désactive et la
 * réactive. Le serveur contrôle chaque montant (au centime) et journalise chaque changement.
 */
type Categorie = { id: string; nom: string };
type ChampModifiable = ChampPrixMainOeuvre | 'heuresParJour';
type ValeursPrix = Record<ChampModifiable, string>;

const saisieVide = {
  reference: '', nom: '', categorieId: '', tauxTva: '20', description: '',
  prixVenteHt: '', prixJourHorsContratHt: '', prixHeureSousContratHt: '', prixJourSousContratHt: '', heuresParJour: '',
};

// Fiche entière renvoyée au serveur (la modification remplace la fiche), avec ses prix éventuellement changés.
// L'activité n'est envoyée que pour une réactivation : l'enregistrement des prix depuis un écran périmé ne
// doit pas réactiver une main d'œuvre désactivée entre-temps (le serveur garde l'activité si elle est absente).
const corpsFiche = (fiche: MainOeuvre, prix: Partial<ValeursPrix>, actif?: boolean) => ({
  estMainOeuvre: true, reference: fiche.reference, nom: fiche.nom, description: fiche.description, categorieId: fiche.categorieId || null,
  tauxTva: fiche.tauxTva, prixVenteHt: fiche.prixVenteHt, prixJourHorsContratHt: fiche.prixJourHorsContratHt,
  prixHeureSousContratHt: fiche.prixHeureSousContratHt, prixJourSousContratHt: fiche.prixJourSousContratHt, heuresParJour: fiche.heuresParJour,
  ...prix, ...(actif === undefined ? {} : { actif }),
});

async function erreurDe(res: Response, defaut: string) {
  const data = await res.json().catch(() => ({}));
  return (data as { error?: string }).error || defaut;
}

export default function CatalogueMainOeuvre({ fiches, categories, recharger }: { fiches: MainOeuvre[]; categories: Categorie[]; recharger: () => Promise<void> }) {
  const id = useId();
  const [saisie, setSaisie] = useState({ ...saisieVide });
  const [edition, setEdition] = useState<{ id: string; valeurs: ValeursPrix } | null>(null);
  const [erreur, setErreur] = useState('');
  const [message, setMessage] = useState('');
  const [envoi, setEnvoi] = useState(false);

  // Une seule écriture à la fois : le message de la précédente est remplacé.
  const ecrire = async (action: () => Promise<Response>, defaut: string, reussite: string) => {
    setErreur(''); setMessage(''); setEnvoi(true);
    try {
      const res = await action();
      if (!res.ok) { setErreur(await erreurDe(res, defaut)); return false; }
      setMessage(reussite);
      await recharger();
      return true;
    } catch {
      setErreur('Impossible de joindre le serveur.');
      return false;
    } finally {
      setEnvoi(false);
    }
  };

  const creer = async (e: React.FormEvent) => {
    e.preventDefault();
    const corps = { ...saisie, estMainOeuvre: true, categorieId: saisie.categorieId || null };
    const ok = await ecrire(() => apiFetch('/catalogue/prestations', { method: 'POST', body: JSON.stringify(corps) }), 'Création impossible.', `Main d’œuvre « ${saisie.nom.trim()} » créée.`);
    if (ok) setSaisie({ ...saisieVide });
  };

  const enregistrerPrix = async (fiche: MainOeuvre) => {
    if (!edition) return;
    const ok = await ecrire(() => apiFetch(`/catalogue/prestations/${fiche.id}`, { method: 'PUT', body: JSON.stringify(corpsFiche(fiche, edition.valeurs)) }), 'Modification impossible.', `Prix de « ${fiche.nom} » enregistrés.`);
    if (ok) setEdition(null);
  };

  const basculerActif = (fiche: MainOeuvre) => ecrire(
    () => fiche.actif
      ? apiFetch(`/catalogue/prestations/${fiche.id}`, { method: 'DELETE' })
      : apiFetch(`/catalogue/prestations/${fiche.id}`, { method: 'PUT', body: JSON.stringify(corpsFiche(fiche, {}, true)) }),
    fiche.actif ? 'Désactivation impossible.' : 'Réactivation impossible.',
    fiche.actif ? `Main d’œuvre « ${fiche.nom} » désactivée.` : `Main d’œuvre « ${fiche.nom} » réactivée.`,
  );

  const champ = (cle: keyof typeof saisieVide, libelle: string, options: { requis?: boolean; decimal?: boolean } = {}) => (
    <div className="form-group mb-0">
      <label className="form-label" htmlFor={`${id}-${cle}`}>{libelle}{options.requis ? ' *' : ''}</label>
      <input
        id={`${id}-${cle}`}
        className="form-input"
        required={options.requis}
        inputMode={options.decimal ? 'decimal' : undefined}
        autoComplete="off"
        value={saisie[cle]}
        onChange={(e) => setSaisie({ ...saisie, [cle]: e.target.value })}
      />
    </div>
  );

  const actives = fiches.filter((f) => f.actif).length;

  return (
    <div className="space-y-6">
      <section className="bg-white border border-gray-100 rounded-xl p-5" aria-labelledby={`${id}-titre-creation`}>
        <h2 id={`${id}-titre-creation`} className="font-semibold flex items-center gap-2 text-gray-800"><Plus size={18} aria-hidden="true" /> Nouvelle main d’œuvre</h2>
        <p className="text-sm text-gray-500 mt-1">
          Une main d’œuvre par corps de métier ou par tarif. Ses quatre prix sont des <strong>prix de vente</strong> hors taxes, jamais des coûts : le coût reste le taux horaire chargé de chaque intervenant. Montants au centime ; heures par jour au quart d’heure près.
        </p>
        <form onSubmit={creer} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {champ('reference', 'Référence', { requis: true })}
            {champ('nom', 'Désignation', { requis: true })}
            <div className="form-group mb-0">
              <label className="form-label" htmlFor={`${id}-categorieId`}>Catégorie</label>
              <select id={`${id}-categorieId`} value={saisie.categorieId} onChange={(e) => setSaisie({ ...saisie, categorieId: e.target.value })} className="form-input">
                <option value="">Sans catégorie</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
              </select>
            </div>
            {PRIX_MAIN_OEUVRE.map(({ cle, libelle }) => <Fragment key={cle}>{champ(cle, `${libelle} (€)`, { requis: true, decimal: true })}</Fragment>)}
            {champ('heuresParJour', LIBELLE_HEURES_PAR_JOUR, { requis: true, decimal: true })}
            {champ('tauxTva', 'TVA (%)', { decimal: true })}
          </div>
          {champ('description', 'Description')}
          <button type="submit" className="btn btn-primary" disabled={envoi}>Créer la main d’œuvre</button>
        </form>
      </section>

      {erreur && <div role="alert" className="p-3 bg-red-100 text-red-700 rounded-md text-sm">{erreur}</div>}
      {message && <div role="status" className="p-3 bg-green-50 text-green-800 rounded-md text-sm">{message}</div>}

      <section aria-labelledby={`${id}-titre-liste`} className="space-y-3">
        <h2 id={`${id}-titre-liste`} className="font-semibold flex items-center gap-2 text-gray-800">
          <HardHat size={18} aria-hidden="true" /> Mains d’œuvre ({actives} active{actives > 1 ? 's' : ''} sur {fiches.length})
        </h2>
        {fiches.length === 0 ? (
          <p className="p-6 text-center text-gray-500 bg-white border border-gray-100 rounded-xl">Aucune main d’œuvre paramétrée. Créez la première ci-dessus.</p>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {fiches.map((f) => {
              const enEdition = edition?.id === f.id ? edition : null;
              return (
                <li key={f.id}>
                  <article aria-labelledby={`${id}-mo-${f.id}`} className={`bg-white border border-gray-100 rounded-xl p-4 space-y-3 ${f.actif ? '' : 'text-gray-500'}`}>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <h3 id={`${id}-mo-${f.id}`} className="font-semibold text-gray-900 break-words">{f.nom}</h3>
                      <span className="font-mono text-xs text-gray-500 break-all">{f.reference}</span>
                      {!f.actif && <span className="text-[10px] uppercase bg-gray-100 rounded px-1.5 py-0.5">Désactivée</span>}
                    </div>
                    <p className="text-xs text-gray-500">{f.categorie?.nom || 'Sans catégorie'} · TVA {String(f.tauxTva).replace('.', ',')} %</p>
                    {enEdition ? (
                      <form onSubmit={(e) => { e.preventDefault(); void enregistrerPrix(f); }} className="space-y-3" aria-label={`Prix de ${f.nom}`}>
                        {[...PRIX_MAIN_OEUVRE.map(({ cle, libelle }) => ({ cle: cle as ChampModifiable, libelle: `${libelle} (€)` })), { cle: 'heuresParJour' as ChampModifiable, libelle: LIBELLE_HEURES_PAR_JOUR }].map(({ cle, libelle }) => (
                          <div key={cle} className="form-group mb-0">
                            <label className="form-label" htmlFor={`${id}-${f.id}-${cle}`}>{libelle}</label>
                            <input
                              id={`${id}-${f.id}-${cle}`}
                              className="form-input"
                              required
                              inputMode="decimal"
                              autoComplete="off"
                              value={enEdition.valeurs[cle]}
                              onChange={(e) => setEdition({ id: f.id, valeurs: { ...enEdition.valeurs, [cle]: e.target.value } })}
                            />
                          </div>
                        ))}
                        <div className="flex flex-wrap gap-2">
                          <button type="submit" className="btn btn-primary" disabled={envoi}>Enregistrer les prix</button>
                          <button type="button" className="btn btn-secondary" onClick={() => setEdition(null)}>Annuler</button>
                        </div>
                      </form>
                    ) : (
                      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[1fr_auto]">
                        {PRIX_MAIN_OEUVRE.map(({ cle, libelle }) => (
                          <div key={cle} className="contents">
                            <dt className="text-gray-500">{libelle}</dt>
                            <dd className="font-medium sm:text-right" data-prix={cle}>{formatEuros(f[cle])}</dd>
                          </div>
                        ))}
                        <div className="contents">
                          <dt className="text-gray-500">{LIBELLE_HEURES_PAR_JOUR}</dt>
                          <dd className="font-medium sm:text-right" data-prix="heuresParJour">{formatHeures(f.heuresParJour)}</dd>
                        </div>
                      </dl>
                    )}
                    {!enEdition && (
                      <div className="flex flex-wrap gap-3">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-sm text-blue-700"
                          aria-label={`Modifier les prix de ${f.nom}`}
                          onClick={() => { setErreur(''); setMessage(''); setEdition({ id: f.id, valeurs: {
                            prixVenteHt: valeurSaisie(f.prixVenteHt), prixJourHorsContratHt: valeurSaisie(f.prixJourHorsContratHt),
                            prixHeureSousContratHt: valeurSaisie(f.prixHeureSousContratHt), prixJourSousContratHt: valeurSaisie(f.prixJourSousContratHt),
                            heuresParJour: valeurSaisie(f.heuresParJour),
                          } }); }}
                        >
                          <Pencil size={14} aria-hidden="true" /> Modifier les prix
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-sm text-blue-700"
                          aria-label={`${f.actif ? 'Désactiver' : 'Réactiver'} ${f.nom}`}
                          disabled={envoi}
                          onClick={() => void basculerActif(f)}
                        >
                          <Power size={14} aria-hidden="true" /> {f.actif ? 'Désactiver' : 'Réactiver'}
                        </button>
                      </div>
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
