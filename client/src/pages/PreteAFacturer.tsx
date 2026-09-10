import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api';

type Controle = { cle: string; bloquant: boolean; pret: boolean; libelle: string; detail: string; route: string | null };
type Diagnostic = { pret: boolean; controles: Controle[] };

export default function PreteAFacturer() {
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null), [erreur, setErreur] = useState('');
  const charger = async () => { setErreur(''); const res = await apiFetch('/facturation/prete-a-facturer'); const data = await res.json(); if (!res.ok) return setErreur(data.error || 'Chargement impossible.'); setDiagnostic(data); };
  useEffect(() => { void charger(); }, []);
  return <div className="max-w-4xl mx-auto space-y-6"><div className="flex justify-between gap-3"><div><h1 className="text-2xl font-bold">Prêt à facturer</h1><p className="text-gray-500">Vérifiez les prérequis avant la première émission.</p></div><button className="btn btn-secondary" onClick={() => void charger()}><RefreshCw size={16}/> Actualiser</button></div>{erreur && <p className="text-red-600">{erreur}</p>}{diagnostic && <><div className={`rounded-xl border p-4 ${diagnostic.pret ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>{diagnostic.pret ? 'Configuration prête pour la facturation.' : 'Des prérequis doivent encore être configurés.'}</div><div className="space-y-3">{diagnostic.controles.map(controle => <article key={controle.cle} className="rounded-xl border bg-white p-4 flex items-center justify-between gap-4"><div className="flex gap-3"><span className={controle.pret ? 'text-emerald-600' : 'text-amber-600'}>{controle.pret ? <CheckCircle2/> : <CircleAlert/>}</span><div><h2 className="font-semibold flex items-center gap-2">{controle.libelle}{!controle.bloquant && <span className="text-xs font-normal rounded-full border px-2 py-0.5 text-gray-500">Non bloquant</span>}</h2><p className="text-sm text-gray-500">{controle.detail}</p></div></div>{!controle.pret && controle.route && <Link className="btn btn-secondary" to={controle.route}>Configurer</Link>}</article>)}</div></>}</div>;
}
