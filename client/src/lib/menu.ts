// Menu principal, regroupé par thème. Fonction pure : elle reçoit le compte et l'état des
// modules, et rend les seules entrées visibles. Les règles sont celles de l'ancien menu à
// plat, cohérentes avec les routes (App.tsx) ; le serveur refuse de toute façon ce que le
// menu n'affiche pas. Comme avant, un compte sans rôle connu est traité en conducteur
// (User.role est obligatoire en base : seul un stockage local altéré y conduit).
import type { LucideIcon } from 'lucide-react';
import {
  Activity, Award, BookOpen, Briefcase, Building2, CalendarDays, CheckCircle2, Clock, FileText, FolderOpen,
  HandCoins, KeyRound, Landmark, LayoutDashboard, PieChart, Receipt, Repeat, ScrollText, Settings, ShoppingCart, TrendingUp, Wrench,
} from 'lucide-react';
import {
  estExcluDesOperations, isAdminRole, isSuperAdminRole, peutAccederAuxDevis, peutConsulterAnnuaire, peutOuvrirAdministration, peutVoirStatistiques,
  ROLE_COMMERCIAL, ROLE_CONDUCTEUR, ROLE_RESPONSABLE, ROLE_TECHNICIEN, type CurrentUser,
} from './droits';

export interface EntreeMenu {
  to: string;
  libelle: string;
  icone: LucideIcon;
  /** Actif uniquement sur ce chemin exact (sinon aussi sur ses sous-pages). */
  exact?: boolean;
}

export interface SectionMenu {
  /** Absent pour la première section (accueil). */
  titre?: string;
  entrees: EntreeMenu[];
}

export function sectionsMenu(user: CurrentUser | null | undefined, planningActif: boolean): SectionMenu[] {
  const role = user?.role || ROLE_CONDUCTEUR;
  const isCommercial = role === ROLE_COMMERCIAL;
  const horsOperations = estExcluDesOperations(role);
  const isAdmin = isAdminRole(role);
  const peutVoirInterventions = isAdmin || role === ROLE_CONDUCTEUR || role === ROLE_RESPONSABLE || role === ROLE_TECHNICIEN;
  const peutVoirTravaux = isAdmin || role === ROLE_CONDUCTEUR || role === ROLE_RESPONSABLE;

  const sections: { titre?: string; entrees: (EntreeMenu & { visible: boolean })[] }[] = [
    { entrees: [
      { to: '/', libelle: 'Tableau de bord', icone: LayoutDashboard, exact: true, visible: true },
    ] },
    { titre: 'Chantiers', entrees: [
      { to: '/chantiers', libelle: 'Liste des chantiers', icone: FolderOpen, exact: true, visible: true },
      { to: '/devis', libelle: 'Devis', icone: FileText, visible: peutAccederAuxDevis(user) },
      // Planning : masqué pour tous (administrateurs compris) quand un superadmin a
      // désactivé le module ; jamais proposé aux commerciaux ni aux directeurs.
      { to: '/planning', libelle: 'Planning', icone: CalendarDays, visible: !horsOperations && planningActif },
      { to: '/achats', libelle: 'Journal des achats', icone: ShoppingCart, visible: peutVoirTravaux },
      { to: '/heures', libelle: 'Journal des heures', icone: Clock, visible: peutVoirTravaux },
    ] },
    { titre: 'Interventions', entrees: [
      { to: '/interventions', libelle: 'Interventions SAV', icone: Wrench, visible: peutVoirInterventions },
      { to: '/contrats-maintenance', libelle: 'Contrats de maintenance', icone: Repeat, visible: isAdmin },
    ] },
    { titre: 'Facturation', entrees: [
      { to: '/prete-a-facturer', libelle: 'Prêt à facturer', icone: CheckCircle2, visible: isAdmin },
      { to: '/factures', libelle: 'Factures', icone: Receipt, visible: isAdmin },
      { to: '/reglements', libelle: 'Règlements', icone: HandCoins, visible: isAdmin },
      { to: '/mentions-legales', libelle: 'Mentions & CGV', icone: ScrollText, visible: isAdmin },
      { to: '/comptabilite', libelle: 'Plan comptable', icone: Landmark, visible: isAdmin },
    ] },
    { titre: 'Pilotage', entrees: [
      { to: '/statistiques', libelle: 'Statistiques', icone: PieChart, visible: peutVoirStatistiques(user) },
      { to: '/resultat-commercial', libelle: 'Résultat commercial', icone: TrendingUp, visible: isCommercial },
      { to: '/performances', libelle: 'Performances', icone: Activity, visible: isAdmin },
      { to: '/commerciaux', libelle: 'Mes commerciaux', icone: Award, visible: isAdmin },
    ] },
    { titre: 'Référentiels', entrees: [
      { to: '/clients', libelle: 'Clients', icone: Building2, visible: peutConsulterAnnuaire(user) },
      { to: '/catalogue', libelle: 'Catalogue', icone: BookOpen, visible: isAdmin },
    ] },
    { titre: 'Réglages', entrees: [
      // Administration : complète pour les administrateurs, réduite aux référentiels
      // Fournisseurs et Catégories pour les conducteurs de travaux (cf. Admin.tsx) ; ni
      // commercial ni directeur, qui ne paramètrent rien, ni technicien (lot pilote 3).
      { to: '/admin', libelle: 'Administration', icone: Settings, visible: peutOuvrirAdministration(role) },
      { to: '/societe', libelle: 'Société', icone: Briefcase, visible: isAdmin },
      { to: '/administration/api', libelle: 'API d’intégration', icone: KeyRound, visible: isSuperAdminRole(role) },
    ] },
  ];

  return sections
    .map(({ titre, entrees }) => ({
      ...(titre ? { titre } : {}),
      entrees: entrees.filter((e) => e.visible).map(({ visible: _visible, ...entree }) => entree),
    }))
    .filter((section) => section.entrees.length > 0);
}
