// Vérifie qu'un lot du découpage de server/index.ts ne fait que DÉPLACER du code.
//
//   node scripts/verifier-deplacement.mjs [base] [--outils-admis]     (base : origin/main par défaut)
//
// Compare tous les fichiers TypeScript du serveur (ceux que compile tsconfig.json) entre la
// base et l'arbre de travail, instruction par instruction, avec l'analyseur du compilateur
// TypeScript. Une instruction est une instruction de premier niveau d'un fichier, ou d'une
// fonction d'enregistrement `enregistrerRoutes…(app)`. Base et arbre sont lus de la même
// façon : une base qui contient déjà des fonctions d'enregistrement se compare comme une autre.
//
// 1. Chaque instruction de la base se retrouve une fois et une seule dans l'arbre, à
//    l'identique, avec ses commentaires. Deux transformations seulement sont admises :
//    - le mot-clé `export` ajouté devant une déclaration ;
//    - un décalage d'indentation uniforme quand l'instruction entre dans une fonction
//      d'enregistrement ou en sort. Les lignes qui continuent un gabarit multiligne (`…`) ne
//      bougent pas, puisque leur indentation fait partie de la chaîne.
//    Des commentaires peuvent être ajoutés devant une instruction ; ils sont listés.
// 2. L'ordre est conservé :
//    - index.ts, chaque appel d'enregistrement remplacé par le contenu de sa fonction, suit
//      l'ordre de la base lue de la même façon ;
//    - dans chaque autre fichier, les instructions venues d'une même suite de la base s'y
//      suivent dans le même ordre ;
//    - dans un fichier qui existait, les imports conservés gardent leur ordre et les nouveaux
//      viennent après eux : les bibliothèques se chargent avant le code déplacé, comme avant.
// 3. Les seules instructions nouvelles admises sont :
//    - les imports et ré-exports ES, sans renommage (`as`, import par défaut sous un autre
//      nom que dans la base), d'un module local ou d'une bibliothèque déjà importée par la
//      base, sous le même spécificateur ; ni `import x = …`, ni `export import`, ni
//      `export * from` ;
//    - les fonctions d'enregistrement, ni asynchrones ni génératrices, au seul paramètre `app`
//      (ni reste, ni valeur par défaut), chacune appelée une fois, avec `app`, au premier
//      niveau d'index.ts ;
//    - des noms ajoutés aux exports d'un fichier. Un nom n'en est jamais retiré.
// 4. Chargement des modules, d'après les `require` de premier niveau du code que produit le
//    compilateur avec tsconfig.json (imports de types et imports dynamiques écartés), résolus
//    comme Node et TypeScript (`x.ts`, `x.js` lu comme `x.ts`, `x/index.ts`) ; un import
//    relatif non résolu fait échouer le script :
//    - chaque fichier qui reçoit du code de la base est chargé depuis index.ts ;
//    - aucun cycle d'imports entre modules locaux : en CommonJS, un module d'un cycle peut
//      s'évaluer avant que l'autre ait défini ce qu'il lui emprunte (constantes undefined) ;
//      index.ts n'est importé par aucun module.
//    Une instruction déplacée dans un autre fichier ne mentionne ni `require`, ni `module`, ni
//    `exports`, ni `__dirname`, ni `__filename`, ni, hors d'une fonction, `this` ou
//    `arguments`, dont le sens dépend du fichier.
// 5. Le code compile sans erreur de type, et aucune directive qui suspend ce contrôle n'est
//    ajoutée (`@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`, `/// <reference …>`) : c'est le
//    contrôle de types qui garantit qu'un nom d'une instruction déplacée désigne la même
//    déclaration qu'avant.
// 6. package.json, package-lock.json et tsconfig.json ne changent pas, ni les outils de preuve
//    (scripts/routes.mjs, scripts/routes-reference.txt, ce script), sauf avec --outils-admis
//    pour une PR qui les modifie : une PR du découpage ne doit pas pouvoir les adapter.
//
// Le script échoue sur tout autre écart. Il liste pour la revue les blocs déplacés avec leurs
// lignes d'origine, les instructions, imports et commentaires nouveaux, les imports retirés,
// les autres fichiers modifiés, et les instructions qui s'exécutent désormais au chargement
// d'un autre module que le leur, donc à un autre moment. Il ne prouve pas l'ordre dans lequel
// les modules s'évaluent : routes.mjs compare les lectures de l'environnement avant et après
// le chargement de .env.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const parametres = process.argv.slice(2);
const base = parametres.find((p) => !p.startsWith('--')) || 'origin/main';
const outilsAdmis = parametres.includes('--outils-admis');
const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: racine, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const ENREGISTREMENT = /^enregistrerRoutes/;
const LIES_AU_FICHIER = new Set(['require', 'module', 'exports', '__dirname', '__filename']);
const FIGES = ['package.json', 'package-lock.json', 'tsconfig.json'];
const OUTILS = ['scripts/routes.mjs', 'scripts/routes-reference.txt', 'scripts/verifier-deplacement.mjs'];

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
const aModificateur = (noeud, genre) => (ts.canHaveModifiers(noeud) ? ts.getModifiers(noeud) ?? [] : []).some((m) => m.kind === genre);
const DECLARATIONS = new Set([ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.EnumDeclaration]);
const estImport = (noeud) => ts.isImportDeclaration(noeud) || ts.isImportEqualsDeclaration(noeud) || (ts.isExportDeclaration(noeud) && !!noeud.moduleSpecifier);
const estEnregistrement = (noeud) => ts.isFunctionDeclaration(noeud) && !!noeud.name && ENREGISTREMENT.test(noeud.name.text);
const estAppel = (noeud) => ts.isExpressionStatement(noeud) && ts.isCallExpression(noeud.expression)
  && ts.isIdentifier(noeud.expression.expression) && ENREGISTREMENT.test(noeud.expression.expression.text);
