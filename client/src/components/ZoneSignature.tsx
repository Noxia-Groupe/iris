import { useEffect, useRef, useState } from 'react';
import { commencerTrait, nombreDePoints, pointNormalise, prolongerTrait, traceSuffisant, type Point, type TraceSignature } from '../lib/traceSignature';

// Zone où le client signe au doigt, au stylet ou à la souris (lot pilote 3b-3). Le tracé est gardé
// en coordonnées normalisées : il se redessine à toute taille, sans horodatage ni pression.
export function ZoneSignature({ onChange, desactivee = false }: { onChange: (trace: TraceSignature | null) => void; desactivee?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const traits = useRef<Point[][]>([]);
  const enCours = useRef(false);
  // Un seul doigt trace à la fois : les autres pointeurs (paume, second doigt) sont ignorés.
  const pointeur = useRef<number | null>(null);
  const [borneAtteinte, setBorneAtteinte] = useState(false);
  const [vide, setVide] = useState(true);

  const dimensions = () => {
    const zone = canvas.current!.getBoundingClientRect();
    return { largeur: Math.max(zone.width, 1), hauteur: Math.max(zone.height, 1) };
  };

  // Redessine tout le tracé à la taille affichée, nette sur les écrans à haute densité.
  const redessiner = () => {
    const element = canvas.current;
    if (!element) return;
    const { largeur, hauteur } = dimensions();
    const densite = window.devicePixelRatio || 1;
    element.width = Math.round(largeur * densite);
    element.height = Math.round(hauteur * densite);
    const contexte = element.getContext('2d');
    if (!contexte) return;
    contexte.setTransform(densite, 0, 0, densite, 0, 0);
    contexte.clearRect(0, 0, largeur, hauteur);
    contexte.lineWidth = 2.5;
    contexte.lineCap = 'round';
    contexte.lineJoin = 'round';
    contexte.strokeStyle = '#111827';
    for (const trait of traits.current) {
      contexte.beginPath();
      trait.forEach(([x, y], index) => (index ? contexte.lineTo(x * largeur, y * hauteur) : contexte.moveTo(x * largeur, y * hauteur)));
      if (trait.length === 1) contexte.lineTo(trait[0][0] * largeur + 0.1, trait[0][1] * hauteur);
      contexte.stroke();
    }
  };

  useEffect(() => {
    redessiner();
    const surRedimensionnement = () => redessiner();
    window.addEventListener('resize', surRedimensionnement);
    return () => window.removeEventListener('resize', surRedimensionnement);
  }, []);

  const publier = () => {
    const { largeur, hauteur } = dimensions();
    const suffisant = traceSuffisant(traits.current);
    setVide(nombreDePoints(traits.current) === 0);
    onChange(suffisant ? { ratio: Math.round((largeur / hauteur) * 1000) / 1000, traits: traits.current.map((trait) => trait.map(([x, y]) => [x, y] as Point)) } : null);
  };

  const pointDe = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const zone = canvas.current!.getBoundingClientRect();
    return pointNormalise(event.clientX - zone.left, event.clientY - zone.top, Math.max(zone.width, 1), Math.max(zone.height, 1));
  };

  const debut = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (desactivee || enCours.current) return;
    event.preventDefault();
    canvas.current!.setPointerCapture?.(event.pointerId);
    if (!commencerTrait(traits.current, pointDe(event))) { setBorneAtteinte(true); return; }
    enCours.current = true;
    pointeur.current = event.pointerId;
    redessiner();
  };
  const mouvement = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!enCours.current || event.pointerId !== pointeur.current) return;
    event.preventDefault();
    const { largeur, hauteur } = dimensions();
    if (!prolongerTrait(traits.current, pointDe(event), largeur / hauteur)) setBorneAtteinte(true);
    redessiner();
  };
  const fin = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!enCours.current || event.pointerId !== pointeur.current) return;
    enCours.current = false;
    pointeur.current = null;
    publier();
  };
  const effacer = () => {
    traits.current = [];
    enCours.current = false;
    pointeur.current = null;
    setBorneAtteinte(false);
    redessiner();
    publier();
  };

  // Largeur bornée (max-w-xl, 36 rem pour 10 rem de haut) : sur un écran large, les proportions de la
  // zone resteraient sinon au-delà de celles que le serveur admet (10 au plus), et la signature serait refusée.
  return <div className="space-y-2">
    <canvas
      ref={canvas}
      role="img"
      aria-label="Zone de signature du client"
      className={`block h-40 w-full max-w-xl rounded-lg border-2 border-dashed bg-white ${desactivee ? 'border-gray-200' : 'border-gray-400'}`}
      style={{ touchAction: 'none' }}
      onPointerDown={debut}
      onPointerMove={mouvement}
      onPointerUp={fin}
      onPointerCancel={fin}
      onPointerLeave={fin}
    />
    <div className="flex items-center justify-between gap-2 text-sm">
      <p className="text-gray-500">{vide ? 'Le client signe dans le cadre, au doigt.' : 'Signature dessinée.'}</p>
      <button type="button" className="btn btn-secondary" onClick={effacer} disabled={desactivee || vide}>Effacer la signature</button>
    </div>
    {borneAtteinte && <p role="alert" className="text-sm text-red-700">La signature atteint la taille maximale : effacez-la et recommencez plus simplement.</p>}
  </div>;
}
