import type { Hosting } from "@agenteschat/ui/sky/team";

/**
 * "Onde fica o seu workspace?" on the phone, the pure part: what the sheet's one button does with the option chosen,
 * on the server the phone is on now. The Cloud there already: nothing to change. One's own server: its address
 * screen (which also scans the QR code a team's computer shows).
 */
export const whereAction = (pick: Hosting, onCloud: boolean): "close" | "cloud" | "address" =>
  pick === "own" ? "address" : onCloud ? "close" : "cloud";
