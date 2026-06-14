// Thin entry. Loads core for its side effects (marked/DOMPurify init,
// the document Escape listener) then boots the app.
import "./js/core.js";
import { state } from "./js/core.js";
import { renderAuth } from "./js/auth.js";
import { boot } from "./js/lifecycle.js";


boot().catch((error) => {
  state.authError = error.message;
  renderAuth("login");
});
