// Tells whether the viewer is on mobile data, so P2P doesn't upload pieces at their expense.
// Inside the APK the WebView reports navigator.connection.type as "unknown", so the native
// @capacitor/network plugin is asked instead; on the website the browser's own API is used.

const nativeNetwork = () => window.Capacitor?.Plugins?.Network;

export async function isCellular() {
  const net = nativeNetwork();
  if (net) {
    try {
      return (await net.getStatus()).connectionType === "cellular";
    } catch {
      return true; // unknown inside the app: assume mobile data, the cautious choice
    }
  }
  return navigator.connection?.type === "cellular" || Boolean(navigator.connection?.saveData);
}

// Calls back with true/false whenever the connection switches between Wi-Fi and mobile data.
export function onCellularChange(callback) {
  const net = nativeNetwork();
  if (net) {
    const handle = net.addListener("networkStatusChange", (s) => callback(s.connectionType === "cellular"));
    return () => Promise.resolve(handle).then((h) => h?.remove?.());
  }
  const conn = navigator.connection;
  const listener = () => callback(conn.type === "cellular" || Boolean(conn.saveData));
  conn?.addEventListener?.("change", listener);
  return () => conn?.removeEventListener?.("change", listener);
}
