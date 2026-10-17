// Vérifie qu'un lot du découpage de server/index.ts ne fait que DÉPLACER du code.
//
//   node scripts/verifier-deplacement.mjs [base]     (base : origin/main par défaut)
//
// Compare tous les fichiers TypeScript du serveur (ceux que compile tsconfig.json) entre la
// base et l'arbre de travail, instruction par instruction, avec l'analyseur du compilateur
// TypeScript. Une instruction est une instruction de premier niveau d'un fichier, ou d'une
// fonction d'enregistrement `enregistrerRoutes…(app)`.
//
// 1. Chaque instruction de la base se retrouve une fois et une seule dans l'arbre, à
//    l'identique, avec ses commentaires. Deux transformations seulement sont admises :
//    - le mot-clé `export` ajouté devant une déclaration ;
//    - un décalage d'indentation uniforme quand l'instruction entre dans une fonction
//      d'enregistrement. Les lignes qui continuent un gabarit multiligne (`…`) ne bougent pas,
//      puisque leur indentation fait partie de la chaîne.
//    Des commentaires peuvent être ajoutés devant une instruction ; ils sont listés.
// 2. L'ordre est conservé :
//    - dans chaque fichier et chaque fonction d'enregistrement, les instructions venues d'un
//      même fichier de la base s'y suivent dans le même ordre ;
//    - index.ts, chaque appel d'enregistrement remplacé par le contenu de sa fonction, suit
//      l'ordre de la base ;
//    - dans un fichier qui existait, les imports conservés gardent leur ordre et les nouveaux
//      viennent après eux : les bibliothèques se chargent avant le code déplacé, comme avant.
// 3. Les seules instructions nouvelles admises sont :
//    - les imports et ré-exports, sans renommage (`as`) ;
//    - les fonctions d'enregistrement, chacune appelée une fois, avec `app`, au premier niveau
//      d'index.ts ;
//    - des noms ajoutés à la liste d'exports d'un fichier (ré-exports lus par les tests). Un
//      nom n'en est jamais retiré.
//
// Le script échoue sur tout autre écart. Il liste pour la revue les blocs déplacés avec leurs
// lignes d'origine, les instructions et commentaires nouveaux, et les instructions qui
// s'exécutent désormais au chargement d'un autre module qu'index.ts, donc avant son corps.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const base = process.argv[2] || 'origin/main';
const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: racine, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const ENREGISTREMENT = /^enregistrerRoutes/;

// --- Fichiers : include "**/*.ts" de tsconfig.json, hors node_modules ---
function fichiersArbre(dossier = '') {
  const liste = [];
  for (const nom of readdirSync(path.join(racine, dossier)).sort()) {
    if (nom.startsWith('.') || nom === 'node_modules') continue;
    const relatif = dossier ? `${dossier}/${nom}` : nom;
    if (statSync(path.join(racine, relatif)).isDirectory()) liste.push(...fichiersArbre(relatif));
    else if (nom.endsWith('.ts')) liste.push(relatif);
  }
  return liste;
}
function fichiersBase() {
  return git('ls-tree', '-r', '--name-only', '--full-name', base, '--', '.')
    .split('\n').filter((f) => f.startsWith('server/') && f.endsWith('.ts'))
    .map((f) => f.slice('server/'.length))
    .filter((f) => !f.split('/').some((partie) => partie === 'node_modules' || partie.startsWith('.')));
}

// --- Analyse d'un fichier ---
const lignesDeCommentaires = (texte, plages) => (plages ?? [])
  .flatMap(({ pos, end }) => texte.slice(pos, end).split('\n').map((ligne) => ligne.trim()).filter(Boolean));
