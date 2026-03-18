import { app } from "./app";
import { startAutomationWorker } from "./lib/automation";
import { env } from "./lib/config";

app.listen(env.PORT, () => {
  console.log(`${env.SITE_NAME} listening on port ${env.PORT}`);
});

startAutomationWorker();
