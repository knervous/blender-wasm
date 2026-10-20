/* Embedding protocol: a host page runs this demo in a same-origin iframe as an
 * isolated editing surface, hands it a .blend to open, and asks for the edited
 * file back.
 *
 *   <iframe src="/blender/?embed=1&session=/api/scene.blend&id=chair-01">
 *
 * Query parameters
 *   embed=1         hide the public launcher chrome and talk to window.parent
 *   session=<url>   a .blend fetched before boot and opened as the scene
 *   id=<string>     opaque label echoed back on every message
 *
 * Child -> parent (postMessage, same origin only)
 *   { type: "blender-embed-progress", id, phase, percent, message }
 *   { type: "blender-embed-ready", id }                 first real frame drawn
 *   { type: "blender-embed-snapshot", id, session }     ArrayBuffer of the .blend (transferred)
 *   { type: "blender-embed-error", id, message }
 *
 * Parent -> child
 *   { type: "blender-embed-save" }   save the scene and reply with a snapshot
 */
const params = new URLSearchParams(window.location.search);

export const embed = {
  enabled: params.get("embed") === "1",
  sessionUrl: params.get("session"),
  id: params.get("id"),
  /** Where the staged session .blend lives in the module FS. */
  sessionPath: "/tmp/embed-session.blend",
};

document.documentElement.dataset.embed = String(embed.enabled);

const hasParent = () => window.parent !== window;

/** Posts `{ type: "blender-embed-<kind>", id, ...fields }` to the parent. */
export function postToParent(kind, fields = {}, transfer = []) {
  if (!hasParent()) return;
  if (kind === "progress" && !embed.enabled) return;
  window.parent.postMessage({ type: `blender-embed-${kind}`, id: embed.id, ...fields }, window.location.origin, transfer);
}

/** Calls `handler()` whenever the parent asks for a save. */
export function onSaveRequest(handler) {
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    if (event.data?.type !== "blender-embed-save") return;
    void Promise.resolve().then(handler).catch((reason) => {
      postToParent("error", { message: reason instanceof Error ? reason.message : String(reason) });
    });
  });
}