const moduleImporte = (texte) => /from\s+(['"])(.+?)\1|^import\s+(['"])(.+?)\3/.exec(texte)?.slice(1).filter(Boolean)[1];

// Noms qu'un fichier exporte : listes `export { … }`, ré-exports et déclarations exportées.
function nomsExportes(source) {
  const noms = new Set();
  for (const noeud of source.statements) {
    if (ts.isExportDeclaration(noeud)) {
      if (noeud.exportClause && ts.isNamedExports(noeud.exportClause)) noeud.exportClause.elements.forEach((e) => noms.add(e.name.text));
      else noms.add(`* from ${noeud.moduleSpecifier?.getText(source)}`);
    } else if (aModificateur(noeud, ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(noeud)) noeud.declarationList.declarations.forEach((d) => noms.add(d.name.getText(source)));
      else if (noeud.name) noms.add(noeud.name.getText(source));
    }
  }
  return noms;
}

// Code compilé de l'arbre, produit en mémoire par le compilateur avec les options de
// tsconfig.json : il retire, comme `npm run build`, les imports qui ne servent qu'aux types.
// Les erreurs de type sont rendues avec le code.
function compiler() {
  const lu = ts.readConfigFile(path.join(racine, 'tsconfig.json'), ts.sys.readFile);
  const config = ts.parseJsonConfigFileContent(lu.config, ts.sys, racine);
  const programme = ts.createProgram(config.fileNames, { ...config.options, noEmit: false, declaration: false, sourceMap: false });
  const sorties = new Map();
  programme.emit(undefined, (nom, texte, _bom, _erreur, sources) => {
    if (nom.endsWith('.js') && sources?.length) sorties.set(path.relative(racine, sources[0].fileName).split(path.sep).join('/'), texte);
  });
  const diagnostics = ts.getPreEmitDiagnostics(programme).filter((d) => d.category === ts.DiagnosticCategory.Error).map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    if (!d.file) return message;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
    return `${path.relative(racine, d.file.fileName)}:${line + 1} : ${message}`;
  });
  // Directives telles que le compilateur les a reconnues dans chaque fichier, quelle que soit
  // leur casse : @ts-nocheck, @ts-ignore et @ts-expect-error, /// <reference …>.
  const directives = new Map();
  for (const source of programme.getSourceFiles()) {
    const relatif = path.relative(racine, source.fileName).split(path.sep).join('/');
    if (relatif.startsWith('..') || relatif.split('/').includes('node_modules')) continue;
    directives.set(relatif, (source.checkJsDirective && !source.checkJsDirective.enabled ? 1 : 0) + (source.commentDirectives?.length ?? 0)
      + source.referencedFiles.length + source.typeReferenceDirectives.length + source.libReferenceDirectives.length);
  }
  return { sorties, diagnostics, directives };
}

// Directives qui suspendent ou étendent le contrôle de types, recherchées aussi dans le texte,
// sans tenir compte de la casse, comme le compilateur.
const DIRECTIVES = /@ts-(?:nocheck|ignore|expect-error)\b|^\s*\/\/\/\s*<reference\b/gim;
const compterDirectives = (texte) => (texte.match(DIRECTIVES) ?? []).length;

