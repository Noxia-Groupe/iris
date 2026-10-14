import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api';
import { TYPES_CHANTIER } from '../chantierTypes';
import { useCompanyTimezone } from '../companyTimezoneContext';
import { companyDateInputValue } from '../lib/dateFormatting';

type DevisAConvertir = { id: string; numero: string; version: number; objet: string; totalHt: number; client: { id: string; raisonSociale: string } };
type Compte = { id: string; name: string };
type Resultat = { ok: boolean; texte: string; chantierId?: string };

const euros = (montant: number) => montant.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

// Ouverture du chantier d'une affaire depuis l'Administration (décision de Nelson du 14-10-2026).
// Un chantier n'existe que par la conversion du devis signé de son affaire, et chaque affaire
// n'en a qu'un : le formulaire part de ce devis, dont le chantier reprend le client, la
// référence, le montant et les heures vendus, et fixe en même temps le titulaire, le
// commercial, les types et la date de début. Les refus du serveur sont affichés tels quels.
export default function OuvrirChantierAffaire({ onOuvert }: { onOuvert: () => void }) {
  const fuseau = useCompanyTimezone();
  const [devis, setDevis] = useState<DevisAConvertir[] | null>(null);
  const [conducteurs, setConducteurs] = useState<Compte[]>([]);
  const [commerciaux, setCommerciaux] = useState<Compte[]>([]);
  const [erreurChargement, setErreurChargement] = useState(false);
  const [devisId, setDevisId] = useState('');
  // Listes contrôlées, comme le devis : relues après un refus, elles ne doivent jamais remplacer
  // en silence un compte choisi puis désactivé par le premier de la liste (règle de sélection HTML).
  const [responsableId, setResponsableId] = useState('');
  const [commercialId, setCommercialId] = useState('');
  const [dateDebut, setDateDebut] = useState(() => companyDateInputValue(fuseau));
  const dateSaisie = useRef(false);
  const [envoi, setEnvoi] = useState(false);
  const [resultat, setResultat] = useState<Resultat | null>(null);
  const formulaire = useRef<HTMLFormElement>(null);
  // Numéro du dernier chargement : la réponse d'un chargement dépassé est ignorée.
  const dernierChargement = useRef(0);

  const charger = useCallback(async () => {
    const chargement = ++dernierChargement.current;
    try {
      const reponses = await Promise.all(['/devis/a-convertir', '/conducteurs', '/commerciaux'].map((chemin) => apiFetch(chemin)));
      if (reponses.some((r) => !r.ok)) throw new Error('Chargement impossible');
      const [listeDevis, listeConducteurs, listeCommerciaux] = await Promise.all(reponses.map((r) => r.json()));
      if (chargement !== dernierChargement.current) return;
      setDevis(listeDevis);
      setConducteurs(listeConducteurs);
      setCommerciaux(listeCommerciaux);
      setErreurChargement(false);
      // Un devis converti entre-temps (depuis l'écran Devis, par exemple) n'est plus proposé.
      setDevisId((choisi) => (listeDevis.some((d: DevisAConvertir) => d.id === choisi) ? choisi : ''));
      // Un compte désactivé entre-temps n'est plus proposé : le choix revient à vide, à refaire.
      setResponsableId((choisi) => (listeConducteurs.some((c: Compte) => c.id === choisi) ? choisi : ''));
      setCommercialId((choisi) => (listeCommerciaux.some((c: Compte) => c.id === choisi) ? choisi : ''));
    } catch {
      if (chargement === dernierChargement.current) setErreurChargement(true);
    }
  }, []);
  useEffect(() => { void charger(); }, [charger]);
  // Date de début préremplie au jour de la société tant qu'elle n'a pas été saisie : le fuseau
  // de la société peut n'être connu qu'après l'ouverture de l'écran.
  useEffect(() => {
    if (!dateSaisie.current) setDateDebut(companyDateInputValue(fuseau));
  }, [fuseau]);

  const choisi = devis?.find((d) => d.id === devisId);

  const ouvrir = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!choisi || envoi) return;
    const champs = new FormData(e.currentTarget);
    setEnvoi(true);
    setResultat(null);
    try {
      const res = await apiFetch(`/devis/${choisi.id}/convertir`, {
        method: 'POST',
        body: JSON.stringify({
          cible: 'CHANTIER',
          responsableId: champs.get('responsableId'),
          // Sans commercial actif, aucun n'est proposé : le chantier s'ouvre sans, comme depuis
          // l'écran Devis, et se rattache plus tard depuis sa fiche.
          ...(commerciaux.length > 0 ? { commercialId: champs.get('commercialId') } : {}),
          types: champs.getAll('types'),
          dateDebut,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResultat({ ok: false, texte: data.error || 'Ouverture du chantier impossible.' });
        // Devis converti, annulé ou remis en attente d'acompte entre-temps, compte désactivé : les
        // listes sont relues pour ne plus proposer ce qui ne peut plus servir ; un choix retiré
        // revient à vide, sans être remplacé.
        void charger();
        return;
      }
      setResultat({ ok: true, texte: `Chantier « ${data.nom} » ouvert pour l’affaire ${data.numeroDevis}.`, chantierId: data.id });
      formulaire.current?.reset();
      setDevisId('');
      setResponsableId('');
      setCommercialId('');
      dateSaisie.current = false;
      setDateDebut(companyDateInputValue(fuseau));
      void charger();
      onOuvert();
    } catch {
      setResultat({ ok: false, texte: 'Impossible de joindre le serveur.' });
    } finally {
      setEnvoi(false);
    }
  };

  return (
    <section aria-labelledby="titre-ouverture-chantier">
      <h2 id="titre-ouverture-chantier" className="mb-2 text-primary-dark">Ouvrir le chantier d’une affaire</h2>
      <p className="text-sm text-gray-600 mb-4">
        Un chantier s’ouvre à partir du devis signé de son affaire : il en reprend le client, la référence, le montant
        et les heures vendus. Chaque affaire n’a qu’un chantier ; une fois ouvert, il se modifie et se réattribue
        depuis sa fiche.
      </p>
      {resultat && (
        <div role={resultat.ok ? 'status' : 'alert'} className={`mb-4 p-3 rounded border text-sm ${resultat.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
          {resultat.texte}
          {resultat.chantierId && <> <Link to={`/chantiers/${resultat.chantierId}`} className="font-semibold underline">Ouvrir la fiche du chantier</Link></>}
        </div>
      )}
      {erreurChargement && (
        <div role="alert" className="mb-4 p-3 rounded border bg-amber-50 border-amber-200 text-amber-800 text-sm">
          Les devis à convertir n’ont pas pu être chargés.{' '}
          <button type="button" className="font-semibold underline" onClick={() => void charger()}>Réessayer</button>
        </div>
      )}
      {devis === null ? (
        !erreurChargement && <p className="text-muted text-sm">Chargement des devis signés…</p>
      ) : devis.length === 0 ? (
        <p className="text-muted text-sm">
          Aucun devis signé n’attend l’ouverture de son chantier. Un devis s’y prête une fois accepté et signé, et son
          acompte constaté s’il en exige un : voir l’écran <Link to="/devis" className="underline">Devis</Link>.
        </p>
      ) : (
        <form ref={formulaire} onSubmit={ouvrir} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="form-group mb-0 md:col-span-2">
            <label className="form-label" htmlFor="ouverture-devis">Devis signé de l’affaire</label>
            <select id="ouverture-devis" required className="form-input" value={devisId} onChange={(e) => setDevisId(e.target.value)}>
              <option value="" disabled>Sélectionner un devis…</option>
              {devis.map((d) => (
                <option key={d.id} value={d.id}>{d.numero} (v{d.version}) — {d.client.raisonSociale} — {d.objet}</option>
              ))}
            </select>
            {choisi && (
              <p className="text-sm text-gray-600 mt-2 break-words">
                Chantier « {choisi.objet} » pour {choisi.client.raisonSociale}, vendu {euros(choisi.totalHt)} HT.
              </p>
            )}
          </div>
          <div className="form-group mb-0">
            <label className="form-label" htmlFor="ouverture-responsable">Responsable du chantier</label>
            <select id="ouverture-responsable" required name="responsableId" className="form-input" value={responsableId} onChange={(e) => setResponsableId(e.target.value)} aria-describedby={conducteurs.length === 0 ? 'ouverture-sans-conducteur' : undefined}>
              <option value="" disabled>Sélectionner un conducteur…</option>
              {conducteurs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {conducteurs.length === 0 && (
              <p id="ouverture-sans-conducteur" className="text-sm text-amber-700 mt-1">
                Aucun conducteur actif : créez ou réactivez un compte conducteur dans Administration &gt; Utilisateurs.
              </p>
            )}
          </div>
          <div className="form-group mb-0">
            <label className="form-label" htmlFor="ouverture-commercial">Commercial rattaché{commerciaux.length > 0 ? '' : ' (aucun disponible)'}</label>
            <select id="ouverture-commercial" required={commerciaux.length > 0} disabled={commerciaux.length === 0} name="commercialId" className="form-input" value={commercialId} onChange={(e) => setCommercialId(e.target.value)}>
              <option value="" disabled>Sélectionner un commercial…</option>
              {commerciaux.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group mb-0">
            <label className="form-label" htmlFor="ouverture-date">Date de début</label>
            <input
              id="ouverture-date" required type="text" inputMode="numeric" pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA"
              className="form-input" value={dateDebut}
              onChange={(e) => { dateSaisie.current = true; setDateDebut(e.target.value); }}
            />
          </div>
          <fieldset className="form-group mb-0 md:col-span-2">
            <legend className="form-label">Type(s) de chantier</legend>
            <div className="flex flex-wrap gap-2">
              {TYPES_CHANTIER.map((t) => (
                <label key={t} className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors">
                  <input type="checkbox" name="types" value={t} className="w-4 h-4" />
                  {t}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="md:col-span-2">
            <button type="submit" disabled={envoi || !choisi} className="btn btn-primary w-full md:w-auto px-8">
              {envoi ? 'Ouverture…' : 'Ouvrir le chantier'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
