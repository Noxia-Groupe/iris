import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { HandCoins, RefreshCw, Undo2 } from 'lucide-react';
import { apiFetch } from '../api';
import { companyDateInputValue, formatCompanyDateTime, formatDateOnly } from '../lib/dateFormatting';
import { MOYENS_REGLEMENT, centimesDe, centimesSaisis, libelleMoyen, repartirReglement, saisieDeCentimes } from '../lib/reglements';

type ClientResume = { id: string; raisonSociale: string; actif?: boolean };
type FactureARegler = { id: string; numero: string; dateEmission: string; dateEcheance: string; totalTtc: number; resteDu: number; montantRegle: number; montantAvoirs: number; client: ClientResume };
type Reglement = {
  id: string;
  dateReglement: string;
  montant: number;
  moyen: string;
  reference: string | null;
  statut: 'ENREGISTRE' | 'CONTREPASSE';
  motifContrepassation: string | null;
  contrepasseLe: string | null;
  client: ClientResume;
  affectations: { id: string; montant: number; facture: { id: string; numero: string | null } }[];
  createdBy: { id: string; name: string } | null;
  contrepassePar: { id: string; name: string } | null;
};

const formatMontant = (montant: number) => montant.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const taillePage = 25;

// Règlements clients (décision A3 du 16-10-2026) : saisie manuelle des encaissements, affectés
// aux factures émises d'un client. Réservé à l'administration, comme la facturation.
export default function Reglements() {
  const [parametres] = useSearchParams();
  const factureCible = parametres.get('facture');
  const [reglements, setReglements] = useState<Reglement[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [aRegler, setARegler] = useState<FactureARegler[]>([]);
  const [fuseauHoraire, setFuseauHoraire] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);
  const [erreurListe, setErreurListe] = useState('');
  const [erreur, setErreur] = useState('');
  const [succes, setSucces] = useState('');
  const requete = useRef(0);
  const cibleAppliquee = useRef(false);

  const [ouvert, setOuvert] = useState(false);
  const [clientId, setClientId] = useState('');
  const [dateReglement, setDateReglement] = useState('');
  const [montant, setMontant] = useState('');
  const [moyen, setMoyen] = useState<string>('VIREMENT');
  const [reference, setReference] = useState('');
  const [parts, setParts] = useState<Record<string, string>>({});
  const [envoi, setEnvoi] = useState(false);

  const [aContrepasser, setAContrepasser] = useState<string | null>(null);
  const [motif, setMotif] = useState('');

  const nombrePages = Math.max(1, Math.ceil(total / taillePage));

  const charger = async (pageDemandee = page) => {
    const numero = ++requete.current;
    setChargement(true);
    setErreurListe('');
    try {
      const lire = async (chemin: string) => {
        const reponse = await apiFetch(chemin);
        const donnees = await reponse.json();
        if (!reponse.ok) throw new Error(donnees?.error || 'Chargement impossible.');
        return donnees;
      };
      const [liste, ouvertes, societe] = await Promise.all([
        lire(`/reglements?page=${pageDemandee}&pageSize=${taillePage}`), lire('/factures/a-regler'), lire('/company'),
      ]);
      if (numero !== requete.current) return;
      setReglements(liste.items);
      setTotal(liste.total);
      setARegler(ouvertes.factures);
      setFuseauHoraire(societe?.fuseauHoraire || 'Europe/Paris');
    } catch (e) {
      if (numero === requete.current) setErreurListe(e instanceof Error ? e.message : 'Chargement impossible.');
    } finally {
      if (numero === requete.current) setChargement(false);
    }
  };

  useEffect(() => { void charger(1); return () => { requete.current += 1; }; }, []);

  // Clients ayant au moins une facture à régler, chacun avec ses factures par échéance.
  const clients = useMemo(() => {
    const parClient = new Map<string, { client: ClientResume; factures: FactureARegler[] }>();
    for (const facture of aRegler) {
      const entree = parClient.get(facture.client.id) ?? { client: facture.client, factures: [] };
      entree.factures.push(facture);
      parClient.set(facture.client.id, entree);
    }
    return [...parClient.values()].sort((a, b) => a.client.raisonSociale.localeCompare(b.client.raisonSociale, 'fr'));
  }, [aRegler]);
  const facturesClient = clients.find((entree) => entree.client.id === clientId)?.factures ?? [];

  const ouvrirFormulaire = useCallback((factureId?: string) => {
    const facture = factureId ? aRegler.find((item) => item.id === factureId) : undefined;
    setErreur('');
    setSucces('');
    setClientId(facture?.client.id ?? '');
    setDateReglement(fuseauHoraire ? companyDateInputValue(fuseauHoraire) : '');
    setMontant(facture ? saisieDeCentimes(centimesDe(facture.resteDu)) : '');
    setMoyen('VIREMENT');
    setReference('');
    setParts(facture ? { [facture.id]: saisieDeCentimes(centimesDe(facture.resteDu)) } : {});
    setOuvert(true);
  }, [aRegler, fuseauHoraire]);

  // Depuis la liste des factures (« Enregistrer un règlement ») : le formulaire s'ouvre sur la
  // facture choisie, pour son reste dû, une seule fois après le premier chargement.
  useEffect(() => {
    if (!factureCible || cibleAppliquee.current || chargement || !fuseauHoraire) return;
    cibleAppliquee.current = true;
    if (aRegler.some((facture) => facture.id === factureCible)) ouvrirFormulaire(factureCible);
    else setErreur('Cette facture n’attend plus de règlement : elle est soldée, annulée ou n’est pas émise.');
  }, [factureCible, chargement, fuseauHoraire, aRegler, ouvrirFormulaire]);

  const choisirClient = (id: string) => {
    setClientId(id);
    setParts({});
  };

  const montantCentimes = centimesSaisis(montant);
  const partsCentimes = facturesClient.map((facture) => ({ facture, centimes: parts[facture.id]?.trim() ? centimesSaisis(parts[facture.id]) : 0 }));
  const partInvalide = partsCentimes.find((part) => part.centimes === null);
  const affecte = partsCentimes.reduce((somme, part) => somme + (part.centimes ?? 0), 0);
  const resteAAffecter = (montantCentimes ?? 0) - affecte;
  const depassement = partsCentimes.find((part) => (part.centimes ?? 0) > centimesDe(part.facture.resteDu));
  const envoyable = !!clientId && !!montantCentimes && !partInvalide && !depassement && resteAAffecter === 0 && !envoi;

  const repartir = () => {
    if (!montantCentimes) return setErreur('Saisissez d’abord le montant reçu.');
    setErreur('');
    const reparti = repartirReglement(montantCentimes, facturesClient);
    setParts(Object.fromEntries(Object.entries(reparti).map(([id, centimes]) => [id, centimes ? saisieDeCentimes(centimes) : ''])));
  };

  const enregistrer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!envoyable || montantCentimes === null) return;
    setErreur('');
    setSucces('');
    setEnvoi(true);
    try {
      const affectations = partsCentimes.filter((part) => (part.centimes ?? 0) > 0).map((part) => ({ factureId: part.facture.id, montant: ((part.centimes ?? 0) / 100).toFixed(2) }));
      const reponse = await apiFetch('/reglements', { method: 'POST', body: JSON.stringify({ clientId, dateReglement, montant: (montantCentimes / 100).toFixed(2), moyen, reference, affectations }) });
      const donnees = await reponse.json();
      if (!reponse.ok) {
        // Le reste dû a pu changer entre-temps (autre saisie, avoir) : relire les factures.
        if (reponse.status === 409) await charger(1);
        return setErreur(donnees?.error || 'Enregistrement du règlement impossible.');
      }
      setOuvert(false);
      setSucces(`Règlement de ${formatMontant(donnees.montant)} enregistré pour ${donnees.client.raisonSociale}.`);
      setPage(1);
      await charger(1);
    } finally {
      setEnvoi(false);
    }
  };

  const confirmerContrepassation = async (reglement: Reglement) => {
    setErreur('');
    setSucces('');
    const reponse = await apiFetch(`/reglements/${reglement.id}/contrepasser`, { method: 'POST', body: JSON.stringify({ motif }) });
    const donnees = await reponse.json();
    if (!reponse.ok) return setErreur(donnees?.error || 'Contre-passation impossible.');
    setAContrepasser(null);
    setMotif('');
    setSucces(`Règlement du ${formatDateOnly(reglement.dateReglement)} contre-passé : le reste dû de ses factures est rouvert.`);
    await charger(page);
  };

  const changerPage = (nouvelle: number) => {
    setPage(nouvelle);
    void charger(nouvelle);
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Règlements</h1>
          <p className="text-gray-500">Encaissements saisis à la main et affectés aux factures émises. Une saisie erronée se contre-passe.</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
          <button className="btn btn-secondary" onClick={() => void charger(page)}><RefreshCw size={16} /> Actualiser</button>
          <button className="btn btn-primary" disabled={chargement || !!erreurListe} onClick={() => ouvrirFormulaire()}><HandCoins size={16} /> Enregistrer un règlement</button>
        </div>
      </div>

      {erreur && <p role="alert" className="text-red-600">{erreur}</p>}
      {erreurListe && <p role="alert" className="text-red-600">{erreurListe}</p>}
      {succes && <p role="status" className="text-emerald-700">{succes}</p>}

      {ouvert && (
        <form aria-label="Nouveau règlement" className="rounded-xl border bg-white p-5 space-y-4" onSubmit={enregistrer}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Nouveau règlement</h2>
            <button type="button" className="btn btn-secondary" onClick={() => setOuvert(false)}>Annuler</button>
          </div>
          {!clients.length && <p className="text-sm text-gray-600">Aucune facture émise n’attend de règlement.</p>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1 text-sm font-medium sm:col-span-2">
              <span className="block">Client</span>
              <select required aria-label="Client du règlement" className="form-input w-full" value={clientId} onChange={(e) => choisirClient(e.target.value)}>
                <option value="">Client…</option>
                {clients.map(({ client, factures }) => (
                  <option key={client.id} value={client.id}>{client.raisonSociale}{client.actif === false ? ' (désactivé)' : ''} — {factures.length} facture(s), {formatMontant(factures.reduce((somme, facture) => somme + facture.resteDu, 0))} dus</option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium">
              <span className="block">Date du règlement</span>
              <input required aria-label="Date du règlement" className="form-input w-full" value={dateReglement} onChange={(e) => setDateReglement(e.target.value)} pattern="\d{2}-\d{2}-\d{4}" placeholder="JJ-MM-AAAA" />
            </label>
            <label className="space-y-1 text-sm font-medium">
              <span className="block">Montant reçu</span>
              <input required inputMode="decimal" aria-label="Montant reçu" className="form-input w-full" value={montant} onChange={(e) => setMontant(e.target.value)} placeholder="0,00" />
            </label>
            <label className="space-y-1 text-sm font-medium">
              <span className="block">Moyen</span>
              <select aria-label="Moyen de paiement" className="form-input w-full" value={moyen} onChange={(e) => setMoyen(e.target.value)}>
                {MOYENS_REGLEMENT.map((item) => <option key={item.valeur} value={item.valeur}>{item.libelle}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium sm:col-span-2 lg:col-span-3">
              <span className="block">Référence (facultative)</span>
              <input aria-label="Référence du règlement" maxLength={200} className="form-input w-full" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="N° de chèque, libellé du virement…" />
            </label>
          </div>

          {clientId && (
            <section aria-labelledby="factures-a-regler-titre" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 id="factures-a-regler-titre" className="font-medium">Factures à régler</h3>
                <button type="button" className="btn btn-secondary" onClick={repartir}>Répartir le montant</button>
              </div>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-gray-500">
                    <tr><th className="p-2">Facture</th><th className="p-2">Échéance</th><th className="p-2">Total TTC</th><th className="p-2">Reste dû</th><th className="p-2">Montant affecté</th></tr>
                  </thead>
                  <tbody>
                    {facturesClient.map((facture) => (
                      <tr key={facture.id} className="border-t">
                        <td className="p-2">{facture.numero}<span className="block text-xs text-gray-500">émise le {formatDateOnly(facture.dateEmission)}</span></td>
                        <td className="p-2">{formatDateOnly(facture.dateEcheance)}</td>
                        <td className="p-2">{formatMontant(facture.totalTtc)}</td>
                        <td className="p-2">{formatMontant(facture.resteDu)}</td>
                        <td className="p-2">
                          <input inputMode="decimal" aria-label={`Montant affecté à la facture ${facture.numero}`} className="form-input w-32" value={parts[facture.id] ?? ''} onChange={(e) => setParts((actuelles) => ({ ...actuelles, [facture.id]: e.target.value }))} placeholder="0,00" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p role="status" aria-label="Affectation du règlement" className={`text-sm ${resteAAffecter === 0 && !partInvalide && !depassement ? 'text-gray-600' : 'text-amber-700'}`}>
                Affecté : {saisieDeCentimes(affecte)} € sur {saisieDeCentimes(montantCentimes ?? 0)} €
                {resteAAffecter > 0 && ` — reste à affecter : ${saisieDeCentimes(resteAAffecter)} €`}
                {resteAAffecter < 0 && ` — affecté en trop : ${saisieDeCentimes(-resteAAffecter)} €`}
                {partInvalide && ` — montant invalide pour la facture ${partInvalide.facture.numero}`}
                {depassement && ` — la part de la facture ${depassement.facture.numero} dépasse son reste dû`}
              </p>
            </section>
          )}
          {montant && montantCentimes === null && <p className="text-sm text-amber-700">Le montant reçu doit être un nombre positif, avec au plus deux décimales.</p>}
          <button className="btn btn-primary" type="submit" disabled={!envoyable}><HandCoins size={16} /> Enregistrer le règlement</button>
        </form>
      )}

      <div className="overflow-x-auto rounded-xl border bg-white">
        <table aria-label="Règlements enregistrés" className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr><th className="p-3">Date</th><th className="p-3">Client</th><th className="p-3">Montant</th><th className="p-3">Moyen</th><th className="p-3">Factures</th><th className="p-3">Statut</th><th className="p-3">Actions</th></tr>
          </thead>
          <tbody>
            {reglements.map((reglement) => (
              <tr key={reglement.id} className="border-t align-top">
                <td className="p-3">{formatDateOnly(reglement.dateReglement)}</td>
                <td className="p-3">{reglement.client.raisonSociale}</td>
                <td className="p-3">{formatMontant(reglement.montant)}</td>
                <td className="p-3">{libelleMoyen(reglement.moyen)}{reglement.reference && <span className="block text-xs text-gray-500">Réf. {reglement.reference}</span>}</td>
                <td className="p-3">
                  <ul>{reglement.affectations.map((affectation) => <li key={affectation.id}>{affectation.facture.numero} : {formatMontant(affectation.montant)}</li>)}</ul>
                </td>
                <td className="p-3">
                  {reglement.statut === 'ENREGISTRE' ? 'Enregistré' : (
                    <span>Contre-passé{reglement.contrepasseLe && fuseauHoraire && ` le ${formatCompanyDateTime(reglement.contrepasseLe, fuseauHoraire)}`}{reglement.contrepassePar && ` par ${reglement.contrepassePar.name}`}
                      <span className="block text-xs text-gray-500">Motif : {reglement.motifContrepassation}</span>
                    </span>
                  )}
                  {reglement.createdBy && <span className="block text-xs text-gray-500">Saisi par {reglement.createdBy.name}</span>}
                </td>
                <td className="p-3">
                  {reglement.statut === 'ENREGISTRE' && (aContrepasser === reglement.id ? (
                    <form aria-label={`Contre-passation du règlement de ${formatMontant(reglement.montant)}`} className="space-y-2" onSubmit={(event) => { event.preventDefault(); void confirmerContrepassation(reglement); }}>
                      <input required minLength={3} maxLength={500} aria-label="Motif de la contre-passation" className="form-input w-56" value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif (chèque refusé, erreur de saisie…)" />
                      <div className="flex flex-wrap gap-2">
                        <button type="submit" className="btn btn-primary">Confirmer la contre-passation</button>
                        <button type="button" className="btn btn-secondary" onClick={() => { setAContrepasser(null); setMotif(''); }}>Annuler</button>
                      </div>
                    </form>
                  ) : (
                    <button type="button" className="btn btn-secondary" onClick={() => { setAContrepasser(reglement.id); setMotif(''); }}><Undo2 size={16} /> Contre-passer</button>
                  ))}
                </td>
              </tr>
            ))}
            {chargement && !reglements.length && <tr><td colSpan={7} role="status" className="p-5 text-center text-gray-500">Chargement des règlements…</td></tr>}
            {!chargement && !reglements.length && <tr><td colSpan={7} className="p-5 text-center text-gray-500">{erreurListe ? 'Règlements indisponibles. Réessayez avec Actualiser.' : 'Aucun règlement enregistré.'}</td></tr>}
          </tbody>
        </table>
      </div>
      <nav aria-label="Pagination des règlements" className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => changerPage(page - 1)}>Page précédente</button>
        <span>Page {page} sur {nombrePages} — {total} règlement(s)</span>
        <button type="button" className="btn btn-secondary" disabled={page >= nombrePages} onClick={() => changerPage(page + 1)}>Page suivante</button>
      </nav>
      <p className="text-sm text-gray-500">Les factures et leur reste dû sont aussi visibles dans <Link className="text-emerald-700 underline" to="/factures">Factures</Link>.</p>
    </div>
  );
}