// Modules locaux chargés au chargement d'un fichier : les `require` relatifs de premier niveau
// de son code compilé. Un `import()` dynamique, compilé en `require` à l'intérieur d'une
// fonction, n'en fait pas partie. Résolution de Node et TypeScript : `x.ts`, `x.js` lu comme
// `x.ts`, puis `x/index.ts`.
function modulesCharges(fichier, js, existants) {
  const compile = ts.createSourceFile(`${fichier}.js`, js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const charges = [];
  const nonResolus = [];
  (function parcourir(noeud) {
    if (ts.isFunctionLike(noeud)) return;
    if (ts.isCallExpression(noeud) && ts.isIdentifier(noeud.expression) && noeud.expression.text === 'require'
      && noeud.arguments.length === 1 && ts.isStringLiteral(noeud.arguments[0]) && noeud.arguments[0].text.startsWith('.')) {
      const specificateur = noeud.arguments[0].text;
      const chemin = path.posix.normalize(path.posix.join(path.posix.dirname(fichier), specificateur));
      const candidats = chemin.endsWith('.js') ? [chemin.replace(/\.js$/, '.ts')] : [`${chemin}.ts`, chemin, `${chemin}/index.ts`];
      const cible = candidats.find((c) => existants.has(c));
      if (cible) charges.push(cible);
      else nonResolus.push(specificateur);
    }
    ts.forEachChild(noeud, parcourir);
  }(compile));
  return { charges, nonResolus };
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
  const commentaires = (noeud) => lignesDeCommentaires(texte, ts.getLeadingCommentRanges(texte, noeud.getFullStart()));
  const instruction = (noeud, conteneur) => {
    const debut = noeud.getStart(source);
    const exporte = aModificateur(noeud, ts.SyntaxKind.ExportKeyword) && DECLARATIONS.has(noeud.kind);
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
      commentaires: commentaires(noeud),
      suivants: lignesDeCommentaires(texte, ts.getTrailingCommentRanges(texte, noeud.getEnd())),
    };
  };
  const analyse = {
    fichier, source, texte, ligne,
    imports: [], listesExports: [], elements: [], enregistrements: new Map(),
    finales: lignesDeCommentaires(texte, ts.getLeadingCommentRanges(texte, source.endOfFileToken.getFullStart())),
    exportes: nomsExportes(source),
    charges: [],
  };
  for (const noeud of source.statements) {
    const l = ligne(noeud.getStart(source));
    if (estImport(noeud)) analyse.imports.push({ noeud, ligne: l, texte: noeud.getText(source), commentaires: commentaires(noeud) });
    else if (ts.isExportDeclaration(noeud)) analyse.listesExports.push({ noeud, ligne: l, commentaires: commentaires(noeud) });
    else if (estEnregistrement(noeud)) {
      const nom = noeud.name.text;
      const derniere = noeud.body.statements.at(-1);
      analyse.enregistrements.set(nom, {
        nom, noeud, fichier, ligne: l, commentaires: commentaires(noeud),
        finales: lignesDeCommentaires(texte, ts.getLeadingCommentRanges(texte, derniere ? derniere.getEnd() : noeud.body.getStart(source) + 1)),
        corps: noeud.body.statements.map((n) => instruction(n, nom)),
      });
      analyse.elements.push({ type: 'enregistrement', nom, ligne: l });
    } else if (estAppel(noeud)) analyse.elements.push({ type: 'appel', nom: noeud.expression.expression.text, noeud, ligne: l, commentaires: commentaires(noeud) });
    else analyse.elements.push({ type: 'instruction', instruction: instruction(noeud, null) });
  }
  return analyse;
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

// Une instruction placée au premier niveau d'un autre module, ou sortie d'une fonction
// d'enregistrement, s'exécute au chargement de ce module. Sans effet : une déclaration de
// fonction ou de type, ou une constante initialisée par une fonction ou une valeur littérale.
function sansEffetAuChargement(noeud) {
  if (ts.isFunctionDeclaration(noeud) || ts.isInterfaceDeclaration(noeud) || ts.isTypeAliasDeclaration(noeud)) return true;
  if (!ts.isVariableStatement(noeud)) return false;
  const litteral = (e) => {
    if (!e) return false;
    if (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression?.(e)) return litteral(e.expression);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isStringLiteral(e) || ts.isNumericLiteral(e)
      || ts.isNoSubstitutionTemplateLiteral(e) || (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand))) return true;
    if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(e.kind)) return true;
    if (ts.isArrayLiteralExpression(e)) return e.elements.every(litteral);
    if (ts.isObjectLiteralExpression(e)) return e.properties.every((p) => ts.isPropertyAssignment(p) && litteral(p.initializer));
    return false;
  };
  return noeud.declarationList.declarations.every((d) => litteral(d.initializer));
}

// Identifiants dont le sens dépend du fichier (hors noms de propriétés), et `this` ou
// `arguments` hors d'une fonction qui les redéfinit (les fonctions fléchées ne le font pas).
function liesAuFichier(noeud) {
  const trouves = new Set();
  (function parcourir(n, dansFonction) {
    const nomDePropriete = (id) => (ts.isPropertyAccessExpression(id.parent) && id.parent.name === id) || (ts.isPropertyAssignment(id.parent) && id.parent.name === id);
    if (ts.isIdentifier(n) && LIES_AU_FICHIER.has(n.text) && !nomDePropriete(n)) trouves.add(n.text);
    if (!dansFonction && ts.isIdentifier(n) && n.text === 'arguments' && !nomDePropriete(n)) trouves.add('arguments');
    if (!dansFonction && n.kind === ts.SyntaxKind.ThisKeyword) trouves.add('this');
    const redefinit = ts.isFunctionLike(n) && !ts.isArrowFunction(n);
    ts.forEachChild(n, (enfant) => parcourir(enfant, dansFonction || redefinit));
  }(noeud, false));
  return [...trouves];
}

