import './env';
import express from 'express';

// L'application Express. Elle est créée dans ce module, après le chargement de server/.env
// (express() lit NODE_ENV), pour que les modules partagés qui y montent des routes, comme
// routeMixte, l'importent sans devenir des fabriques.
export const app = express();
