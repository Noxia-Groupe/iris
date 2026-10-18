import './env';
import { PrismaClient, Prisma } from '@prisma/client';

export const prisma = new PrismaClient();

// Prisma 5 résout une transaction interactive même quand son COMMIT échoue sur un trigger
// différé (équilibre des écritures, journaux comptables, règlements) : l'appel réussirait sans
// rien avoir enregistré (constaté sur PostgreSQL 16 avec Prisma 5.22). Toute transaction
// interactive de l'application passe donc par cette fonction : les contraintes différées sont
// vérifiées avant la fin du rappel, et une violation fait échouer la transaction au grand jour.
type OptionsTransaction = { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel };
export function transactionVerifiee<T>(rappel: (tx: Prisma.TransactionClient) => Promise<T>, options?: OptionsTransaction): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const resultat = await rappel(tx);
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return resultat;
  }, options);
}
