/**
 * A helper function that returns a unique alphanumeric identifier called a nonce.
 *
 * @remarks This function is primarily used to help enforce content security
 * policies for resources/scripts being executed in a webview context.
 *
 * @returns A nonce
 */
import { randomBytes } from "crypto";

export function getNonce() {
  return randomBytes(32).toString("base64");
}