import { launchPi } from "./src/remote-mac.ts";
import { forYouFolder, forYouSession } from "./src/proactive-store.ts";
await launchPi(forYouFolder(), "relay", { sessionId: forYouSession.id, name: forYouSession.name, model: forYouSession.model, focus: true });