const erreurs = [];
const erreur = (message) => erreurs.push(message);
const premiereLigne = (texte) => (texte.split('\n')[0].length > 110 ? `${texte.split('\n')[0].slice(0, 110)}…` : texte.split('\n')[0]);
const nouvelles = [];
const commentairesAjoutes = [];
const auChargement = [];
const importsRetires = [];
// Commentaires : ceux de la base doivent terminer ceux de l'arbre ; ce qui les précède est ajouté.
function comparerCommentaires(ici, avant, apres, origine) {
  const n = apres.length - avant.length;
  if (n < 0 || apres.slice(n).join('\n') !== avant.join('\n')) erreur(`${ici} : commentaires de ${origine} modifiés ou retirés`);
  else if (n > 0) commentairesAjoutes.push(`${ici}  ${apres.slice(0, n).join(' / ')}`);
}

// --- Base : chaque instruction reçoit sa place dans une suite. Celle d'index.ts est
// développée : chaque appel d'enregistrement y est remplacé par le contenu de la fonction. ---
const analysesBase = new Map(fichiersBase().map((f) => [f, analyser(f, git('show', `${base}:server/${f}`))]));
const enregistrementsBase = new Map([...analysesBase.values()].flatMap((a) => [...a.enregistrements]));
const appelsBase = new Map();
const instructionsBase = [];
const placees = new Set();
const placer = (instruction, suite, index) => {
  instructionsBase.push(Object.assign(instruction, { suite, index, utilisee: null }));
  placees.add(instruction);
};
for (const a of analysesBase.values()) {
  let index = 0;
  for (const element of a.elements) {
    if (element.type === 'instruction') placer(element.instruction, a.fichier, index++);
    else if (element.type === 'appel' && a.fichier === 'index.ts') {
      appelsBase.set(element.nom, element.commentaires);
      for (const instruction of enregistrementsBase.get(element.nom)?.corps ?? []) if (!placees.has(instruction)) placer(instruction, a.fichier, index++);
    }
  }
}
for (const e of enregistrementsBase.values()) {
  e.corps.forEach((instruction, index) => { if (!placees.has(instruction)) placer(instruction, `${e.fichier}#${e.nom}`, index); });
}
// Bibliothèques importées par la base ; `node:crypto` et `crypto` désignent le même module.
// Nom local de chaque import par défaut de la base, par spécificateur.
const nomsParDefautBase = new Map();
for (const a of analysesBase.values()) {
  for (const i of a.imports) {
    const nom = ts.isImportDeclaration(i.noeud) ? i.noeud.importClause?.name?.text : undefined;
    const module = moduleImporte(i.texte)?.replace(/^node:/, '');
    if (!nom || !module) continue;
    if (!nomsParDefautBase.has(module)) nomsParDefautBase.set(module, new Set());
    nomsParDefautBase.get(module).add(nom);
  }
}
const bibliothequesBase = new Set([...analysesBase.values()].flatMap((a) => a.imports.map((i) => moduleImporte(i.texte)).filter((m) => m && !m.startsWith('.')).map((m) => m.replace(/^node:/, ''))));
const parCle = new Map();
for (const b of instructionsBase) {
  if (!parCle.has(b.cle)) parCle.set(b.cle, []);
  parCle.get(b.cle).push(b);
}

// --- Arbre ---
const analysesArbre = new Map(fichiersArbre().map((f) => [f, analyser(f, readFileSync(path.join(racine, f), 'utf8'))]));
{
  const { sorties: compiles, diagnostics, directives } = compiler();
  for (const diagnostic of diagnostics.slice(0, 20)) erreur(`erreur de type : ${diagnostic}`);
  if (diagnostics.length > 20) erreur(`… et ${diagnostics.length - 20} autres erreurs de type`);
  for (const a of analysesArbre.values()) {
    const avant = analysesBase.has(a.fichier) ? compterDirectives(analysesBase.get(a.fichier).texte) : 0;
    if (Math.max(compterDirectives(a.texte), directives.get(a.fichier) ?? 0) > avant) erreur(`${a.fichier} : directive @ts-nocheck, @ts-ignore, @ts-expect-error ou /// <reference> ajoutée ; elle suspendrait le contrôle de types qui garantit les déplacements`);
  }
  const existants = new Set(analysesArbre.keys());
  for (const a of analysesArbre.values()) {
    const js = compiles.get(a.fichier);
    if (js === undefined) { erreur(`${a.fichier} : absent de la compilation de tsconfig.json`); continue; }
    const { charges, nonResolus } = modulesCharges(a.fichier, js, existants);
    a.charges = charges;
    for (const specificateur of nonResolus) erreur(`${a.fichier} : import relatif ${specificateur} non résolu vers un fichier .ts du serveur`);
  }
}
const enregistrementsArbre = new Map();
for (const a of analysesArbre.values()) {
  for (const [nom, e] of a.enregistrements) {
    if (enregistrementsArbre.has(nom)) erreur(`${a.fichier}:${e.ligne} : fonction d'enregistrement ${nom} déclarée deux fois`);
    enregistrementsArbre.set(nom, e);
  }
}
const recoivent = new Set();

