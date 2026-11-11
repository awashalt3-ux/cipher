/**
 * Point d'entrée explicite pour les plateformes (Wasmer Edge, PaaS) qui
 * attendent un fichier de démarrage dédié.
 */
import { start } from "./index.js";

start().catch((error) => {
  console.error("[démarrage] échec:", error);
  process.exit(1);
});
