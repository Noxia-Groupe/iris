import { RotateCcw } from 'lucide-react';
import { formatCompanyDate, instantaneLisible } from '../lib/dateFormatting';
import { changementAffaire, titreEntreeJournal } from '../lib/journalChantier';

export function ChantierJournalAudit({ journalSaisies, companyTimezone, peutArchiverTravaux, archivesRestaurables, handleRestore, savingAchat, savingPointage }: {
  journalSaisies: any[];
  companyTimezone: string;
  peutArchiverTravaux: boolean;
  archivesRestaurables: Set<string>;
  handleRestore: (cible: 'ACHAT' | 'HEURE', cibleId: string) => void;
  savingAchat: boolean;
  savingPointage: boolean;
}) {
  return (
        <section aria-labelledby="journal-saisies-titre" className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 id="journal-saisies-titre" className="font-bold text-primary-dark">Journal d’audit des saisies</h2>
            <p className="text-sm text-gray-500 mt-1">Historique immuable des créations, corrections et archivages du chantier, et des changements de son client, de son titulaire, de son commercial et de son encaissement.</p>
          </div>
          {journalSaisies.length === 0 ? (
            <p className="px-6 py-5 text-sm italic text-gray-400">Aucune entrée au journal de ce chantier.</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {journalSaisies.map((entree) => (
                <div key={entree.id} className="px-6 py-4 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong>{titreEntreeJournal(entree)}</strong>
                    <span className="text-gray-500">{formatCompanyDate(entree.createdAt, companyTimezone)} · {entree.auteurNom}</span>
                  </div>
                  {entree.motif && <p className="mt-1 text-gray-600">Motif : {entree.motif}</p>}
                  {(() => { const changement = changementAffaire(entree); return changement && (
                    <div className="mt-2 grid gap-2 md:grid-cols-2 text-xs">
                      <p className="rounded bg-red-50 p-2 text-red-900">Avant : {changement.avant}</p>
                      <p className="rounded bg-emerald-50 p-2 text-emerald-900">Après : {changement.apres}</p>
                    </div>
                  ); })()}
                  {entree.action === 'CORRECTION' && (
                    <div className="mt-2 grid gap-2 md:grid-cols-2 text-xs">
                      <pre className="overflow-auto rounded bg-red-50 p-2 text-red-900">Avant : {instantaneLisible(entree.avant, companyTimezone)}</pre>
                      <pre className="overflow-auto rounded bg-emerald-50 p-2 text-emerald-900">Après : {instantaneLisible(entree.apres, companyTimezone)}</pre>
                    </div>
                  )}
                  {entree.action === 'CREATION' && entree.apres && (
                    <pre className="mt-2 overflow-auto rounded bg-emerald-50 p-2 text-xs text-emerald-900">Valeurs enregistrées : {instantaneLisible(entree.apres, companyTimezone)}</pre>
                  )}
                  {entree.action === 'ARCHIVAGE' && entree.avant && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <pre className="overflow-auto rounded bg-amber-50 p-2 text-xs text-amber-900">Valeurs archivées : {instantaneLisible(entree.avant, companyTimezone)}</pre>
                      {peutArchiverTravaux && archivesRestaurables.has(entree.id) && (
                        <button
                          type="button"
                          onClick={() => handleRestore(entree.cible, entree.cibleId)}
                          disabled={savingAchat || savingPointage}
                          className="btn border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 hover:bg-emerald-100"
                        >
                          <RotateCcw size={14} /> Restaurer
                        </button>
                      )}
                    </div>
                  )}
                  {entree.action === 'RESTAURATION' && entree.apres && (
                    <pre className="mt-2 overflow-auto rounded bg-emerald-50 p-2 text-xs text-emerald-900">Valeurs restaurées : {instantaneLisible(entree.apres, companyTimezone)}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
  );
}
