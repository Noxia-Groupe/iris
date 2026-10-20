import { cheminsSvg, type TraceSignature as Trace } from '../lib/traceSignature';

// Réaffiche la signature dessinée d'un compte rendu, à partir de son tracé enregistré.
export function TraceSignature({ trace, signataire }: { trace: Trace; signataire: string }) {
  return <svg role="img" aria-label={`Signature de ${signataire}`} viewBox={`0 0 ${trace.ratio * 100} 100`} className="mt-1 h-12 max-w-[12rem] rounded border border-gray-200 bg-white" preserveAspectRatio="xMidYMid meet">
    {cheminsSvg(trace).map((chemin, index) => <path key={index} d={chemin} fill="none" stroke="#111827" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />)}
  </svg>;
}
