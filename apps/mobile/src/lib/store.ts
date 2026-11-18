import { Platform } from "react-native";
import { saysWhereToPay, signUpInApp, webPathOpens } from "./store-rules";

/** `store-rules.ts` on this phone. */
export const paysHere = (mayPay: boolean) => saysWhereToPay(mayPay, Platform.OS);
export const signUpHere = (cloud: boolean | undefined) => signUpInApp(Platform.OS, cloud);
export const webPathOpensHere = (path: string) => webPathOpens(path, Platform.OS);
