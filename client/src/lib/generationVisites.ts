// Libellés de la génération automatique des visites (lot pilote 5).
export const pluriel = (nombre: number, singulier: string, plurielTexte: string) => `${nombre} ${nombre > 1 ? plurielTexte : singulier}`;

export const bilanGeneration = (execution: { visitesCreees: number; echeancesAvancees: number }) =>
  `${pluriel(execution.visitesCreees, 'visite créée', 'visites créées')}, ${pluriel(execution.echeancesAvancees, 'échéance avancée', 'échéances avancées')}`;
