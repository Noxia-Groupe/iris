import { useEffect, useState } from 'react';
import { BookOpen, Plus, FolderTree, Power } from 'lucide-react';
import { apiFetch } from '../api';

/**
 * Catalogue natif Iris : prestations, articles et équipements.
 *
 * Les trois familles partagent la même fiche (référence, nom, catégorie, prix, TVA) et
 * n'ajoutent chacune que ce qui leur est propre — durée pour une prestation, stock pour un
 * article, fabricant pour un équipement. L'écran suit la même logique que l'API : un seul
 * formulaire, dont seul le bloc spécifique change selon l'onglet.
 *
 * Une fiche n'est jamais supprimée, seulement désactivée : elle peut déjà être référencée
 * par un équipement installé chez un client, et demain par un devis.
 */
type Categorie = { id: string; nom: string; parentId: string | null };
type Fiche = {
  id: string; reference: string; nom: string; description: string | null; categorieId: string | null;
  categorie?: { nom: string } | null; tauxTva: number; prixVenteHt: number; actif: boolean;
  unite?: string; dureeIndicativeMin?: number | null;
  prixAchatHt?: number | null; stockSuivi?: boolean; stockActuel?: number;
  fabricant?: string | null;
};

const FAMILLES = [
  { cle: 'prestations', libelle: 'Prestations' },
  { cle: 'articles', libelle: 'Articles' },
  { cle: 'equipements', libelle: 'Équipements' },
] as const;
type Famille = typeof FAMILLES[number]['cle'];

const ficheVide = {
  reference: '', nom: '', description: '', categorieId: '', tauxTva: '20', prixVenteHt: '0',
  unite: 'unité', dureeIndicativeMin: '', prixAchatHt: '', stockSuivi: false, stockActuel: '0', fabricant: '',
};

