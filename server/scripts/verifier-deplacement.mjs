// Vérifie qu'un lot du découpage de server/index.ts ne fait que DÉPLACER du code.
//
//   node scripts/verifier-deplacement.mjs [base]     (base : origin/main par défaut)
//
// Compare le code serveur de la base (index.ts et src/**/*.ts) à celui de l'arbre de travail,
// ligne à ligne, après normalisation : espaces de début et de fin ignorés (réindentation),
// mot-clé `export` de tête ignoré, lignes vides et instructions `import` écartées.
//   1. Lignes disparues : présentes dans la base, absentes de l'arbre. Un déplacement n'en
//      laisse aucune ; le script échoue sinon.
//   2. Lignes ajoutées : présentes dans l'arbre, absentes de la base. Ce sont les seules lignes
//      écrites par le lot (fonction d'enregistrement, appel, en-têtes, exports) : elles sont
//      listées pour la revue.
//   3. Blocs : pour chaque fichier nouveau ou modifié sous src/, les suites de lignes reprises
//      à l'identique de la base, avec leurs numéros de ligne d'origine.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] || 'origin/main';
const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  return execFileSync('git', args, { cwd: racine, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function fichiersArbre() {
  const liste = ['index.ts'];
  const parcourir = (dossier) => {
    for (const nom of readdirSync(path.join(racine, dossier)).sort()) {
      const relatif = path.join(dossier, nom);
      if (statSync(path.join(racine, relatif)).isDirectory()) parcourir(relatif);
      else if (nom.endsWith('.ts')) liste.push(relatif);
    }
  };
  try { parcourir('src'); } catch { /* pas encore de src/ */ }
  return liste;
}

function fichiersBase() {
  return git('ls-tree', '-r', '--name-only', base, '--', 'index.ts', 'src')
    .split('\n').filter((f) => f.endsWith('.ts')).map((f) => f.replace(/^server\//, ''));
}

// Lignes significatives d'un fichier : { texte normalisé, numéro de ligne d'origine }.
function normaliser(contenu) {
  const sortie = [];
  let dansImport = false;
  contenu.split('\n').forEach((brute, i) => {
    const ligne = brute.trim();
    if (dansImport) {
      if (/['"];?$/.test(ligne)) dansImport = false;
      return;
    }
    if (/^import\s/.test(ligne)) {
      if (!/['"];?$/.test(ligne)) dansImport = true;
      return;
    }
    if (!ligne) return;
    sortie.push({ texte: ligne.replace(/^export\s+(?=(async\s+)?(function|const|let|interface|type|class)\b)/, ''), ligne: i + 1 });
  });
  return sortie;
}

const avant = new Map(fichiersBase().map((f) => [f, normaliser(git('show', `${base}:server/${f}`))]));
const apres = new Map(fichiersArbre().map((f) => [f, normaliser(readFileSync(path.join(racine, f), 'utf8'))]));

function compter(fichiers) {
  const compte = new Map();
  for (const lignes of fichiers.values()) for (const { texte } of lignes) compte.set(texte, (compte.get(texte) ?? 0) + 1);
  return compte;
}
const compteAvant = compter(avant);
const compteApres = compter(apres);

const disparues = [];
for (const [texte, n] of compteAvant) if (n > (compteApres.get(texte) ?? 0)) disparues.push([texte, n - (compteApres.get(texte) ?? 0)]);
// L'excédent d'une ligne est attribué à ses premières occurrences : la liste est exacte en
// nombre, mais l'emplacement indiqué d'une ligne très courante (`}`) n'est qu'indicatif.
const excedent = new Map();
for (const [texte, n] of compteApres) if (n > (compteAvant.get(texte) ?? 0)) excedent.set(texte, n - (compteAvant.get(texte) ?? 0));
const ajoutees = [];
for (const [fichier, lignes] of apres) {
  for (const { texte, ligne } of lignes) {
    if ((excedent.get(texte) ?? 0) > 0) {
      ajoutees.push(`${fichier}:${ligne}  ${texte}`);
      excedent.set(texte, excedent.get(texte) - 1);
    }
  }
}

// Blocs repris à l'identique : plus longues suites communes avec la base (tous fichiers).
const sequenceBase = [];
for (const [fichier, lignes] of avant) for (const l of lignes) sequenceBase.push({ ...l, fichier });
const positions = new Map();
sequenceBase.forEach(({ texte }, i) => {
  if (!positions.has(texte)) positions.set(texte, []);
  positions.get(texte).push(i);
});

console.log(`Base : ${base}`);
for (const [fichier, lignes] of apres) {
  if (fichier === 'index.ts') continue;
  const ancien = avant.get(fichier);
  if (ancien && ancien.length === lignes.length && ancien.every((l, i) => l.texte === lignes[i].texte)) continue;
  console.log(`\n${fichier} (${lignes.length} lignes significatives)`);
  let i = 0;
  while (i < lignes.length) {
    let meilleur = { debut: -1, longueur: 0 };
    for (const p of positions.get(lignes[i].texte) ?? []) {
      let k = 0;
      while (i + k < lignes.length && p + k < sequenceBase.length && sequenceBase[p + k].texte === lignes[i + k].texte
        && sequenceBase[p + k].fichier === sequenceBase[p].fichier) k += 1;
      if (k > meilleur.longueur) meilleur = { debut: p, longueur: k };
    }
    if (meilleur.longueur >= 3) {
      const d = sequenceBase[meilleur.debut];
      const f = sequenceBase[meilleur.debut + meilleur.longueur - 1];
      console.log(`  bloc de ${meilleur.longueur} lignes : ${d.fichier}:${d.ligne}-${f.ligne} -> lignes ${lignes[i].ligne}-${lignes[i + meilleur.longueur - 1].ligne}`);
      i += meilleur.longueur;
    } else {
      console.log(`  ligne ${lignes[i].ligne} hors bloc : ${lignes[i].texte}`);
      i += 1;
    }
  }
}

console.log(`\nLignes ajoutées (${ajoutees.length}) :`);
for (const l of ajoutees) console.log(`  ${l}`);
console.log(`\nLignes disparues (${disparues.reduce((s, [, n]) => s + n, 0)}) :`);
for (const [texte, n] of disparues) console.log(`  ${n > 1 ? `${n} × ` : ''}${texte}`);
if (disparues.length) {
  console.error('\nÉchec : des lignes de la base ont disparu ; ce lot ne se limite pas à un déplacement.');
  process.exit(1);
}
console.log('\nAucune ligne de la base n\'a disparu.');