// Associe une instruction de l'arbre à une instruction de la base et contrôle l'association.
function apparier(t, a, etat) {
  const ici = `${a.fichier}:${t.ligneDebut}`;
  const candidats = (parCle.get(t.cle) ?? []).filter((b) => !b.utilisee);
  const b = candidats.find((c) => etat.precedente && c.suite === etat.precedente.suite && c.index > etat.precedente.index) ?? candidats[0];
  if (!b) {
    erreur(`${ici} : instruction nouvelle ou modifiée : ${premiereLigne(t.code)}`);
    return null;
  }
  b.utilisee = t;
  etat.precedente = b;
  const ecart = ecartStrict(b, t);
  if (ecart) erreur(`${ici} : ${b.fichier}:${b.ligneDebut} déplacée avec un écart de blancs ou d'indentation à sa ligne ${ecart} : ${premiereLigne(t.code.split('\n')[ecart - 1] ?? '')}`);
  if (b.exporte && !t.exporte) erreur(`${ici} : export retiré de ${b.fichier}:${b.ligneDebut}`);
  comparerCommentaires(ici, b.commentaires, t.commentaires, `${b.fichier}:${b.ligneDebut}`);
  if (t.suivants.join('\n') !== b.suivants.join('\n')) erreur(`${ici} : commentaire de fin de ligne de ${b.fichier}:${b.ligneFin} modifié`);
  if (b.fichier !== a.fichier) {
    recoivent.add(a.fichier);
    const lies = liesAuFichier(t.noeud);
    if (lies.length) erreur(`${ici} : ${b.fichier}:${b.ligneDebut} change de fichier alors qu'elle emploie ${lies.join(', ')}, dont le sens dépend du fichier`);
  }
  if (!t.conteneur && (b.fichier !== a.fichier || b.conteneur) && !sansEffetAuChargement(t.noeud)) {
    auChargement.push(`${ici}  ${premiereLigne(t.code)}  (${b.fichier}:${b.ligneDebut}${b.conteneur ? `, dans ${b.conteneur}` : ''})`);
  }
  return { base: b, arbre: t };
}

function verifierImport(a, imp) {
  const ici = `${a.fichier}:${imp.ligne}`;
  const dejaLa = [...analysesBase.values()].some((ab) => ab.imports.some((i) => i.texte === imp.texte));
  if (dejaLa) return;
  // `import x = require('…')` et `import x = A.b` (ou `export import`) renomment sans `as`.
  if (ts.isImportEqualsDeclaration(imp.noeud)) {
    erreur(`${ici} : import … = … interdit pendant le découpage : ${premiereLigne(imp.texte)}`);
    return;
  }
  if (ts.isExportDeclaration(imp.noeud) && !imp.noeud.exportClause) {
    erreur(`${ici} : export * interdit pendant le découpage ; ré-exporter chaque nom : ${premiereLigne(imp.texte)}`);
    return;
  }
  const liaisons = ts.isImportDeclaration(imp.noeud) ? imp.noeud.importClause?.namedBindings : ts.isExportDeclaration(imp.noeud) ? imp.noeud.exportClause : undefined;
  const renomme = liaisons && (ts.isNamedImports(liaisons) || ts.isNamedExports(liaisons)) && liaisons.elements.some((e) => e.propertyName);
  const espaceDeNoms = liaisons && (ts.isNamespaceImport(liaisons) || ts.isNamespaceExport(liaisons));
  if (renomme || espaceDeNoms) erreur(`${ici} : import renommé, interdit pendant le découpage : ${premiereLigne(imp.texte)}`);
  // Import par défaut : même nom local que dans la base pour ce spécificateur.
  const parDefaut = ts.isImportDeclaration(imp.noeud) ? imp.noeud.importClause?.name?.text : undefined;
  const nomsBase = nomsParDefautBase.get(moduleImporte(imp.texte)?.replace(/^node:/, ''));
  if (parDefaut && nomsBase && !nomsBase.has(parDefaut)) erreur(`${ici} : import par défaut renommé (${[...nomsBase].join(', ')} dans la base) : ${premiereLigne(imp.texte)}`);
  const specificateur = moduleImporte(imp.texte);
  if (specificateur && !specificateur.startsWith('.') && !bibliothequesBase.has(specificateur.replace(/^node:/, ''))) {
    erreur(`${ici} : bibliothèque ${specificateur} absente des imports de la base ; une PR du découpage n'en ajoute pas`);
  }
}