const aExport = (noeud) => (ts.canHaveModifiers(noeud) ? ts.getModifiers(noeud) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const DECLARATIONS = new Set([ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.EnumDeclaration]);

// Noms qu'un fichier exporte : listes `export { … }`, ré-exports et déclarations exportées.
function nomsExportes(source) {
  const noms = new Set();
  for (const noeud of source.statements) {
    if (ts.isExportDeclaration(noeud)) {
      if (noeud.exportClause && ts.isNamedExports(noeud.exportClause)) noeud.exportClause.elements.forEach((e) => noms.add(e.name.text));
      else noms.add(`* from ${noeud.moduleSpecifier?.getText(source)}`);
    } else if (aExport(noeud)) {
      if (ts.isVariableStatement(noeud)) noeud.declarationList.declarations.forEach((d) => noms.add(d.name.getText(source)));
      else if (noeud.name) noms.add(noeud.name.getText(source));
    }
  }
  return noms;
}

function analyser(fichier, texte) {
  const source = ts.createSourceFile(fichier, texte, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const gabarits = [];
  (function parcourir(noeud) {
    if (ts.isNoSubstitutionTemplateLiteral(noeud) || ts.isTemplateHead(noeud) || ts.isTemplateMiddle(noeud) || ts.isTemplateTail(noeud)) {
      gabarits.push([noeud.getStart(source), noeud.getEnd()]);
    }
    ts.forEachChild(noeud, parcourir);
  }(source));
  const ligne = (position) => source.getLineAndCharacterOfPosition(position).line + 1;
  const instruction = (noeud, conteneur) => {
    const debut = noeud.getStart(source);
    const exporte = aExport(noeud) && DECLARATIONS.has(noeud.kind);
    let code = texte.slice(debut, noeud.getEnd());
    if (exporte && !code.startsWith('export ')) throw new Error(`${fichier}:${ligne(debut)} : export inattendu`);
    if (exporte) code = code.slice('export '.length);
    return {
      fichier, conteneur, noeud, source, gabarits, exporte, code,
      debutCode: debut + (exporte ? 'export '.length : 0),
      colonne: source.getLineAndCharacterOfPosition(debut).character,
      ligneDebut: ligne(debut),
      ligneFin: ligne(noeud.getEnd()),
      cle: code.split('\n').map((l) => l.trim()).join('\n'),
      commentaires: lignesDeCommentaires(texte, ts.getLeadingCommentRanges(texte, noeud.getFullStart())),
      suivants: lignesDeCommentaires(texte, ts.getTrailingCommentRanges(texte, noeud.getEnd())),
    };
  };
  return { fichier, source, texte, ligne, instruction };
}

// Le code de l'arbre est-il celui de la base, au décalage d'indentation près ? Renvoie le
// numéro (dans l'instruction) de la première ligne qui diffère, ou 0.
function ecartStrict(b, t) {
  const lb = b.code.split('\n');
  const lt = t.code.split('\n');
  if (lb.length !== lt.length) return Math.min(lb.length, lt.length);
  if (lb[0] !== lt[0]) return 1;
  const decalage = t.colonne - b.colonne;
  let position = b.debutCode + lb[0].length + 1;
  for (let i = 1; i < lb.length; i += 1) {
    const dansGabarit = b.gabarits.some(([debut, fin]) => debut < position && position < fin);
    let attendue;
    if (dansGabarit) attendue = lb[i];
    else if (!lb[i].trim()) attendue = lt[i].trim() ? null : lt[i];
    else if (decalage >= 0) attendue = ' '.repeat(decalage) + lb[i];
    else attendue = lb[i].startsWith(' '.repeat(-decalage)) ? lb[i].slice(-decalage) : null;
    if (lt[i] !== attendue) return i + 1;
    position += lb[i].length + 1;
  }
  return 0;
}

// Une instruction déplacée au premier niveau d'un autre module s'exécute au chargement de ce
// module, avant le corps d'index.ts. Sans effet : une déclaration de fonction ou de type, ou
// une constante initialisée par une fonction ou une valeur littérale.
function sansEffetAuChargement(noeud) {
  if (ts.isFunctionDeclaration(noeud) || ts.isInterfaceDeclaration(noeud) || ts.isTypeAliasDeclaration(noeud)) return true;
  if (!ts.isVariableStatement(noeud)) return false;
  const litteral = (e) => {
    if (!e) return false;
    if (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression?.(e)) return litteral(e.expression);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isStringLiteral(e) || ts.isNumericLiteral(e)
      || ts.isNoSubstitutionTemplateLiteral(e) || ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand)) return true;
    if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(e.kind)) return true;
    if (ts.isArrayLiteralExpression(e)) return e.elements.every(litteral);
    if (ts.isObjectLiteralExpression(e)) return e.properties.every((p) => ts.isPropertyAssignment(p) && litteral(p.initializer));
    return false;
  };
  return noeud.declarationList.declarations.every((d) => litteral(d.initializer));
}

