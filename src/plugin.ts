import streamDeck from "@elgato/streamdeck";

import { SessionAction } from "./session-action.js";

streamDeck.actions.registerAction(new SessionAction());
await streamDeck.connect();
