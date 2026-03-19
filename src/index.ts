import { app } from "./app";
import { startAutoGrabberWorker } from "./lib/auto-grabber";
import { startAutomationWorker } from "./lib/automation";
import { env } from "./lib/config";

app.listen(env.PORT, () => {
  console.log(`${env.SITE_NAME} listening on port ${env.PORT}`);
});

startAutomationWorker();
startAutoGrabberWorker();