const sequences = new Map();
for (const a of analysesArbre.values()) {
  const ab = analysesBase.get(a.fichier);
  // Imports : conservés dans leur ordre, nouveaux après eux.
  let dernierConserve = -1;
  let nouvelImportVu = null;
  const modulesConserves = new Set();
  for (const imp of a.imports) {
    const ici = `${a.fichier}:${imp.ligne}`;
    verifierImport(a, imp);
    const position = ab ? ab.imports.findIndex((i) => i.texte === imp.texte) : -1;
    const conserve = position >= 0 ? position : (ab?.imports ?? []).findIndex((i) => moduleImporte(i.texte) === moduleImporte(imp.texte));
    if (conserve >= 0) {
      modulesConserves.add(moduleImporte(ab.imports[conserve].texte));
      if (nouvelImportVu) erreur(`${ici} : import conservé placé après un import nouveau (${nouvelImportVu}) ; l'ordre de chargement change`);
      if (conserve < dernierConserve) erreur(`${ici} : imports conservés réordonnés ; l'ordre de chargement change`);
      dernierConserve = conserve;
      if (position < 0) nouvelles.push(`${ici}  import modifié : ${premiereLigne(imp.texte)}`);
      comparerCommentaires(ici, ab.imports[conserve].commentaires, imp.commentaires, 'l\'import');
    } else {
      if (ab) nouvelImportVu ??= ici;
      nouvelles.push(`${ici}  ${premiereLigne(imp.texte)}`);
      if (imp.commentaires.length) commentairesAjoutes.push(`${ici}  ${imp.commentaires.join(' / ')}`);
    }
  }
  for (const imp of ab?.imports ?? []) {
    if (modulesConserves.has(moduleImporte(imp.texte))) continue;
    const effetSeul = ts.isImportDeclaration(imp.noeud) && !imp.noeud.importClause;
    if (effetSeul) erreur(`${a.fichier} : import ${premiereLigne(imp.texte)} retiré ; le module chargé pour son effet ne l'est plus d'ici`);
    else importsRetires.push(`${a.fichier}  ${premiereLigne(imp.texte)}`);
  }
  if (a.fichier !== 'index.ts' && a.charges.includes('index.ts')) erreur(`${a.fichier} : importe index.ts, interdit (dépendance circulaire)`);

  // Exports : aucun nom retiré ; listes `export { … }` comparées par noms et commentaires.
  for (const [i, liste] of a.listesExports.entries()) {
    const ici = `${a.fichier}:${liste.ligne}`;
    verifierImport(a, { noeud: liste.noeud, ligne: liste.ligne, texte: liste.noeud.getText(a.source) });
    const noms = liste.noeud.exportClause && ts.isNamedExports(liste.noeud.exportClause) ? liste.noeud.exportClause.elements.map((e) => e.name.text) : [];
    const ajoutes = noms.filter((n) => !(ab?.exportes ?? new Set()).has(n));
    if (ajoutes.length) nouvelles.push(`${ici}  exports ajoutés : ${ajoutes.join(', ')}`);
    if (ab?.listesExports[i]) comparerCommentaires(ici, ab.listesExports[i].commentaires, liste.commentaires, 'la liste d\'exports');
    else if (liste.commentaires.length) commentairesAjoutes.push(`${ici}  ${liste.commentaires.join(' / ')}`);
  }
  const retires = [...(ab?.exportes ?? [])].filter((n) => !a.exportes.has(n));
  if (retires.length) erreur(`${a.fichier} : exports retirés : ${retires.join(', ')}`);

  // Instructions de premier niveau, fonctions d'enregistrement et leurs appels.
  const etat = { precedente: null };
  const sequence = [];
  sequences.set(a.fichier, sequence);
  for (const element of a.elements) {
    if (element.type === 'instruction') {
      const paire = apparier(element.instruction, a, etat);
      if (paire) sequence.push(paire);
    } else if (element.type === 'enregistrement') {
      const e = a.enregistrements.get(element.nom);
      const ici = `${a.fichier}:${e.ligne}`;
      const eb = enregistrementsBase.get(e.nom);
      const [parametre, ...autresParametres] = e.noeud.parameters;
      const parametreSimple = parametre && !autresParametres.length && ts.isIdentifier(parametre.name) && parametre.name.text === 'app'
        && !parametre.dotDotDotToken && !parametre.initializer && !parametre.questionToken;
      if (!parametreSimple) erreur(`${ici} : ${e.nom} doit prendre le seul paramètre app, sans reste ni valeur par défaut`);
      if (e.noeud.asteriskToken || aModificateur(e.noeud, ts.SyntaxKind.AsyncKeyword)) erreur(`${ici} : ${e.nom} ne peut être ni asynchrone ni génératrice : son corps doit s'exécuter à l'appel`);
      if (eb) {
        comparerCommentaires(ici, eb.commentaires, e.commentaires, `la fonction ${e.nom}`);
        comparerCommentaires(`${ici} (fin)`, eb.finales, e.finales, `la fin de ${e.nom}`);
      } else {
        nouvelles.push(`${ici}  fonction d'enregistrement ${e.nom}(app)`);
        if (e.commentaires.length) commentairesAjoutes.push(`${ici}  ${e.commentaires.join(' / ')}`);
        if (e.finales.length) commentairesAjoutes.push(`${ici} (fin)  ${e.finales.join(' / ')}`);
      }
      if (e.corps.length) recoivent.add(a.fichier);
      const etatCorps = { precedente: null };
      e.sequence = e.corps.map((t) => apparier(t, a, etatCorps)).filter(Boolean);
    } else {
      const ici = `${a.fichier}:${element.ligne}`;
      const args = element.noeud.expression.arguments;
      if (a.fichier !== 'index.ts') erreur(`${ici} : ${element.nom} ne peut être appelée qu'au premier niveau d'index.ts`);
      else if (args.length !== 1 || !ts.isIdentifier(args[0]) || args[0].text !== 'app') erreur(`${ici} : ${element.nom} doit être appelée avec app`);
      if (appelsBase.has(element.nom)) comparerCommentaires(ici, appelsBase.get(element.nom), element.commentaires, `l'appel de ${element.nom}`);
      else {
        nouvelles.push(`${ici}  appel ${element.nom}(app)`);
        if (element.commentaires.length) commentairesAjoutes.push(`${ici}  ${element.commentaires.join(' / ')}`);
      }
      sequence.push({ appel: element.nom, ici });
    }
  }
  comparerCommentaires(`${a.fichier} (fin)`, ab?.finales ?? [], a.finales, 'la fin du fichier');
}

