export type LignePlanComptable = { code: string; libelle: string; nature: string };
const contientControle = (texte: string) => Array.from(texte).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

export function parserPlanComptableCsv(texte: string): LignePlanComptable[] {
  return parserPlanComptableCsvAvecLignes(texte).lignes;
}

export function parserPlanComptableCsvAvecLignes(texte: string): { lignes: LignePlanComptable[]; numeros: number[] } {
  const contenu = texte.replace(/^\uFEFF/, '');
  let virgules = 0;
  let pointsVirgules = 0;
  let cite = false;
  for (let i = 0; i < contenu.length; i += 1) {
    const caractere = contenu[i];
    if (caractere === '"') {
      if (cite && contenu[i + 1] === '"') i += 1;
      else cite = !cite;
    } else if (!cite) {
      if (caractere === '\n' || caractere === '\r') break;
      if (caractere === ',') virgules += 1;
      if (caractere === ';') pointsVirgules += 1;
    }
  }
  const separateur = virgules > pointsVirgules ? ',' : ';';
  const lignes: { champs: string[]; numero: number }[] = [];
  let champs: string[] = [];
  let champ = '';
  let etat: 'debut' | 'simple' | 'cite' | 'termine' = 'debut';
  let numero = 1;
  let debut = 1;
  let contientChampCsv = false;
  const ajouterChamp = () => {
    if (champs.length === 1 && contientControle(champ)) throw new Error(`Ligne ${debut} : libellé contenant un caractère de contrôle interdit.`);
    champs.push(champ.trim());
  };
  const finir = () => {
    ajouterChamp();
    if (contientChampCsv || champs.some(valeur => valeur !== '')) lignes.push({ champs, numero: debut });
    champs = [];
    champ = '';
    etat = 'debut';
    contientChampCsv = false;
    debut = numero + 1;
  };
  for (let i = 0; i < contenu.length; i += 1) {
    const c = contenu[i];
    if (etat === 'cite') {
      if (c === '"') {
        if (contenu[i + 1] === '"') { champ += '"'; i += 1; }
        else etat = 'termine';
      } else {
        champ += c;
        if (c === '\n' || (c === '\r' && contenu[i + 1] !== '\n')) numero += 1;
      }
      continue;
    }
    if (c === '"') {
      if (etat !== 'debut') throw new Error(`Ligne ${numero} : guillemet mal placé.`);
      contientChampCsv = true;
      etat = 'cite';
    } else if (c === separateur) {
      contientChampCsv = true;
      ajouterChamp();
      champ = '';
      etat = 'debut';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && contenu[i + 1] === '\n') i += 1;
      finir();
      numero += 1;
    } else {
      if (etat === 'termine' && c !== ' ' && c !== '\t') throw new Error(`Ligne ${numero} : caractère après le guillemet fermant.`);
      if (etat === 'termine' && c === '\t' && champs.length === 1) throw new Error(`Ligne ${debut} : libellé contenant un caractère de contrôle interdit.`);
      if (etat !== 'termine') {
        champ += c;
        if (etat === 'debut' && c !== ' ' && c !== '\t') etat = 'simple';
      }
    }
  }
  if (etat === 'cite') throw new Error(`Ligne ${debut} : guillemet non fermé.`);
  if (champs.length || champ.trim() || contientChampCsv) finir();
  // Les exports Excel ajoutent parfois des colonnes vides après la nature.
  for (const ligne of lignes) {
    while (ligne.champs.length > 3 && ligne.champs.at(-1) === '') ligne.champs.pop();
  }
  const premiere = lignes[0]?.champs;
  if (premiere?.[0]?.toLowerCase() === 'code') {
    if (premiere.length !== 3 || !['libelle', 'libellé'].includes(premiere[1].toLowerCase()) || premiere[2].toLowerCase() !== 'nature') {
      throw new Error('En-tête CSV attendu : code, libelle, nature.');
    }
    lignes.shift();
  }
  if (!lignes.length) throw new Error('Le fichier CSV ne contient aucun compte.');
  const comptes = lignes.map(({ champs: valeurs, numero: ligne }) => {
    if (valeurs.length !== 3) throw new Error(`Ligne ${ligne} : 3 colonnes attendues (code, libelle, nature).`);
    const [code, libelle, nature] = valeurs;
    return { code, libelle, nature };
  });
  return { lignes: comptes, numeros: lignes.map(ligne => ligne.numero) };
}