const Catalogue = () => {
  const [famille, setFamille] = useState<Famille>('prestations');
  const [fiches, setFiches] = useState<Fiche[]>([]);
  const [categories, setCategories] = useState<Categorie[]>([]);
  const [saisie, setSaisie] = useState({ ...ficheVide });
  const [nouvelleCategorie, setNouvelleCategorie] = useState('');
  const [erreur, setErreur] = useState('');
  const [chargement, setChargement] = useState(true);

  const charger = async (f: Famille) => {
    setChargement(true);
    try {
      const [resFiches, resCategories] = await Promise.all([
        apiFetch(`/catalogue/${f}`),
        apiFetch('/catalogue/categories'),
      ]);
      const donneesFiches = await resFiches.json();
      const donneesCategories = await resCategories.json();
      if (!resFiches.ok) throw new Error(donneesFiches.error || 'Chargement impossible.');
      setFiches(donneesFiches);
      setCategories(resCategories.ok ? donneesCategories : []);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Chargement impossible.');
    } finally {
      setChargement(false);
    }
  };
  useEffect(() => { void charger(famille); }, [famille]);

  const creerCategorie = async (e: React.FormEvent) => {
    e.preventDefault();
    setErreur('');
    const res = await apiFetch('/catalogue/categories', { method: 'POST', body: JSON.stringify({ nom: nouvelleCategorie }) });
    const data = await res.json();
    if (!res.ok) { setErreur(data.error || 'Création impossible.'); return; }
    setNouvelleCategorie('');
    await charger(famille);
  };

  const creerFiche = async (e: React.FormEvent) => {
    e.preventDefault();
    setErreur('');
    // On n'envoie que les champs qui concernent la famille affichée : le serveur ignore
    // les autres, mais les omettre évite d'enregistrer un stock sur une prestation.
    const commun = {
      reference: saisie.reference, nom: saisie.nom, description: saisie.description,
      categorieId: saisie.categorieId || null, tauxTva: saisie.tauxTva, prixVenteHt: saisie.prixVenteHt,
    };
    const specifique =
      famille === 'prestations' ? { unite: saisie.unite, dureeIndicativeMin: saisie.dureeIndicativeMin || null }
      : famille === 'articles' ? { unite: saisie.unite, prixAchatHt: saisie.prixAchatHt || null, stockSuivi: saisie.stockSuivi, stockActuel: saisie.stockActuel }
      : { fabricant: saisie.fabricant };
    const res = await apiFetch(`/catalogue/${famille}`, { method: 'POST', body: JSON.stringify({ ...commun, ...specifique }) });
    const data = await res.json();
    if (!res.ok) { setErreur(data.error || 'Création impossible.'); return; }
    setSaisie({ ...ficheVide });
    await charger(famille);
  };

  const basculerActif = async (fiche: Fiche) => {
    setErreur('');
    // Réactiver passe par PUT (la fiche entière), désactiver par DELETE (désactivation).
    const res = fiche.actif
      ? await apiFetch(`/catalogue/${famille}/${fiche.id}`, { method: 'DELETE' })
      : await apiFetch(`/catalogue/${famille}/${fiche.id}`, {
          method: 'PUT',
          body: JSON.stringify({ ...fiche, categorieId: fiche.categorieId || null, actif: true }),
        });
    if (!res.ok) { setErreur('Modification impossible.'); return; }
    await charger(famille);
  };

  const champ = (cle: keyof typeof ficheVide, libelle: string, type = 'text', requis = false) => (
    <div className="form-group">
      <label className="form-label">{libelle}</label>
      <input
        type={type}
        required={requis}
        step={type === 'number' ? 'any' : undefined}
        value={String(saisie[cle] ?? '')}
        onChange={(e) => setSaisie({ ...saisie, [cle]: e.target.value })}
        className="form-input"
      />
    </div>
  );

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <BookOpen className="text-blue-700" size={26} />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Catalogue</h1>
          <p className="text-gray-500">Prestations, articles et équipements de votre référentiel — base des futurs devis.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {FAMILLES.map((f) => (
          <button
            key={f.cle}
            onClick={() => setFamille(f.cle)}
            className={`px-4 py-2 rounded-lg text-sm font-medium ${famille === f.cle ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-700'}`}
          >
            {f.libelle}
          </button>
        ))}
      </div>

      {erreur && <div className="p-3 bg-red-100 text-red-700 rounded-md text-sm">{erreur}</div>}

      <section className="bg-white border border-gray-100 rounded-xl p-5">
        <h2 className="font-semibold flex items-center gap-2 text-gray-800"><FolderTree size={18} /> Catégories</h2>
        <p className="text-sm text-gray-500 mt-1">Communes aux trois familles. Elles n'imposent aucune nomenclature : nommez-les comme votre métier.</p>
        <div className="flex flex-wrap gap-2 mt-3">
          {categories.map((c) => <span key={c.id} className="text-xs bg-gray-100 text-gray-700 rounded-full px-3 py-1">{c.nom}</span>)}
          {categories.length === 0 && <span className="text-sm text-gray-400">Aucune catégorie pour l'instant.</span>}
        </div>
        <form onSubmit={creerCategorie} className="flex gap-2 mt-4">
          <input value={nouvelleCategorie} onChange={(e) => setNouvelleCategorie(e.target.value)} placeholder="Ex. Alarme, Vidéosurveillance…" className="form-input flex-1" required />
          <button type="submit" className="btn btn-secondary">Ajouter</button>
        </form>
      </section>

      <section className="bg-white border border-gray-100 rounded-xl p-5">
        <h2 className="font-semibold flex items-center gap-2 text-gray-800"><Plus size={18} /> Nouvelle fiche</h2>
        <form onSubmit={creerFiche} className="mt-4 space-y-4">
          <div className="grid md:grid-cols-3 gap-4">
            {champ('reference', 'Référence *', 'text', true)}
            {champ('nom', 'Désignation *', 'text', true)}
            <div className="form-group">
              <label className="form-label">Catégorie</label>
              <select value={saisie.categorieId} onChange={(e) => setSaisie({ ...saisie, categorieId: e.target.value })} className="form-input">
                <option value="">Sans catégorie</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
              </select>
            </div>
            {champ('prixVenteHt', 'Prix de vente HT (€)', 'number')}
            {champ('tauxTva', 'TVA (%)', 'number')}
            {famille === 'equipements' && champ('fabricant', 'Fabricant')}
            {famille !== 'equipements' && champ('unite', 'Unité')}
            {famille === 'prestations' && champ('dureeIndicativeMin', 'Durée indicative (min)', 'number')}
            {famille === 'articles' && champ('prixAchatHt', "Prix d'achat HT (€)", 'number')}
            {famille === 'articles' && champ('stockActuel', 'Stock actuel', 'number')}
          </div>
          {famille === 'articles' && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={saisie.stockSuivi} onChange={(e) => setSaisie({ ...saisie, stockSuivi: e.target.checked })} className="w-4 h-4" />
              Suivre le stock de cet article
            </label>
          )}
          {champ('description', 'Description')}
          <button type="submit" className="btn btn-primary">Créer la fiche</button>
        </form>
      </section>

      <section className="bg-white border border-gray-100 rounded-xl overflow-hidden">
        {chargement ? <p className="p-6 text-gray-500">Chargement…</p> : fiches.length === 0 ? (
          <p className="p-8 text-center text-gray-500">Aucune fiche dans cette famille. Créez la première ci-dessus.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs uppercase text-gray-500 border-b border-gray-100">
                <th className="px-4 py-3 text-left font-semibold">Référence</th>
                <th className="px-4 py-3 text-left font-semibold">Désignation</th>
                <th className="px-4 py-3 text-left font-semibold">Catégorie</th>
                <th className="px-4 py-3 text-right font-semibold">Prix HT</th>
                <th className="px-4 py-3 text-right font-semibold">TVA</th>
                <th className="px-4 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {fiches.map((f) => (
                <tr key={f.id} className={f.actif ? '' : 'text-gray-400'}>
                  <td className="px-4 py-3 font-mono text-xs">{f.reference}</td>
                  <td className="px-4 py-3">
                    {f.nom}
                    {!f.actif && <span className="ml-2 text-[10px] uppercase bg-gray-100 rounded px-1.5 py-0.5">Désactivée</span>}
                  </td>
                  <td className="px-4 py-3">{f.categorie?.nom || '—'}</td>
                  <td className="px-4 py-3 text-right">{Number(f.prixVenteHt).toFixed(2)} €</td>
                  <td className="px-4 py-3 text-right">{Number(f.tauxTva).toFixed(2)} %</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => void basculerActif(f)} className="inline-flex items-center gap-1 text-xs text-blue-700">
                      <Power size={14} /> {f.actif ? 'Désactiver' : 'Réactiver'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
};

export default Catalogue;