// --- Fonctions d'enregistrement : une par appel ---
const appels = [...(sequences.get('index.ts') ?? [])].filter((s) => s.appel);
for (const [nom, e] of enregistrementsArbre) {
  const n = appels.filter((s) => s.appel === nom).length;
  if (n !== 1) erreur(`${e.fichier}:${e.ligne} : ${nom} est appelée ${n} fois au premier niveau d'index.ts (une fois attendue)`);
}
for (const s of appels) if (!enregistrementsArbre.has(s.appel)) erreur(`${s.ici} : ${s.appel} n'est déclarée dans aucun fichier`);

// --- Instructions de la base disparues ---
for (const b of instructionsBase) if (!b.utilisee) erreur(`${b.fichier}:${b.ligneDebut} : instruction disparue : ${premiereLigne(b.code)}`);

// --- Ordre ---
function verifierOrdre(libelle, paires) {
  const derniere = new Map();
  for (const { base: b, arbre: t } of paires) {
    const avant = derniere.get(b.suite);
    if (avant && b.index < avant.base.index) {
      erreur(`${libelle} : ordre changé : l'instruction de ${b.fichier}:${b.ligneDebut} (ici ${t.fichier}:${t.ligneDebut}) vient après celle de ${avant.base.fichier}:${avant.base.ligneDebut} (ici ${avant.arbre.fichier}:${avant.arbre.ligneDebut})`);
    }
    derniere.set(b.suite, { base: b, arbre: t });
  }
}
for (const [fichier, sequence] of sequences) {
  if (fichier === 'index.ts') {
    verifierOrdre('index.ts, appels d\'enregistrement développés', sequence.flatMap((s) => (s.appel ? (enregistrementsArbre.get(s.appel)?.sequence ?? []) : [s])));
  } else verifierOrdre(fichier, sequence);
}
for (const e of enregistrementsArbre.values()) verifierOrdre(`${e.fichier}, fonction ${e.nom}`, e.sequence ?? []);