const erreurs = [];
const erreur = (message) => erreurs.push(message);
const premiereLigne = (texte) => (texte.split('\n')[0].length > 110 ? `${texte.split('\n')[0].slice(0, 110)}…` : texte.split('\n')[0]);

// --- Base ---
const instructionsBase = [];
const importsBase = new Map();
const exportsBase = new Map();
const commentairesFinaux = (analyse) => lignesDeCommentaires(analyse.texte, ts.getLeadingCommentRanges(analyse.texte, analyse.source.endOfFileToken.getFullStart()));
const finsBase = new Map();
for (const fichier of fichiersBase()) {
  const analyse = analyser(fichier, git('show', `${base}:server/${fichier}`));
  importsBase.set(fichier, []);
  exportsBase.set(fichier, nomsExportes(analyse.source));
  finsBase.set(fichier, commentairesFinaux(analyse));
  let index = 0;
  analyse.source.statements.forEach((noeud) => {
    if (ts.isImportDeclaration(noeud) || ts.isImportEqualsDeclaration(noeud)) {
      importsBase.get(fichier).push({ texte: noeud.getText(analyse.source), commentaires: lignesDeCommentaires(analyse.texte, ts.getLeadingCommentRanges(analyse.texte, noeud.getFullStart())) });
    } else if (!ts.isExportDeclaration(noeud) || noeud.moduleSpecifier) {
      // Une liste `export { … }` est comparée par noms (nomsExportes), pas comme instruction.
      instructionsBase.push({ ...analyse.instruction(noeud, null), index: index++, utilisee: null });
    }
  });
}
const parCle = new Map();
for (const b of instructionsBase) {
  if (!parCle.has(b.cle)) parCle.set(b.cle, []);
  parCle.get(b.cle).push(b);
}
const moduleImporte = (texte) => /from\s+(['"])(.+?)\1|^import\s+(['"])(.+?)\3/.exec(texte)?.slice(1).filter(Boolean)[1];

// --- Arbre ---
const nouvelles = [];
const commentairesAjoutes = [];
const auChargement = [];
const conteneurs = [];
const enregistrements = new Map();
const appels = [];

function verifierImport(analyse, noeud) {
  const { source } = analyse;
  const texte = noeud.getText(source);
  const liaisons = ts.isImportDeclaration(noeud) ? noeud.importClause?.namedBindings : ts.isExportDeclaration(noeud) ? noeud.exportClause : undefined;
  const renomme = liaisons && (ts.isNamedImports(liaisons) || ts.isNamedExports(liaisons)) && liaisons.elements.some((e) => e.propertyName);
  const espaceDeNoms = liaisons && ts.isNamespaceImport?.(liaisons);
  const dejaLa = [...importsBase.values()].some((liste) => liste.some((i) => i.texte === texte));
  if ((renomme || espaceDeNoms) && !dejaLa) erreur(`${analyse.fichier}:${analyse.ligne(noeud.getStart(source))} : import renommé, interdit pendant le découpage : ${premiereLigne(texte)}`);
}

function traiterConteneur(analyse, noeuds, conteneur) {
  const { fichier, source } = analyse;
  const sequence = [];
  conteneurs.push({ fichier, conteneur, sequence });
  const listesBase = importsBase.get(fichier);
  let dernierConserve = -1;
  let nouvelImportVu = null;
  // Commentaires : ceux de la base doivent terminer ceux de l'arbre ; ce qui les précède est ajouté.
  const comparerCommentaires = (ici, avant, apres, origine) => {
    const n = apres.length - avant.length;
    if (n < 0 || apres.slice(n).join('\n') !== avant.join('\n')) erreur(`${ici} : commentaires de ${origine} modifiés ou retirés`);
    else if (n > 0) commentairesAjoutes.push(`${ici}  ${apres.slice(0, n).join(' / ')}`);
  };
  for (const noeud of noeuds) {
    const l = analyse.ligne(noeud.getStart(source));
    const ici = `${fichier}:${l}`;
    const commentaires = lignesDeCommentaires(analyse.texte, ts.getLeadingCommentRanges(analyse.texte, noeud.getFullStart()));
    if (ts.isImportDeclaration(noeud) || ts.isImportEqualsDeclaration(noeud) || ts.isExportDeclaration(noeud) && noeud.moduleSpecifier) {
      if (conteneur) { erreur(`${ici} : import dans une fonction d'enregistrement`); continue; }
      verifierImport(analyse, noeud);
      const texte = noeud.getText(source);
      // Import conservé : même module qu'un import de ce fichier dans la base, liste de noms
      // éventuellement réduite. Les conservés gardent leur ordre ; les nouveaux les suivent.
      const position = listesBase ? listesBase.findIndex((i) => i.texte === texte) : -1;
      const conserve = position >= 0 ? position : (listesBase ?? []).findIndex((i) => moduleImporte(i.texte) === moduleImporte(texte));
      if (conserve >= 0) {
        if (nouvelImportVu) erreur(`${ici} : import conservé placé après un import nouveau (${nouvelImportVu}) ; l'ordre de chargement change`);
        if (conserve < dernierConserve) erreur(`${ici} : imports conservés réordonnés ; l'ordre de chargement change`);
        dernierConserve = conserve;
        if (position < 0) nouvelles.push(`${ici}  import modifié : ${premiereLigne(texte)}`);
        comparerCommentaires(ici, listesBase[conserve].commentaires, commentaires, 'l\'import');
      } else {
        if (listesBase) nouvelImportVu ??= ici;
        nouvelles.push(`${ici}  ${premiereLigne(texte)}`);
        if (commentaires.length) commentairesAjoutes.push(`${ici}  ${commentaires.join(' / ')}`);
      }
      continue;
    }
    if (ts.isExportDeclaration(noeud)) {
      if (conteneur) { erreur(`${ici} : export dans une fonction d'enregistrement`); continue; }
      verifierImport(analyse, noeud);
      const noms = noeud.exportClause && ts.isNamedExports(noeud.exportClause) ? noeud.exportClause.elements.map((e) => e.name.text) : [];
      const avant = exportsBase.get(fichier) ?? new Set();
      const ajoutes = noms.filter((n) => !avant.has(n));
      if (ajoutes.length) nouvelles.push(`${ici}  exports ajoutés : ${ajoutes.join(', ')}`);
      continue;
    }
    if (!conteneur && ts.isFunctionDeclaration(noeud) && noeud.name && ENREGISTREMENT.test(noeud.name.text)) {
      const nom = noeud.name.text;
      if (enregistrements.has(nom)) erreur(`${ici} : fonction d'enregistrement ${nom} déclarée deux fois`);
      if (noeud.parameters.length !== 1 || noeud.parameters[0].name.getText(source) !== 'app') erreur(`${ici} : ${nom} doit prendre le seul paramètre app`);
      nouvelles.push(`${ici}  fonction d'enregistrement ${nom}(app)`);
      if (commentaires.length) commentairesAjoutes.push(`${ici}  ${commentaires.join(' / ')}`);
      const fin = analyse.ligne(noeud.body.getEnd() - 1);
      const finales = lignesDeCommentaires(analyse.texte, ts.getLeadingCommentRanges(analyse.texte, noeud.body.statements.at(-1)?.getEnd() ?? noeud.body.getStart(source) + 1));
      if (finales.length) commentairesAjoutes.push(`${fichier}:${fin}  ${finales.join(' / ')}`);
      enregistrements.set(nom, { fichier, ligne: l, sequence: traiterConteneur(analyse, noeud.body.statements, nom) });
      continue;
    }
    if (ts.isExpressionStatement(noeud) && ts.isCallExpression(noeud.expression) && ts.isIdentifier(noeud.expression.expression)
      && ENREGISTREMENT.test(noeud.expression.expression.text)) {
      const nom = noeud.expression.expression.text;
      const args = noeud.expression.arguments;
      if (fichier !== 'index.ts' || conteneur) erreur(`${ici} : ${nom} ne peut être appelée qu'au premier niveau d'index.ts`);
      else if (args.length !== 1 || !ts.isIdentifier(args[0]) || args[0].text !== 'app') erreur(`${ici} : ${nom} doit être appelée avec app`);
      appels.push({ nom, ici });
      sequence.push({ appel: nom });
      nouvelles.push(`${ici}  appel ${nom}(app)`);
      if (commentaires.length) commentairesAjoutes.push(`${ici}  ${commentaires.join(' / ')}`);
      continue;
    }
    const t = analyse.instruction(noeud, conteneur);
    const candidats = (parCle.get(t.cle) ?? []).filter((b) => !b.utilisee);
    const precedente = sequence.filter((s) => s.base).at(-1)?.base;
    const b = candidats.find((c) => precedente && c.fichier === precedente.fichier && c.index > precedente.index) ?? candidats[0];
    if (!b) {
      erreur(`${ici} : instruction nouvelle ou modifiée : ${premiereLigne(t.code)}`);
      continue;
    }
    b.utilisee = t;
    sequence.push({ base: b, arbre: t });
    const ecart = ecartStrict(b, t);
    if (ecart) erreur(`${ici} : ${b.fichier}:${b.ligneDebut} déplacée avec un écart de blancs ou d'indentation à sa ligne ${ecart} : ${premiereLigne(t.code.split('\n')[ecart - 1] ?? '')}`);
    if (b.exporte && !t.exporte) erreur(`${ici} : export retiré de ${b.fichier}:${b.ligneDebut}`);
    comparerCommentaires(ici, b.commentaires, t.commentaires, `${b.fichier}:${b.ligneDebut}`);
    if (t.suivants.join('\n') !== b.suivants.join('\n')) erreur(`${ici} : commentaire de fin de ligne de ${b.fichier}:${b.ligneFin} modifié`);
    if (!conteneur && fichier !== b.fichier && b.fichier === 'index.ts' && !sansEffetAuChargement(noeud)) {
      auChargement.push(`${ici}  ${premiereLigne(t.code)}  (index.ts:${b.ligneDebut})`);
    }
  }
  return sequence;
}

const fichiers = fichiersArbre();
for (const fichier of fichiers) {
  const analyse = analyser(fichier, readFileSync(path.join(racine, fichier), 'utf8'));
  traiterConteneur(analyse, analyse.source.statements, null);
  const exportes = nomsExportes(analyse.source);
  const retires = [...(exportsBase.get(fichier) ?? [])].filter((n) => !exportes.has(n));
  if (retires.length) erreur(`${fichier} : exports retirés : ${retires.join(', ')}`);
  const finales = commentairesFinaux(analyse);
  const avant = finsBase.get(fichier) ?? [];
  const n = finales.length - avant.length;
  if (n < 0 || finales.slice(n).join('\n') !== avant.join('\n')) erreur(`${fichier} : commentaires de fin de fichier modifiés ou retirés`);
  else if (n > 0) commentairesAjoutes.push(`${fichier}:fin  ${finales.slice(0, n).join(' / ')}`);
}

// --- Fonctions d'enregistrement : une par appel ---
for (const [nom, { fichier, ligne }] of enregistrements) {
  const n = appels.filter((a) => a.nom === nom).length;
  if (n !== 1) erreur(`${fichier}:${ligne} : ${nom} est appelée ${n} fois au premier niveau d'index.ts (une fois attendue)`);
}
for (const { nom, ici } of appels) if (!enregistrements.has(nom)) erreur(`${ici} : ${nom} n'est déclarée dans aucun fichier`);

// --- Instructions de la base disparues ---
for (const b of instructionsBase) if (!b.utilisee) erreur(`${b.fichier}:${b.ligneDebut} : instruction disparue : ${premiereLigne(b.code)}`);

// --- Ordre ---
function verifierOrdre(libelle, sequence) {
  const derniere = new Map();
  for (const { base: b, arbre: t } of sequence) {
    const avant = derniere.get(b.fichier);
    if (avant && b.index < avant.base.index) {
      erreur(`${libelle} : ordre changé : l'instruction de ${b.fichier}:${b.ligneDebut} (ici ${t.fichier}:${t.ligneDebut}) vient après celle de ${b.fichier}:${avant.base.ligneDebut} (ici ${avant.arbre.fichier}:${avant.arbre.ligneDebut})`);
    }
    derniere.set(b.fichier, { base: b, arbre: t });
  }
}
for (const { fichier, conteneur, sequence } of conteneurs) {
  if (fichier === 'index.ts' && !conteneur) {
    verifierOrdre('index.ts, appels d\'enregistrement développés', sequence.flatMap((s) => (s.appel ? (enregistrements.get(s.appel)?.sequence ?? []) : [s])).filter((s) => s.base));
  } else verifierOrdre(conteneur ? `${fichier} (${conteneur})` : fichier, sequence.filter((s) => s.base));
}

// --- Rapport ---
console.log(`Base : ${base}`);
for (const { fichier, conteneur, sequence } of conteneurs) {
  const blocs = [];
  for (const { base: b, arbre: t } of sequence.filter((s) => s.base)) {
    const dernier = blocs.at(-1);
    if (dernier && dernier.fichier === b.fichier && dernier.fin.index + 1 === b.index) {
      Object.assign(dernier, { fin: b, finArbre: t, n: dernier.n + 1 });
    } else blocs.push({ fichier: b.fichier, debut: b, fin: b, debutArbre: t, finArbre: t, n: 1 });
  }
  const inchange = blocs.length === 1 && blocs[0].fichier === fichier && !conteneur && blocs[0].n === instructionsBase.filter((b) => b.fichier === fichier).length;
  if (inchange || (!blocs.length && !conteneur)) continue;
  console.log(`\n${fichier}${conteneur ? `, fonction ${conteneur}` : ''}`);
  for (const bloc of blocs) {
    const origine = bloc.fichier === fichier && !conteneur ? 'conservé' : `${bloc.fichier}:${bloc.debut.ligneDebut}-${bloc.fin.ligneFin}`;
    console.log(`  lignes ${bloc.debutArbre.ligneDebut}-${bloc.finArbre.ligneFin} : ${origine} (${bloc.n} instruction${bloc.n > 1 ? 's' : ''})`);
  }
}
const section = (titre, liste) => {
  console.log(`\n${titre} (${liste.length}) :`);
  for (const ligne of liste) console.log(`  ${ligne}`);
};
section('Instructions nouvelles admises', nouvelles);
section('Commentaires ajoutés', commentairesAjoutes);
section('Instructions exécutées au chargement d\'un autre module qu\'index.ts, à relire', auChargement);
if (erreurs.length) {
  section('Écarts', erreurs);
  console.error('\nÉchec : ce lot ne se limite pas à un déplacement.');
  process.exit(1);
}
console.log(`\nDéplacement vérifié : ${instructionsBase.length} instructions de la base retrouvées, à l'identique et dans l'ordre.`);
