import express from 'express';

// Express 5 type les valeurs de req.params comme `string | string[]`. Nos routes
// n'utilisent que des paramètres simples (:id) : on en extrait toujours une string.
export function paramId(req: express.Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}
