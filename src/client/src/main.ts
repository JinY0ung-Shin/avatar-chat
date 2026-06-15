import "./styles.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { initNotifications } from "./lib/notifications";

const target = document.getElementById("app");
if (!target) {
  throw new Error("#app not found");
}

mount(App, { target });

// Register the minimal service worker that backs OS notifications (answer-complete
// and input-needed). Permission itself is requested later, on a user gesture.
initNotifications();