// --- Chargement : chaque fichier qui reçoit du code est atteint depuis index.ts ---
const atteints = new Set();
(function atteindre(fichier) {
  if (atteints.has(fichier) || !analysesArbre.has(fichier)) return;
  atteints.add(fichier);
  for (const cible of analysesArbre.get(fichier).charges) atteindre(cible);
}('index.ts'));
for (const fichier of recoivent) {
  if (!atteints.has(fichier)) erreur(`${fichier} : reçoit du code de la base mais n'est chargé par aucun import depuis index.ts ; ce code ne s'exécuterait plus`);
}
for (const fichier of [...analysesBase.keys()].filter((f) => analysesArbre.has(f) && f !== 'index.ts')) {
  if (!atteints.has(fichier)) erreur(`${fichier} : n'est plus chargé depuis index.ts`);
}
// Cycles d'imports (composantes fortement connexes, algorithme de Tarjan).
{
  let compteur = 0;
  const rang = new Map();
  const bas = new Map();
  const pile = [];
  const surPile = new Set();
  const visiter = (fichier) => {
    rang.set(fichier, compteur);
    bas.set(fichier, compteur++);
    pile.push(fichier);
    surPile.add(fichier);
    for (const cible of analysesArbre.get(fichier).charges) {
      if (!analysesArbre.has(cible)) continue;
      if (!rang.has(cible)) {
        visiter(cible);
        bas.set(fichier, Math.min(bas.get(fichier), bas.get(cible)));
      } else if (surPile.has(cible)) bas.set(fichier, Math.min(bas.get(fichier), rang.get(cible)));
    }
    if (bas.get(fichier) !== rang.get(fichier)) return;
    const composante = [];
    let membre;
    do {
      membre = pile.pop();
      surPile.delete(membre);
      composante.push(membre);
    } while (membre !== fichier);
    const boucle = composante.length === 1 && analysesArbre.get(fichier).charges.includes(fichier);
    if (composante.length > 1 || boucle) erreur(`cycle d'imports : ${composante.reverse().join(' <-> ')} ; un module du cycle s'évaluerait avant que l'autre ait défini ce qu'il lui emprunte`);
  };
  for (const fichier of analysesArbre.keys()) if (!rang.has(fichier)) visiter(fichier);
}

// --- Fichiers hors TypeScript ---
const autres = [...new Set([
  ...git('diff', '--name-only', '--relative', base, '--', '.').split('\n'),
  ...git('ls-files', '--others', '--exclude-standard', '--', '.').split('\n'),
])].filter((f) => f && !f.endsWith('.ts'));
for (const f of autres.filter((f) => FIGES.includes(f))) erreur(`${f} : modifié ; une PR du découpage ne change ni les dépendances ni la compilation`);
if (!outilsAdmis) for (const f of autres.filter((f) => OUTILS.includes(f))) erreur(`${f} : modifié ; une PR du découpage n'adapte pas ses outils de preuve (--outils-admis pour une PR d'outils)`);
const autresModifies = autres.filter((f) => !FIGES.includes(f) && !(outilsAdmis ? [] : OUTILS).includes(f));

// --- Rapport ---
console.log(`Base : ${base}`);
const rapporter = (titre, paires, propre) => {
  const blocs = [];
  for (const { base: b, arbre: t } of paires) {
    const dernier = blocs.at(-1);
    if (dernier && dernier.suite === b.suite && dernier.fin.index + 1 === b.index) Object.assign(dernier, { fin: b, finArbre: t, n: dernier.n + 1 });
    else blocs.push({ suite: b.suite, debut: b, fin: b, debutArbre: t, finArbre: t, n: 1 });
  }
  const conserve = (bloc) => bloc.debut.fichier === propre.fichier && bloc.debut.conteneur === propre.conteneur;
  if (blocs.length <= 1 && blocs.every(conserve)) return;
  console.log(`\n${titre}`);
  for (const bloc of blocs) {
    const origine = conserve(bloc) ? 'conservé' : `${bloc.debut.fichier}:${bloc.debut.ligneDebut}-${bloc.fin.ligneFin}`;
    console.log(`  lignes ${bloc.debutArbre.ligneDebut}-${bloc.finArbre.ligneFin} : ${origine} (${bloc.n} instruction${bloc.n > 1 ? 's' : ''})`);
  }
};
for (const [fichier, sequence] of sequences) {
  rapporter(fichier, sequence.filter((s) => s.base), { fichier, conteneur: null });
  for (const e of analysesArbre.get(fichier).enregistrements.values()) rapporter(`${fichier}, fonction ${e.nom}`, e.sequence ?? [], { fichier, conteneur: e.nom });
}
const section = (titre, liste) => {
  console.log(`\n${titre} (${liste.length}) :`);
  for (const ligne of liste) console.log(`  ${ligne}`);
};
section('Instructions nouvelles admises', nouvelles);
section('Commentaires ajoutés', commentairesAjoutes);
section('Imports retirés', importsRetires);
section('Autres fichiers modifiés, à relire', autresModifies);
section('Instructions exécutées au chargement d\'un autre module que le leur, à relire', auChargement);
if (erreurs.length) {
  section('Écarts', erreurs);
  console.error('\nÉchec : ce lot ne se limite pas à un déplacement.');
  process.exit(1);
}
console.log(`\nDéplacement vérifié : ${instructionsBase.length} instructions de la base retrouvées, à l'identique et dans l'ordre.`);
